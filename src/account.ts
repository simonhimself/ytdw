import {
  type PasswordRow, authRateLimited, clearedCookie, currentUser, hashPassword, normalizeEmail, passwordMatches,
  passwordProblem, publicUser, sessionToken, signedIn, startSession,
} from "./auth";
import { inBackground, sendPasswordReset, sendVerification } from "./email";
import { apiError, apiJson, guardMutation, guardedRoute, readJsonObject, verifyTurnstile } from "./http";
import { TOKEN_SHAPE, sha256Hex } from "./tokens";

const INVALID_LINK = "This link is invalid or has expired.";
const FORGOT_MESSAGE = "If that address has an account, we've sent a link to reset the password.";
const ROUTES = new Set([
  "/api/auth/verify",
  "/api/auth/verify/resend",
  "/api/auth/password/forgot",
  "/api/auth/password/reset",
  "/api/auth/password/change",
  "/api/account/delete",
]);

// Phase 1b routes that handleAuth does not cover; anything else under
// /api/account/ is routed here so it answers 404 rather than reaching the app.
export const isAccountPath = (path: string) => ROUTES.has(path) || path.startsWith("/api/account/");

// Tokens are single-use: the DELETE is the atomic claim, so two concurrent
// requests cannot both succeed.
async function consumeToken(env: Env, token: unknown, purpose: "verify" | "reset"): Promise<string | null> {
  if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) return null;
  const row = await env.DB.prepare("DELETE FROM auth_tokens WHERE token_hash = ? AND purpose = ? AND expires_at > ? RETURNING user_id")
    .bind(await sha256Hex(token), purpose, Date.now()).first<{ user_id: string }>();
  return row?.user_id ?? null;
}

const unauthorized = () => apiError(401, "Sign in to continue.");

async function verifyEmail(request: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(request);
  const userId = await consumeToken(env, body.token, "verify");
  if (!userId) return apiError(400, INVALID_LINK);
  const user = await env.DB.prepare("UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ? RETURNING email")
    .bind(Date.now(), userId).first<{ email: string }>();
  return user ? apiJson({ user: publicUser({ email: user.email, emailVerified: true }) }) : apiError(400, INVALID_LINK);
}

async function resendVerification(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const user = await currentUser(request, env);
  if (!user) return unauthorized();
  if (user.emailVerified) return apiJson({ user: publicUser(user) });
  // Throttling happens silently inside, so the response never depends on it.
  inBackground(ctx, sendVerification(env, user));
  return apiJson({}, { status: 202 });
}

async function forgotPassword(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await readJsonObject(request);
  const email = normalizeEmail(body.email);
  if (!email) return apiError(400, "Enter a valid email address.");
  if (!(await verifyTurnstile(request, env, body.turnstileToken, "auth"))) {
    return apiError(403, "Verification failed. Please try again.");
  }
  // Lookup and send happen after the response, so the reply and its timing are
  // identical whether or not the address has an account.
  inBackground(ctx, sendPasswordReset(env, email));
  return apiJson({ message: FORGOT_MESSAGE }, { status: 202 });
}

async function resetPassword(request: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(request);
  const problem = passwordProblem(body.password);
  if (problem) return apiError(400, problem);
  const userId = await consumeToken(env, body.token, "reset");
  if (!userId) return apiError(400, INVALID_LINK);
  const user = await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(userId).first<{ email: string }>();
  if (!user) return apiError(400, INVALID_LINK);
  const { hash, salt, iterations } = await hashPassword(body.password as string);
  await env.DB.batch([
    // Following the emailed link proves inbox ownership, so the address counts as verified.
    env.DB.prepare(
      "UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?",
    ).bind(hash, salt, iterations, Date.now(), userId),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM auth_tokens WHERE user_id = ? AND purpose = 'reset'").bind(userId),
  ]);
  return signedIn({ email: user.email, emailVerified: true }, await startSession(env, userId, null), 200);
}

async function passwordRow(env: Env, userId: string): Promise<PasswordRow | null> {
  return env.DB.prepare("SELECT password_hash, password_salt, password_iterations FROM users WHERE id = ?").bind(userId).first<PasswordRow>();
}

async function changePassword(request: Request, env: Env): Promise<Response> {
  const user = await currentUser(request, env);
  if (!user) return unauthorized();
  const body = await readJsonObject(request);
  if (typeof body.currentPassword !== "string") return apiError(400, "Enter your current password.");
  const problem = passwordProblem(body.newPassword);
  if (problem) return apiError(400, problem);
  if (!(await passwordMatches(await passwordRow(env, user.id), body.currentPassword))) {
    return apiError(403, "Current password is incorrect.");
  }
  const { hash, salt, iterations } = await hashPassword(body.newPassword as string);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ? WHERE id = ?").bind(hash, salt, iterations, user.id),
    // Other devices must sign in again; this one keeps its session.
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").bind(user.id, await sha256Hex(sessionToken(request) ?? "")),
  ]);
  return apiJson({ user: publicUser(user) });
}

async function deleteAccount(request: Request, env: Env): Promise<Response> {
  const user = await currentUser(request, env);
  if (!user) return unauthorized();
  const body = await readJsonObject(request);
  if (typeof body.password !== "string") return apiError(400, "Enter your password.");
  if (!(await passwordMatches(await passwordRow(env, user.id), body.password))) {
    return apiError(403, "Password is incorrect.");
  }
  // D1 enforces foreign keys, so ON DELETE CASCADE removes sessions, tokens, and saved briefs.
  await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id).run();
  return new Response(null, { status: 204, headers: { "cache-control": "no-store", "set-cookie": clearedCookie() } });
}

export async function handleAccount(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  return guardedRoute("account_failed", async () => {
    const blocked = guardMutation(request);
    if (blocked) return blocked;
    if (!ROUTES.has(path)) return apiError(404, "Not found");
    if (request.method !== "POST") return apiError(405, "Method not allowed", { allow: "POST" });
    const limited = await authRateLimited(request, env);
    if (limited) return limited;

    switch (path) {
      case "/api/auth/verify": return verifyEmail(request, env);
      case "/api/auth/verify/resend": return resendVerification(request, env, ctx);
      case "/api/auth/password/forgot": return forgotPassword(request, env, ctx);
      case "/api/auth/password/reset": return resetPassword(request, env);
      case "/api/auth/password/change": return changePassword(request, env);
      default: return deleteAccount(request, env);
    }
  });
}
