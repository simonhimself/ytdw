// Daily funnel counts (docs/OPERATIONS.md, read via /stats). Only aggregate
// counts per UTC day are stored: no user ids, IPs, or video ids.
import { currentUser } from "./auth";
import { apiError, guardMutation, readJsonObject } from "./http";

// The client may only report events the server cannot see itself.
const CLIENT_EVENTS = new Set(["share_view", "share_visit"]);
const STATS_ROWS = 400;

const today = () => new Date().toISOString().slice(0, 10);

async function countEvent(env: Env, event: string, n = 1): Promise<void> {
  if (n <= 0) return;
  await env.DB.prepare(
    "INSERT INTO daily_events(day, event, count) VALUES (?, ?, ?) ON CONFLICT(day, event) DO UPDATE SET count = count + excluded.count",
  ).bind(today(), event, n).run();
}

// Maps a finished API response to its funnel event. Runs after the response
// is sent, so counting never slows or fails a request.
async function funnelEvent(request: Request, response: Response, env: Env): Promise<void> {
  if (request.method !== "POST") return;
  const path = new URL(request.url).pathname;
  const { status } = response;
  if (path === "/api/summarize" && status === 200) {
    await countEvent(env, (await currentUser(request, env)) ? "brief_signed_in" : "brief_signed_out");
  } else if (path === "/api/auth/signup" && status === 201) {
    await countEvent(env, "signup");
  } else if (path === "/api/auth/verify" && status === 200) {
    await countEvent(env, "email_verified");
  } else if (path === "/api/library" && status === 201) {
    await countEvent(env, "brief_saved");
  } else if (path === "/api/queue" && status === 200) {
    const { results } = await response.json<{ results: { status: string }[] }>();
    await countEvent(env, "queue_paste");
    await countEvent(env, "queue_added", results.filter((result) => result.status === "queued").length);
  } else if (path === "/api/account/delete" && status === 204) {
    await countEvent(env, "account_deleted");
  }
}

export function recordFunnel(request: Request, response: Response, env: Env, ctx: ExecutionContext): void {
  if (request.method !== "POST" || response.status >= 300) return;
  const copy = response.clone();
  ctx.waitUntil(funnelEvent(request, copy, env).catch((error) => {
    console.warn(JSON.stringify({ event: "funnel_count_failed", message: error instanceof Error ? error.message : String(error) }));
  }));
}

// POST /api/events {"event": "share_view"}: client-side events on share pages.
export async function handleEvents(request: Request, env: Env): Promise<Response> {
  const blocked = guardMutation(request);
  if (blocked) return blocked;
  if (request.method !== "POST") return apiError(405, "Method not allowed", { allow: "POST" });
  const clientKey = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await env.SHARE_READ_RATE_LIMIT.limit({ key: `ytdw:events:${clientKey}` })).success) {
    return new Response(null, { status: 204 });
  }
  const { event } = await readJsonObject(request);
  if (typeof event !== "string" || !CLIENT_EVENTS.has(event)) return apiError(400, "Unknown event.");
  await countEvent(env, event);
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

export async function funnelStats(env: Env): Promise<{ day: string; event: string; count: number }[]> {
  const { results } = await env.DB.prepare(`SELECT day, event, count FROM daily_events ORDER BY day DESC, event LIMIT ${STATS_ROWS}`)
    .all<{ day: string; event: string; count: number }>();
  return results;
}
