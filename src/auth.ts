import { inBackground, sendDuplicateNotice, sendVerification } from "./email";
import { apiError, apiJson, guardMutation, guardedRoute, readJsonObject, tooManyRequests, verifyTurnstile } from "./http";
import { randomToken, sha256Hex } from "./tokens";

const SESSION_COOKIE = "__Host-ytdw_session";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
// The Workers runtime rejects PBKDF2 above 100,000 iterations.
const PASSWORD_ITERATIONS = 100_000;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 256;
const MAX_EMAIL = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOGIN_FAILED = "Email or password is incorrect.";
const DUPLICATE_ACCOUNT = "An account with this email already exists. Sign in or reset your password.";
const encoder = new TextEncoder();

export interface SessionUser {
  id: string;
  email: string;
  emailVerified: boolean;
}

export interface PasswordRow {
  password_hash: string;
  password_salt: string;
  password_iterations: number;
}

export const publicUser = (user: { email: string; emailVerified: boolean }) => ({ email: user.email, emailVerified: user.emailVerified });

async function derivePassword(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<{ hash: string; salt: string; iterations: number }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePassword(password, salt, PASSWORD_ITERATIONS);
  return { hash: Buffer.from(hash).toString("base64url"), salt: Buffer.from(salt).toString("base64url"), iterations: PASSWORD_ITERATIONS };
}

// A missing row still pays for a derivation so timing does not reveal accounts.
export async function passwordMatches(row: PasswordRow | null, password: string): Promise<boolean> {
  const salt = row ? Buffer.from(row.password_salt, "base64url") : new Uint8Array(16);
  const derived = await derivePassword(password.slice(0, MAX_PASSWORD), salt, row?.password_iterations ?? PASSWORD_ITERATIONS);
  const expected = row ? new Uint8Array(Buffer.from(row.password_hash, "base64url")) : new Uint8Array(derived.length);
  return Boolean(row) && expected.byteLength === derived.byteLength && crypto.subtle.timingSafeEqual(derived, expected);
}

export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string" || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    return `Password must be ${MIN_PASSWORD}–${MAX_PASSWORD} characters.`;
  }
  return null;
}

export function normalizeEmail(value: unknown): string | null {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return email.length <= MAX_EMAIL && EMAIL_PATTERN.test(email) ? email : null;
}

export function sessionToken(request: Request): string | null {
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
  const row = await env.DB.prepare(
    "SELECT users.id AS id, users.email AS email, users.email_verified_at AS verifiedAt FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?",
  ).bind(await sha256Hex(token), Date.now()).first<{ id: string; email: string; verifiedAt: number | null }>();
  return row && { id: row.id, email: row.email, emailVerified: row.verifiedAt !== null };
}

export function cookieHeader(token: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export const clearedCookie = () => cookieHeader("", 0);

export async function startSession(env: Env, userId: string, previous: string | null): Promise<string> {
  const token = randomToken();
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

export function signedIn(user: { email: string; emailVerified: boolean }, token: string, status: number): Response {
  return apiJson({ user: publicUser(user) }, { status, headers: { "set-cookie": cookieHeader(token, SESSION_TTL_SECONDS) } });
}

// Reject floods before reading a body or making an outbound Siteverify call.
export async function authRateLimited(request: Request, env: Env): Promise<Response | null> {
  const clientKey = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await env.AUTH_RATE_LIMIT.limit({ key: `ytdw:auth:${clientKey}` })).success) {
    return tooManyRequests("Too many attempts. Please wait a minute and try again.");
  }
  return null;
}

async function handleCredentials(request: Request, env: Env, ctx: ExecutionContext, mode: "signup" | "login"): Promise<Response> {
  const limited = await authRateLimited(request, env);
  if (limited) return limited;
  const body = await readJsonObject(request);
  const email = normalizeEmail(body.email);
  const password = body.password;
  if (typeof password !== "string") return apiError(400, "Enter your email and password.");
  if (!email) return apiError(400, "Enter a valid email address.");
  if (mode === "signup") {
    const problem = passwordProblem(password);
    if (problem) return apiError(400, problem);
  }
  if (!(await verifyTurnstile(request, env, body.turnstileToken, "auth"))) {
    return apiError(403, "Verification failed. Please try again.");
  }
  const previous = sessionToken(request);

  if (mode === "signup") {
    const { hash, salt, iterations } = await hashPassword(password);
    const id = crypto.randomUUID();
    try {
      await env.DB.prepare(
        "INSERT INTO users(id, email, password_hash, password_salt, password_iterations, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(id, email, hash, salt, iterations, Date.now()).run();
    } catch (error) {
      // The UNIQUE(email) constraint is the authority; a pre-check would race.
      if (error instanceof Error && /UNIQUE/i.test(error.message)) {
        // Tell the owner someone tried to register their address.
        inBackground(ctx, sendDuplicateNotice(env, email));
        return apiError(409, DUPLICATE_ACCOUNT);
      }
      throw error;
    }
    inBackground(ctx, sendVerification(env, { id, email }));
    return signedIn({ email, emailVerified: false }, await startSession(env, id, previous), 201);
  }

  const row = password.length <= MAX_PASSWORD
    ? await env.DB.prepare("SELECT id, email_verified_at, password_hash, password_salt, password_iterations FROM users WHERE email = ?")
      .bind(email).first<PasswordRow & { id: string; email_verified_at: number | null }>()
    : null;
  if (!(await passwordMatches(row, password)) || !row) return apiError(401, LOGIN_FAILED);
  return signedIn({ email, emailVerified: row.email_verified_at !== null }, await startSession(env, row.id, previous), 200);
}

export async function handleAuth(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  return guardedRoute("auth_failed", async () => {
    const blocked = guardMutation(request);
    if (blocked) return blocked;

    if (path === "/api/auth/me" && request.method === "GET") {
      const user = await currentUser(request, env);
      return apiJson({ user: user && publicUser(user) });
    }
    if (request.method === "POST" && (path === "/api/auth/signup" || path === "/api/auth/login")) {
      return handleCredentials(request, env, ctx, path === "/api/auth/signup" ? "signup" : "login");
    }
    if (request.method === "POST" && path === "/api/auth/logout") {
      const token = sessionToken(request);
      if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
      return new Response(null, { status: 204, headers: { "cache-control": "no-store", "set-cookie": clearedCookie() } });
    }
    return apiError(404, "Not found");
  });
}
