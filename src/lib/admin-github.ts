/*
 * GitHub OAuth — 어드민 로그인 인가.
 *
 * 인가 기준(2026-09-04 결정): 대상 저장소에 쓰기(push) 또는 admin 권한이
 * 있는 GitHub 계정만 어드민으로 인정한다. 읽기 전용(pull만)은 거부.
 *
 * 필요 env: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET,
 *           ADMIN_GITHUB_OWNER, ADMIN_GITHUB_REPO
 * (ADMIN_SESSION_SECRET은 admin-session.ts에서 사용)
 */

const AUTHORIZE = "https://github.com/login/oauth/authorize";
const TOKEN = "https://github.com/login/oauth/access_token";
const API = "https://api.github.com";

/** OAuth CSRF state를 잠시 담아둘 쿠키 이름. */
export const OAUTH_STATE_COOKIE = "admin_oauth_state";

export interface GithubConfig {
  clientId: string;
  clientSecret: string;
  owner: string;
  repo: string;
}

export function githubConfig(): GithubConfig | null {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const owner = process.env.ADMIN_GITHUB_OWNER;
  const repo = process.env.ADMIN_GITHUB_REPO;
  if (!clientId || !clientSecret || !owner || !repo) return null;
  return { clientId, clientSecret, owner, repo };
}

/** GitHub 인가 페이지 URL. scope=repo는 비공개 저장소 permissions 조회에 필요. */
export function authorizeUrl(cfg: GithubConfig, origin: string, state: string): string {
  const redirect = `${origin}/api/admin/auth/callback`;
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirect,
    scope: "repo",
    state,
    allow_signup: "false",
  });
  return `${AUTHORIZE}?${q.toString()}`;
}

/** code → access_token 교환. 실패 시 null. */
export async function exchangeCode(
  cfg: GithubConfig,
  code: string,
  origin: string,
): Promise<string | null> {
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: `${origin}/api/admin/auth/callback`,
    }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { access_token?: string; error?: string };
  return json.access_token || null;
}

/** 인증된 사용자의 로그인 핸들. 실패 시 null. */
export async function fetchLogin(token: string): Promise<string | null> {
  const res = await fetch(`${API}/user`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { login?: string };
  return json.login || null;
}

/** 대상 저장소에 쓰기(push) 또는 admin 권한이 있는지. */
export async function hasRepoWrite(
  cfg: GithubConfig,
  token: string,
): Promise<boolean> {
  const res = await fetch(`${API}/repos/${cfg.owner}/${cfg.repo}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!res.ok) return false;
  const json = (await res.json()) as {
    permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
  };
  const p = json.permissions;
  return Boolean(p && (p.push || p.admin));
}
