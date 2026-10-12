// Request helpers shared by the summarize, auth, and library routes.
import { isPreviewHost } from "./hosts";

export const MAX_REQUEST_BYTES = 8_192;
export const NO_STORE = { "cache-control": "no-store" };
export const SHARE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class BadRequestError extends Error {}

interface TurnstileResult {
  success: boolean;
  action?: string;
  hostname?: string;
}

export async function readJsonBody(request: Request): Promise<unknown> {
  if (!request.body) throw new BadRequestError("Request body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new BadRequestError("Request body is too large");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new BadRequestError("Request body must be valid JSON");
  }
}

export function apiError(status: number, error: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error }, { status, headers: { ...NO_STORE, ...headers } });
}

export function apiJson(body: unknown, init: { status?: number; headers?: HeadersInit } = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-store");
  return Response.json(body, { status: init.status ?? 200, headers });
}

export function tooManyRequests(error: string): Response {
  return apiError(429, error, { "retry-after": "60" });
}

// CSRF defense in depth on top of SameSite=Lax: a non-simple content type forces
// a CORS preflight, and a browser-supplied Origin must name this host.
export function guardMutation(request: Request): Response | null {
  if (request.method === "GET" || request.method === "HEAD") return null;
  const origin = request.headers.get("origin");
  if (origin !== null) {
    let host: string | null = null;
    try { host = new URL(origin).host; } catch { /* treated as a mismatch */ }
    if (host !== new URL(request.url).host) return apiError(403, "Cross-origin request blocked.");
  }
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return apiError(400, "Expected a JSON request");
  }
  return null;
}

// Unexpected failures (D1, Durable Object) must not leak as the video-processing
// 502 that the top-level handler produces.
export async function guardedRoute(event: string, handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    if (error instanceof BadRequestError) return apiError(400, error.message);
    console.error(JSON.stringify({ event, message: error instanceof Error ? error.message : String(error) }));
    return apiError(503, "Something went wrong. Please try again.");
  }
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const parsed = await readJsonBody(request);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new BadRequestError("Request body must be a JSON object");
  return parsed as Record<string, unknown>;
}

export async function verifyTurnstile(
  request: Request,
  env: Env & { TURNSTILE_SECRET?: string },
  token: unknown,
  expectedAction: string,
): Promise<boolean> {
  const entries = env.TURNSTILE_HOSTNAMES.split(",").map((hostname) => hostname.trim()).filter(Boolean);
  // "*.suffix" entries (Workers Previews) match exactly one label before the suffix.
  const expectedHostnames = new Set(entries.filter((entry) => !entry.startsWith("*.")));
  const previewSuffixes = entries.filter((entry) => entry.startsWith("*.")).map((entry) => entry.slice(2));
  if (
    !env.TURNSTILE_SECRET ||
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > 2048 ||
    entries.length === 0
  ) {
    return false;
  }

  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET,
    response: token,
  });
  const remoteIp = request.headers.get("CF-Connecting-IP");
  if (remoteIp) body.set("remoteip", remoteIp);

  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return false;
    const result = (await response.json()) as TurnstileResult;
    return (
      result.success === true &&
      result.action === expectedAction &&
      typeof result.hostname === "string" &&
      (expectedHostnames.has(result.hostname) || previewSuffixes.some((suffix) => isPreviewHost(result.hostname, suffix)))
    );
  } catch {
    return false;
  }
}
