/*
 * 어드민 세션 — GitHub OAuth 로그인 후 발급하는 서명 쿠키.
 *
 * 브라우저에 GitHub 토큰을 절대 심지 않고, {login, exp} 페이로드를
 * ADMIN_SESSION_SECRET으로 HMAC-SHA256 서명해 보관한다.
 *
 * middleware(Edge 런타임)와 API 라우트(Node 런타임) 양쪽에서 쓰이므로
 * node:crypto/Buffer 없이 Web Crypto(crypto.subtle) + btoa/atob만 사용한다.
 */

const enc = new TextEncoder();

function toB64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromB64url(str: string): Uint8Array {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function sessionSecret(): string | null {
  return process.env.ADMIN_SESSION_SECRET || null;
}

export interface AdminSession {
  /** GitHub 로그인 핸들 — admin_audit에 기록할 주체. */
  login: string;
  /** 만료 시각 (unix epoch 초). */
  exp: number;
}

/** {login, exp} → "payload.signature" 형태의 서명 토큰. */
export async function signSession(
  login: string,
  maxAgeSec: number,
): Promise<string> {
  const secret = sessionSecret();
  if (!secret) throw new Error("ADMIN_SESSION_SECRET 미설정");

  const payload: AdminSession = {
    login,
    exp: Math.floor(Date.now() / 1000) + maxAgeSec,
  };
  const p = toB64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(p));
  return `${p}.${toB64url(new Uint8Array(sig))}`;
}

/** 서명·만료 검증. 유효하면 세션, 아니면 null. */
export async function verifySession(
  value: string | undefined | null,
): Promise<AdminSession | null> {
  const secret = sessionSecret();
  if (!secret || !value) return null;

  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const p = value.slice(0, dot);
  const s = value.slice(dot + 1);

  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      fromB64url(s) as unknown as BufferSource,
      enc.encode(p),
    );
  } catch {
    return null;
  }
  if (!ok) return null;

  let payload: AdminSession;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromB64url(p)));
  } catch {
    return null;
  }
  if (typeof payload?.login !== "string" || typeof payload?.exp !== "number") {
    return null;
  }
  if (payload.exp * 1000 < Date.now()) return null;

  return payload;
}

/** 세션 쿠키 이름 — middleware·라우트·사이드바가 공유. */
export const ADMIN_SESSION_COOKIE = "admin_session";

/** 세션 유지 기간(초) — 7일 (2026-09-04 결정). */
export const ADMIN_SESSION_MAX_AGE = 60 * 60 * 24 * 7;
