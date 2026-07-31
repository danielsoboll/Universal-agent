/**
 * Edge-safe session token helpers (Web Crypto HMAC).
 * Sync wrappers use Node crypto when available; middleware uses async variants.
 */
import type { SessionCookiePayload } from "@/lib/localAuth/types";

export const LOCAL_SESSION_COOKIE = "ga_local_session";
export const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

function sessionSecret(): string {
  const fromEnv = process.env.LOCAL_SESSION_SECRET?.trim();
  if (fromEnv) return fromEnv;
  return "general-agent-local-dev-session-secret";
}

function b64url(input: ArrayBuffer | Uint8Array | string): string {
  const bytes =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : input instanceof Uint8Array
        ? input
        : new Uint8Array(input);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  const b64 =
    typeof btoa === "function"
      ? btoa(bin)
      : Buffer.from(bytes).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromB64url(input: string): Uint8Array {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

async function hmacSign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(sessionSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  return b64url(sig);
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function signSessionPayloadAsync(
  payload: SessionCookiePayload,
): Promise<string> {
  const body = b64url(JSON.stringify(payload));
  const sig = await hmacSign(body);
  return `${body}.${sig}`;
}

export async function verifySessionTokenAsync(
  token: string | undefined | null,
): Promise<SessionCookiePayload | null> {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = await hmacSign(body);
  const a = fromB64url(sig);
  const b = fromB64url(expected);
  if (!timingSafeEqualBytes(a, b)) return null;
  try {
    const json =
      typeof atob === "function"
        ? new TextDecoder().decode(fromB64url(body))
        : Buffer.from(
            body.replace(/-/g, "+").replace(/_/g, "/") +
              "=".repeat((4 - (body.length % 4)) % 4),
            "base64",
          ).toString("utf8");
    const payload = JSON.parse(json) as SessionCookiePayload;
    if (!payload.sid || !payload.uid || !payload.role || !payload.exp) return null;
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Sync helpers for Node server actions (Node crypto). */
export function signSessionPayload(payload: SessionCookiePayload): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHmac } = require("crypto") as typeof import("crypto");
  const body = Buffer.from(JSON.stringify(payload), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  const sig = createHmac("sha256", sessionSecret())
    .update(body)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `${body}.${sig}`;
}

export function verifySessionToken(
  token: string | undefined | null,
): SessionCookiePayload | null {
  if (!token) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHmac, timingSafeEqual } = require("crypto") as typeof import("crypto");
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", sessionSecret()).update(body).digest();
  const pad = sig.length % 4 === 0 ? "" : "=".repeat(4 - (sig.length % 4));
  const actual = Buffer.from(
    sig.replace(/-/g, "+").replace(/_/g, "/") + pad,
    "base64",
  );
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }
  try {
    const padBody = body.length % 4 === 0 ? "" : "=".repeat(4 - (body.length % 4));
    const payload = JSON.parse(
      Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/") + padBody, "base64").toString(
        "utf8",
      ),
    ) as SessionCookiePayload;
    if (!payload.sid || !payload.uid || !payload.role || !payload.exp) return null;
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}
