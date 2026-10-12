import { randomToken, sha256Hex } from "./tokens";

const SENDER = { email: "noreply@ytdw.fyi", name: "YT;DW" };
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_EMAILS_PER_HOUR = 3;

type TokenPurpose = "verify" | "reset";
type EmailKind = "verify" | "reset" | "duplicate";

const TOKEN_LIFETIME_MS: Record<TokenPurpose, number> = { verify: DAY_MS, reset: HOUR_MS };

interface Message {
  subject: string;
  text: string;
  html: string;
}

// Links are built from the configured APP_ORIGIN var (so Previews can differ from
// production), never from the request Host, so a forged Host header cannot make us
// email an attacker-controlled link. The value is validated once per distinct
// value: it must be a bare https origin; otherwise we log and send nothing.
const originChecks = new Map<string, string | null>();

function appOrigin(env: Env): string | null {
  const raw = String(env.APP_ORIGIN ?? "");
  if (originChecks.has(raw)) return originChecks.get(raw) ?? null;
  let origin: string | null = null;
  try {
    const url = new URL(raw);
    if (url.protocol === "https:" && url.origin === raw.replace(/\/$/, "")) origin = url.origin;
  } catch { /* invalid, handled below */ }
  if (!origin) console.error(JSON.stringify({ event: "email_app_origin_invalid" }));
  originChecks.set(raw, origin);
  return origin;
}

// Messages carry no user-supplied text; the only variable part is the token in the link.
function compose(kind: EmailKind, origin: string, token?: string): Message {
  const link = (path: string) => `${origin}${path}${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  const build = (subject: string, intro: string, url: string, outro: string): Message => ({
    subject,
    text: `${intro}\n\n${url}\n\n${outro}\n\nYT;DW`,
    html: `<p>${intro}</p><p><a href="${url}">${url}</a></p><p>${outro}</p><p>YT;DW</p>`,
  });
  if (kind === "verify") {
    return build(
      "Verify your email for YT;DW",
      "Confirm your email address to keep your YT;DW account recoverable.",
      link("/verify"),
      "This link expires in 24 hours. If you did not create an account, you can ignore this email.",
    );
  }
  if (kind === "reset") {
    return build(
      "Reset your YT;DW password",
      "Use this link to choose a new YT;DW password.",
      link("/reset-password"),
      "This link expires in 1 hour. If you did not ask for it, you can ignore this email; your password has not changed.",
    );
  }
  return build(
    "Someone tried to create a YT;DW account with your address",
    "Someone tried to create a YT;DW account with your email address, but you already have one. If that was you, you can reset your password here.",
    link("/?auth=forgot"),
    "If it was not you, you can ignore this email; your account is unchanged.",
  );
}

// At most MAX_EMAILS_PER_HOUR per address across all kinds. The cap lives in the
// INSERT so concurrent requests cannot overshoot it. Old rows are pruned here.
async function reserveSend(env: Env, email: string, kind: EmailKind): Promise<boolean> {
  const now = Date.now();
  await env.DB.prepare("DELETE FROM email_log WHERE sent_at <= ?").bind(now - DAY_MS).run();
  const result = await env.DB.prepare(
    "INSERT INTO email_log(email, kind, sent_at) SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM email_log WHERE email = ? AND sent_at > ?) < ?",
  ).bind(email, kind, now, email, now - HOUR_MS, MAX_EMAILS_PER_HOUR).run();
  return result.meta.changes > 0;
}

// Issuing replaces the user's earlier tokens of the same purpose and prunes expired ones.
async function issueToken(env: Env, userId: string, purpose: TokenPurpose): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_tokens WHERE expires_at <= ? OR (user_id = ? AND purpose = ?)").bind(now, userId, purpose),
    env.DB.prepare("INSERT INTO auth_tokens(token_hash, user_id, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind(await sha256Hex(token), userId, purpose, now, now + TOKEN_LIFETIME_MS[purpose]),
  ]);
  return token;
}

// Failures are logged without the address and never surface to the caller, so
// delivery problems cannot reveal whether an account exists.
async function deliver(env: Env, to: string, kind: EmailKind, origin: string, token?: string): Promise<void> {
  try {
    await env.EMAIL.send({ from: SENDER, to, ...compose(kind, origin, token) });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : undefined;
    console.error(JSON.stringify({ event: "email_send_failed", kind, code }));
  }
}

async function issueAndSend(env: Env, user: { id: string; email: string }, kind: EmailKind): Promise<void> {
  const origin = appOrigin(env);
  if (!origin) return;
  if (!(await reserveSend(env, user.email, kind))) return;
  // The duplicate-signup notice carries no token: a stranger who tries to sign up
  // with someone's address must not be able to replace that person's reset link.
  const token = kind === "duplicate" ? undefined : await issueToken(env, user.id, kind);
  await deliver(env, user.email, kind, origin, token);
}

export const sendVerification = (env: Env, user: { id: string; email: string }) => issueAndSend(env, user, "verify");

export async function sendPasswordReset(env: Env, email: string): Promise<void> {
  const user = await env.DB.prepare("SELECT id, email FROM users WHERE email = ?").bind(email).first<{ id: string; email: string }>();
  if (user) await issueAndSend(env, user, "reset");
}

export async function sendDuplicateNotice(env: Env, email: string): Promise<void> {
  const user = await env.DB.prepare("SELECT id, email FROM users WHERE email = ?").bind(email).first<{ id: string; email: string }>();
  if (user) await issueAndSend(env, user, "duplicate");
}

// Email work runs after the response so timing cannot reveal whether an
// address has an account. Errors are logged without any address.
export function inBackground(ctx: ExecutionContext, task: Promise<void>): void {
  ctx.waitUntil(task.catch((error: unknown) => {
    console.error(JSON.stringify({ event: "email_task_failed", message: error instanceof Error ? error.message : String(error) }));
  }));
}
