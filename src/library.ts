import { currentUser } from "./auth";
import { SHARE_ID, apiError, apiJson, guardMutation, guardedRoute, readJsonObject, tooManyRequests } from "./http";
import { createShare } from "./share";

const MAX_SAVED_BRIEFS = 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ITEM_COLUMNS = "id, video_id, title, uploader, duration, saved_at, read_at";

interface ItemRow {
  id: string;
  video_id: string;
  title: string;
  uploader: string | null;
  duration: number;
  saved_at: number;
  read_at: number | null;
}

interface BriefRow extends ItemRow {
  summary: string;
  transcript_truncated: number;
}

const toItem = (row: ItemRow) => ({
  id: row.id,
  videoId: row.video_id,
  title: row.title,
  uploader: row.uploader,
  duration: row.duration,
  savedAt: row.saved_at,
  readAt: row.read_at,
});

async function saveBrief(env: Env, userId: string, shareId: unknown): Promise<Response> {
  if (typeof shareId !== "string" || !SHARE_ID.test(shareId)) return apiError(400, "Invalid brief link.");
  // Copy the server-held snapshot so clients cannot store forged brief content.
  const record = await env.SHARED_BRIEFS.getByName(shareId).read();
  if (!record) return apiError(404, "This brief is no longer available to save. Summarize the video again.");
  const { result } = record;
  const id = crypto.randomUUID();
  // The cap lives in the INSERT so concurrent saves cannot overshoot it, and the
  // UNIQUE(user_id, video_id) conflict makes repeat saves idempotent.
  const inserted = await env.DB.prepare(
    `INSERT INTO saved_briefs(id, user_id, video_id, title, uploader, duration, summary, transcript_truncated, saved_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM saved_briefs WHERE user_id = ?) < ?
     ON CONFLICT(user_id, video_id) DO NOTHING`,
  ).bind(
    id, userId, result.id, result.title, result.uploader ?? null, Math.round(result.duration), result.summary,
    result.transcriptTruncated ? 1 : 0, Date.now(), userId, MAX_SAVED_BRIEFS,
  ).run();
  const row = await env.DB.prepare(`SELECT ${ITEM_COLUMNS} FROM saved_briefs WHERE user_id = ? AND video_id = ?`)
    .bind(userId, result.id).first<ItemRow>();
  if (!row) return apiError(422, `Your library is full (${MAX_SAVED_BRIEFS.toLocaleString("en-US")} briefs). Delete some to save more.`);
  return inserted.meta.changes > 0
    ? apiJson({ item: toItem(row) }, { status: 201 })
    : apiJson({ item: toItem(row), alreadySaved: true });
}

async function listBriefs(env: Env, userId: string, filter: string | null): Promise<Response> {
  if (filter !== null && filter !== "unread" && filter !== "all") return apiError(400, "Filter must be unread or all.");
  const { results } = await env.DB.prepare(
    `SELECT ${ITEM_COLUMNS} FROM saved_briefs WHERE user_id = ?${filter === "unread" ? " AND read_at IS NULL" : ""} ORDER BY saved_at DESC, id LIMIT ?`,
  ).bind(userId, MAX_SAVED_BRIEFS).all<ItemRow>();
  const counts = await env.DB.prepare(
    "SELECT COUNT(*) AS total, COALESCE(SUM(read_at IS NULL), 0) AS unread FROM saved_briefs WHERE user_id = ?",
  ).bind(userId).first<{ total: number; unread: number }>();
  return apiJson({ items: results.map(toItem), counts: { unread: counts?.unread ?? 0, all: counts?.total ?? 0 } });
}

// Saved briefs outlive their original share link, so sharing mints a new 24-hour
// snapshot from the saved copy. A Durable Object failure throws into guardedRoute (503).
async function shareBrief(env: Env, userId: string, id: string): Promise<Response> {
  const row = await env.DB.prepare(`SELECT ${ITEM_COLUMNS}, summary, transcript_truncated FROM saved_briefs WHERE id = ? AND user_id = ?`)
    .bind(id, userId).first<BriefRow>();
  if (!row) return apiError(404, "Brief not found.");
  const share = await createShare(env, {
    id: row.video_id, title: row.title, uploader: row.uploader ?? undefined, duration: row.duration,
    summary: row.summary, transcriptTruncated: row.transcript_truncated === 1,
  });
  return apiJson({ share });
}

async function itemRoute(request: Request, env: Env, userId: string, path: string): Promise<Response> {
  // Every query is scoped to the session's user: other users' ids look absent.
  const notFound = () => apiError(404, "Brief not found.");
  const [id, action, ...extra] = path.split("/");
  if (!UUID.test(id) || extra.length > 0 || (action !== undefined && action !== "share")) return notFound();
  if (action === "share") {
    return request.method === "POST" ? shareBrief(env, userId, id) : apiError(405, "Method not allowed", { allow: "POST" });
  }

  if (request.method === "GET") {
    const row = await env.DB.prepare(`SELECT ${ITEM_COLUMNS}, summary, transcript_truncated FROM saved_briefs WHERE id = ? AND user_id = ?`)
      .bind(id, userId).first<BriefRow>();
    return row
      ? apiJson({ item: { ...toItem(row), summary: row.summary, transcriptTruncated: row.transcript_truncated === 1 } })
      : notFound();
  }
  if (request.method === "PATCH") {
    const body = await readJsonObject(request);
    if (typeof body.read !== "boolean") return apiError(400, "read must be true or false.");
    const row = await env.DB.prepare(
      // Re-marking a read item keeps its original read time.
      `UPDATE saved_briefs SET read_at = CASE WHEN ? THEN COALESCE(read_at, ?) END WHERE id = ? AND user_id = ? RETURNING ${ITEM_COLUMNS}`,
    ).bind(body.read ? 1 : 0, Date.now(), id, userId).first<ItemRow>();
    return row ? apiJson({ item: toItem(row) }) : notFound();
  }
  if (request.method === "DELETE") {
    const result = await env.DB.prepare("DELETE FROM saved_briefs WHERE id = ? AND user_id = ?").bind(id, userId).run();
    return result.meta.changes > 0 ? new Response(null, { status: 204, headers: { "cache-control": "no-store" } }) : notFound();
  }
  return apiError(405, "Method not allowed", { allow: "GET, PATCH, DELETE" });
}

export async function handleLibrary(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  return guardedRoute("library_failed", async () => {
    const blocked = guardMutation(request);
    if (blocked) return blocked;
    const user = await currentUser(request, env);
    if (!user) return apiError(401, "Sign in to use your library.");
    if (!(await env.LIBRARY_RATE_LIMIT.limit({ key: `ytdw:library:${user.id}` })).success) {
      return tooManyRequests("Too many library requests. Please wait a minute and try again.");
    }

    if (url.pathname === "/api/library") {
      if (request.method === "GET") return listBriefs(env, user.id, url.searchParams.get("filter"));
      if (request.method === "POST") return saveBrief(env, user.id, (await readJsonObject(request)).shareId);
      return apiError(405, "Method not allowed", { allow: "GET, POST" });
    }
    return itemRoute(request, env, user.id, url.pathname.slice("/api/library/".length));
  });
}
