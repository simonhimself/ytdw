// Random secrets are stored only as SHA-256 hashes (sessions and email tokens).
const encoder = new TextEncoder();

export async function sha256Hex(value: string): Promise<string> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", encoder.encode(value))).toString("hex");
}

export function randomToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

// 32 random bytes in base64url is exactly 43 characters.
export const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
