import type { SummaryResult } from "./index";

// Stores a new 24-hour SharedBrief snapshot under a fresh random id. Throws when
// the Durable Object is unavailable; callers decide whether that is fatal.
export async function createShare(env: Env, result: SummaryResult): Promise<{ url: string; expiresAt: number }> {
  const id = crypto.randomUUID();
  const expiresAt = await env.SHARED_BRIEFS.getByName(id).create(result);
  return { url: `/s/${id}`, expiresAt };
}
