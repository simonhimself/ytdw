// Background summary queue (docs/ACCOUNTS.md, Phase 2): the /api/queue routes and
// the single QueueRunner that feeds queued videos through the Coordinator.
import { DurableObject } from "cloudflare:workers";
import { type SessionUser, currentUser } from "./auth";
import { apiError, apiJson, guardMutation, guardedRoute, readJsonObject, tooManyRequests } from "./http";
import type { SummaryFailure, SummaryOutcome } from "./index";
import { MAX_SAVED_BRIEFS, UUID } from "./library";
import { normalizeYouTubeUrl } from "./video-url";

const MAX_QUEUE_URLS = 10;
const DAILY_QUEUE_LIMIT = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
// Pause between background jobs so website visitors get the processor first.
const JOB_GAP_MS = 5_000;
// The Coordinator was busy with website work: try again soon, without an attempt.
const BUSY_RETRY_MS = 15_000;
const BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000];
const MAX_ATTEMPTS = 5;
// Unclassified processing failures are less likely to clear on their own.
const MAX_UNKNOWN_ATTEMPTS = 3;
// The Coordinator's processing deadline (6 minutes) plus a margin. A row still
// processing after this was orphaned by a runner restart.
const LEASE_MS = 8 * 60 * 1000;
const LIST_LIMIT = 200;
const ACTIVE = "('queued', 'processing', 'failed')";
// Waiting or running: pasting the video again cannot help. A failed one can be replaced.
const PENDING = "('queued', 'processing')";
const ITEM_COLUMNS = "id, video_id, status, error, retryable, attempts, created_at";

interface QueueRow {
  id: string;
  video_id: string;
  status: "queued" | "processing" | "failed";
  error: string | null;
  retryable: number;
  attempts: number;
  created_at: number;
}

type ResultStatus = "queued" | "duplicate" | "alreadyQueued" | "alreadySaved" | "invalid" | "libraryFull" | "overQuota";

interface QueueResult {
  url: string;
  videoId: string | null;
  status: ResultStatus;
  error?: string;
}

const toItem = (row: QueueRow) => ({
  id: row.id,
  videoId: row.video_id,
  status: row.status,
  error: row.error,
  retryable: row.retryable === 1,
  attempts: row.attempts,
  createdAt: row.created_at,
});

const runner = (env: Env) => env.QUEUE_RUNNER.get(env.QUEUE_RUNNER.idFromName("global"));

// A failed kick only delays work until the next kick; the request still succeeds.
async function kickRunner(env: Env): Promise<void> {
  try { await runner(env).kick(); }
  catch (error) { console.error(JSON.stringify({ event: "queue_kick_failed", message: error instanceof Error ? error.message : String(error) })); }
}

async function quota(env: Env, userId: string) {
  const used = (await env.DB.prepare("SELECT COUNT(*) AS used FROM queue_items WHERE user_id = ? AND created_at > ?")
    .bind(userId, Date.now() - DAY_MS).first<{ used: number }>())?.used ?? 0;
  return { used, limit: DAILY_QUEUE_LIMIT, remaining: Math.max(0, DAILY_QUEUE_LIMIT - used) };
}

