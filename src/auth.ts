import { apiError, apiJson, guardMutation, guardedRoute, readJsonObject, tooManyRequests, verifyTurnstile } from "./http";

const SESSION_COOKIE = "__Host-ytdw_session";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
// The Workers runtime rejects PBKDF2 above 100,000 iterations.
const PASSWORD_ITERATIONS = 100_000;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 256;
const MAX_EMAIL = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOGIN_FAILED = "Email or password is incorrect.";
const encoder = new TextEncoder();

export interface SessionUser {
  id: string;
  email: string;
}

async function derivePassword(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

async function sha256Hex(value: string): Promise<string> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", encoder.encode(value))).toString("hex");
}

function sessionToken(request: Request): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE) {
      const token = value.join("=");
      return token.length > 0 && token.length <= 64 ? token : null;
    }
  }
  return null;
}

export async function currentUser(request: Request, env: Env): Promise<SessionUser | null> {
  const token = sessionToken(request);
  if (!token) return null;
  return env.DB.prepare(
    "SELECT users.id AS id, users.email AS email FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?",
  ).bind(await sha256Hex(token), Date.now()).first<SessionUser>();
}

function cookieHeader(token: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

async function startSession(env: Env, userId: string, previous: string | null): Promise<string> {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const now = Date.now();
  const statements = [
    // Pruning rides along with sign-ins; no scheduled job is needed.
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    env.DB.prepare("INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(token), userId, now, now + SESSION_TTL_SECONDS * 1000),
  ];
  if (previous) statements.push(env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(previous)));
  await env.DB.batch(statements);
  return token;
}

function signedIn(email: string, token: string, status: number): Response {
  return apiJson({ user: { email } }, { status, headers: { "set-cookie": cookieHeader(token, SESSION_TTL_SECONDS) } });
}

async function handleCredentials(request: Request, env: Env, mode: "signup" | "login"): Promise<Response> {
  // Reject floods before reading a body or making an outbound Siteverify call.
  const clientKey = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await env.AUTH_RATE_LIMIT.limit({ key: `ytdw:auth:${clientKey}` })).success) {
    return tooManyRequests("Too many attempts. Please wait a minute and try again.");
  }
  const body = await readJsonObject(request);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = body.password;
  if (typeof password !== "string") return apiError(400, "Enter your email and password.");
  if (email.length > MAX_EMAIL || !EMAIL_PATTERN.test(email)) return apiError(400, "Enter a valid email address.");
  if (mode === "signup" && (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD)) {
    return apiError(400, `Password must be ${MIN_PASSWORD}–${MAX_PASSWORD} characters.`);
  }
  if (!(await verifyTurnstile(request, env, body.turnstileToken, "auth"))) {
    return apiError(403, "Verification failed. Please try again.");
  }
  const previous = sessionToken(request);

  if (mode === "signup") {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await derivePassword(password, salt, PASSWORD_ITERATIONS);
    const id = crypto.randomUUID();
    try {
      await env.DB.prepare(
        "INSERT INTO users(id, email, password_hash, password_salt, password_iterations, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(id, email, Buffer.from(hash).toString("base64url"), Buffer.from(salt).toString("base64url"), PASSWORD_ITERATIONS, Date.now()).run();
    } catch (error) {
      // The UNIQUE(email) constraint is the authority; a pre-check would race.
      if (error instanceof Error && /UNIQUE/i.test(error.message)) return apiError(409, "An account with this email already exists.");
      throw error;
    }
    return signedIn(email, await startSession(env, id, previous), 201);
  }

  const row = password.length <= MAX_PASSWORD
    ? await env.DB.prepare("SELECT id, password_hash, password_salt, password_iterations FROM users WHERE email = ?")
      .bind(email).first<{ id: string; password_hash: string; password_salt: string; password_iterations: number }>()
    : null;
  // Unknown emails still pay for a derivation so timing does not reveal accounts.
  const salt = row ? Buffer.from(row.password_salt, "base64url") : new Uint8Array(16);
  const derived = await derivePassword(password.slice(0, MAX_PASSWORD), salt, row?.password_iterations ?? PASSWORD_ITERATIONS);
  const expected = row ? new Uint8Array(Buffer.from(row.password_hash, "base64url")) : new Uint8Array(derived.length);
  if (!row || expected.byteLength !== derived.byteLength || !crypto.subtle.timingSafeEqual(derived, expected)) {
    return apiError(401, LOGIN_FAILED);
  }
  return signedIn(email, await startSession(env, row.id, previous), 200);
}

export async function handleAuth(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  return guardedRoute("auth_failed", async () => {
    const blocked = guardMutation(request);
    if (blocked) return blocked;

    if (path === "/api/auth/me" && request.method === "GET") {
      const user = await currentUser(request, env);
      return apiJson({ user: user && { email: user.email } });
    }
    if (request.method === "POST" && (path === "/api/auth/signup" || path === "/api/auth/login")) {
      return handleCredentials(request, env, path === "/api/auth/signup" ? "signup" : "login");
    }
    if (request.method === "POST" && path === "/api/auth/logout") {
      const token = sessionToken(request);
      if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
      return new Response(null, { status: 204, headers: { "cache-control": "no-store", "set-cookie": cookieHeader("", 0) } });
    }
    return apiError(404, "Not found");
  });
}