async function listItems(env: Env, userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT ${ITEM_COLUMNS} FROM queue_items WHERE user_id = ? AND status IN ${ACTIVE} ORDER BY created_at, rowid LIMIT ?`,
  ).bind(userId, LIST_LIMIT).all<QueueRow>();
  return results.map(toItem);
}

async function listQueue(env: Env, userId: string): Promise<Response> {
  return apiJson({ items: await listItems(env, userId), quota: await quota(env, userId) });
}

async function enqueue(env: Env, user: SessionUser, urls: unknown): Promise<Response> {
  if (!user.emailVerified) return apiError(403, "Verify your email to queue videos.");
  if (!Array.isArray(urls) || urls.length < 1 || urls.length > MAX_QUEUE_URLS || !urls.every((url) => typeof url === "string")) {
    return apiError(400, `Paste between 1 and ${MAX_QUEUE_URLS} YouTube URLs.`);
  }
  const results: QueueResult[] = [];
  const candidates: { result: QueueResult; id: string; videoId: string }[] = [];
  const seen = new Set<string>();
  for (const raw of urls as string[]) {
    const url = raw.trim();
    let videoId: string;
    try {
      videoId = new URL(normalizeYouTubeUrl(url)).searchParams.get("v")!;
    } catch (error) {
      results.push({ url, videoId: null, status: "invalid", error: error instanceof Error ? error.message : "Enter a valid YouTube video URL" });
      continue;
    }
    const result: QueueResult = { url, videoId, status: seen.has(videoId) ? "duplicate" : "queued" };
    results.push(result);
    if (!seen.has(videoId)) candidates.push({ result, id: crypto.randomUUID(), videoId });
    seen.add(videoId);
  }

  if (candidates.length > 0) {
    const now = Date.now();
    // Each insert checks the library, the active queue, the library size, and the
    // rolling quota in the same statement, and the batch runs as one transaction, so
    // concurrent pastes cannot overshoot the quota or queue a video twice. A failed
    // row for the same video is replaced, under the same conditions, just before.
    const allowed = `NOT EXISTS (SELECT 1 FROM saved_briefs WHERE user_id = ?1 AND video_id = ?2)
         AND NOT EXISTS (SELECT 1 FROM queue_items WHERE user_id = ?1 AND video_id = ?2 AND status IN ${PENDING})
         AND (SELECT COUNT(*) FROM saved_briefs WHERE user_id = ?1) < ?3
         AND (SELECT COUNT(*) FROM queue_items WHERE user_id = ?1 AND created_at > ?4) < ?5`;
    const replace = env.DB.prepare(
      `UPDATE queue_items SET status = 'removed', updated_at = ?6
       WHERE user_id = ?1 AND video_id = ?2 AND status = 'failed' AND ${allowed}`,
    );
    const insert = env.DB.prepare(
      `INSERT OR IGNORE INTO queue_items(id, user_id, video_id, status, attempts, retryable, created_at, updated_at, next_attempt_at)
       SELECT ?7, ?1, ?2, 'queued', 0, 1, ?6, ?6, ?6
       WHERE ${allowed} AND NOT EXISTS (SELECT 1 FROM queue_items WHERE user_id = ?1 AND video_id = ?2 AND status = 'failed')`,
    );
    const inserted = await env.DB.batch(candidates.flatMap(({ id, videoId }) => {
      const args = [user.id, videoId, MAX_SAVED_BRIEFS, now - DAY_MS, DAILY_QUEUE_LIMIT, now] as const;
      return [replace.bind(...args), insert.bind(...args, id)];
    }));
    const rejected = candidates.filter((_, index) => inserted[2 * index + 1].meta.changes === 0);
    if (rejected.length > 0) {
      const ids = rejected.map(({ videoId }) => videoId);
      const marks = ids.map(() => "?").join(", ");
      const [saved, queued, library] = await env.DB.batch<{ video_id: string; n: number }>([
        env.DB.prepare(`SELECT video_id FROM saved_briefs WHERE user_id = ? AND video_id IN (${marks})`).bind(user.id, ...ids),
        env.DB.prepare(`SELECT video_id FROM queue_items WHERE user_id = ? AND status IN ${PENDING} AND video_id IN (${marks})`).bind(user.id, ...ids),
        env.DB.prepare("SELECT COUNT(*) AS n FROM saved_briefs WHERE user_id = ?").bind(user.id),
      ]);
      const savedIds = new Set(saved.results.map((row) => row.video_id));
      const queuedIds = new Set(queued.results.map((row) => row.video_id));
      const libraryFull = (library.results[0]?.n ?? 0) >= MAX_SAVED_BRIEFS;
      for (const { result, videoId } of rejected) {
        result.status = savedIds.has(videoId) ? "alreadySaved" : queuedIds.has(videoId) ? "alreadyQueued" : libraryFull ? "libraryFull" : "overQuota";
      }
    }
    if (rejected.length < candidates.length) await kickRunner(env);
  }
  return apiJson({ results, items: await listItems(env, user.id), quota: await quota(env, user.id) });
}

async function itemRoute(request: Request, env: Env, userId: string, path: string): Promise<Response> {
  // Every query is scoped to the session's user: other users' ids look absent.
  const notFound = () => apiError(404, "Queue item not found.");
  const [id, action, ...extra] = path.split("/");
  if (!UUID.test(id) || extra.length > 0 || (action !== undefined && action !== "retry")) return notFound();
  const now = Date.now();

  if (action === "retry") {
    if (request.method !== "POST") return apiError(405, "Method not allowed", { allow: "POST" });
    const row = await env.DB.prepare(
      `UPDATE queue_items SET status = 'queued', attempts = 0, error = NULL, next_attempt_at = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND status = 'failed' AND retryable = 1 RETURNING ${ITEM_COLUMNS}`,
    ).bind(now, now, id, userId).first<QueueRow>();
    if (row) {
      await kickRunner(env);
      return apiJson({ item: toItem(row) });
    }
    const exists = await env.DB.prepare(`SELECT 1 FROM queue_items WHERE id = ? AND user_id = ? AND status IN ${ACTIVE}`).bind(id, userId).first();
    return exists ? apiError(409, "Only failed videos that may succeed later can be retried.") : notFound();
  }
  if (request.method === "DELETE") {
    // Removing a processing item discards its result when it finishes.
    const result = await env.DB.prepare(`UPDATE queue_items SET status = 'removed', updated_at = ? WHERE id = ? AND user_id = ? AND status IN ${ACTIVE}`)
      .bind(now, id, userId).run();
    return result.meta.changes > 0 ? new Response(null, { status: 204, headers: { "cache-control": "no-store" } }) : notFound();
  }
  return apiError(405, "Method not allowed", { allow: "DELETE" });
}

export async function handleQueue(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  return guardedRoute("queue_failed", async () => {
    const blocked = guardMutation(request);
    if (blocked) return blocked;
    const user = await currentUser(request, env);
    if (!user) return apiError(401, "Sign in to use your queue.");
    // Queue and library calls share one per-user budget.
    if (!(await env.LIBRARY_RATE_LIMIT.limit({ key: `ytdw:library:${user.id}` })).success) {
      return tooManyRequests("Too many requests. Please wait a minute and try again.");
    }

    if (url.pathname === "/api/queue") {
      if (request.method === "GET") return listQueue(env, user.id);
      if (request.method === "POST") return enqueue(env, user, (await readJsonObject(request)).urls);
      return apiError(405, "Method not allowed", { allow: "GET, POST" });
    }
    return itemRoute(request, env, user.id, url.pathname.slice("/api/queue/".length));
  });
}

interface DueRow {
  id: string;
  user_id: string;
  video_id: string;
  attempts: number;
}

// One global runner processes one queued video at a time through the Coordinator's
// background entry point. D1 holds all queue state; this object only owns the alarm.
export class QueueRunner extends DurableObject<Env> {
  async kick(): Promise<void> {
    const scheduled = await this.ctx.storage.getAlarm();
    if (scheduled === null || scheduled > Date.now()) await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm(): Promise<void> {
    const db = this.env.DB;
    const now = Date.now();
    // Finished rows only matter for the rolling quota.
    await db.prepare("DELETE FROM queue_items WHERE status IN ('done', 'removed') AND created_at <= ?").bind(now - DAY_MS).run();
    const { results: orphaned } = await db.prepare("SELECT id, user_id, video_id, attempts FROM queue_items WHERE status = 'processing' AND started_at <= ?")
      .bind(now - LEASE_MS).all<DueRow>();
    for (const row of orphaned) {
      await this.retryLater(row, { ok: false, status: 504, error: "The video took too long to process. Please try again in a moment." });
    }

    // Least recently served user first, then that user's oldest item. Items from one
    // paste share created_at; rowid keeps them in the order they were pasted.
    const due = await db.prepare(
      `SELECT id, user_id, video_id, attempts FROM queue_items AS q WHERE status = 'queued' AND next_attempt_at <= ?
       ORDER BY (SELECT COALESCE(MAX(started_at), 0) FROM queue_items WHERE user_id = q.user_id), created_at, rowid LIMIT 1`,
    ).bind(now).first<DueRow>();
    let notBefore = 0;
    if (due) {
      const claimed = await db.prepare("UPDATE queue_items SET status = 'processing', started_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'")
        .bind(now, now, due.id).run();
      if (claimed.meta.changes > 0) {
        // If this handler dies mid-job (a deploy restarts the object), the lease alarm
        // still wakes the runner to requeue the orphaned row.
        await this.ctx.storage.setAlarm(now + LEASE_MS);
        notBefore = Date.now() + (await this.process(due) ? JOB_GAP_MS : BUSY_RETRY_MS);
      }
    }
    // Wake for the next due item, or for the lease of a row another run left processing.
    const next = (await db.prepare(
      `SELECT MIN(at) AS next FROM (
         SELECT MIN(next_attempt_at) AS at FROM queue_items WHERE status = 'queued'
         UNION ALL SELECT MIN(started_at) + ? FROM queue_items WHERE status = 'processing')`,
    ).bind(LEASE_MS).first<{ next: number | null }>())?.next;
    if (next !== null && next !== undefined) await this.ctx.storage.setAlarm(Math.max(next, notBefore));
    else await this.ctx.storage.deleteAlarm();
  }

  // Returns false when the Coordinator was busy and nothing was attempted.
  private async process(item: DueRow): Promise<boolean> {
    let outcome: SummaryOutcome;
    try {
      const coordinator = this.env.COORDINATOR.get(this.env.COORDINATOR.idFromName("global"));
      outcome = await coordinator.summarizeBackground(`https://www.youtube.com/watch?v=${item.video_id}`);
    } catch (error) {
      console.error(JSON.stringify({ event: "queue_coordinator_failed", videoId: item.video_id, message: error instanceof Error ? error.message : String(error) }));
      outcome = { ok: false, status: 502, error: "The video could not be processed. Please try again in a moment." };
    }
    const db = this.env.DB;
    const now = Date.now();
    if (outcome.ok) {
      const { result } = outcome;
      // Both statements only act while the item is still processing, so a Remove
      // during processing discards the result. Already saved counts as done.
      await db.batch([
        db.prepare(
          `INSERT INTO saved_briefs(id, user_id, video_id, title, uploader, duration, summary, transcript_truncated, saved_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM queue_items WHERE id = ? AND status = 'processing')
             AND (SELECT COUNT(*) FROM saved_briefs WHERE user_id = ?) < ?
           ON CONFLICT(user_id, video_id) DO NOTHING`,
        ).bind(
          crypto.randomUUID(), item.user_id, result.id, result.title, result.uploader ?? null, Math.round(result.duration), result.summary,
          result.transcriptTruncated ? 1 : 0, now, item.id, item.user_id, MAX_SAVED_BRIEFS,
        ),
        db.prepare(
          `UPDATE queue_items SET updated_at = ?,
             status = CASE WHEN EXISTS (SELECT 1 FROM saved_briefs WHERE user_id = ? AND video_id = ?) THEN 'done' ELSE 'failed' END,
             error = CASE WHEN EXISTS (SELECT 1 FROM saved_briefs WHERE user_id = ? AND video_id = ?) THEN NULL ELSE ? END,
             retryable = 0
           WHERE id = ? AND status = 'processing'`,
        ).bind(
          now, item.user_id, item.video_id, item.user_id, item.video_id,
          `Your library is full (${MAX_SAVED_BRIEFS.toLocaleString("en-US")} briefs). Delete some, then add this video again.`, item.id,
        ),
      ]);
      return true;
    }
    if (outcome.busy) {
      await db.prepare("UPDATE queue_items SET status = 'queued', next_attempt_at = ?, updated_at = ? WHERE id = ? AND status = 'processing'")
        .bind(now + BUSY_RETRY_MS, now, item.id).run();
      return false;
    }
    if (outcome.status === 400) {
      // No English captions, empty captions, or longer than six hours: retrying cannot help.
      await db.prepare("UPDATE queue_items SET status = 'failed', error = ?, retryable = 0, attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'processing'")
        .bind(outcome.error, now, item.id).run();
      return true;
    }
    await this.retryLater(item, outcome);
    return true;
  }

  private async retryLater(item: DueRow, failure: SummaryFailure): Promise<void> {
    const attempts = item.attempts + 1;
    const limit = failure.status === 503 || failure.status === 504 ? MAX_ATTEMPTS : MAX_UNKNOWN_ATTEMPTS;
    const now = Date.now();
    const delay = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1];
    await this.env.DB.prepare(
      `UPDATE queue_items SET attempts = ?, error = ?, retryable = 1, updated_at = ?, next_attempt_at = ?,
         status = CASE WHEN ? THEN 'failed' ELSE 'queued' END
       WHERE id = ? AND status = 'processing'`,
    ).bind(attempts, failure.error, now, now + delay, attempts >= limit ? 1 : 0, item.id).run();
  }
}
