/*
 * GitHub Git Database API 폴백 푸시.
 *
 * 배경: 사내망 보안 장비가 TLS를 중간 검사하면서 git-receive-pack
 * 팩 업로드 POST를 HTTP 400으로 거부한다 (2026-08-31 실측 —
 * 인증 성공·1.4MB 팩도 거부·크기와 무관). api.github.com 경로는
 * 열려 있으므로 blob → tree → commit → ref 갱신으로 커밋을 옮긴다.
 *
 * 충실도 보증: 트리/부모/작성자/커미터/메시지가 바이트 단위 동일하면
 * 커밋 오브젝트 SHA도 동일하다 — 각 단계에서 로컬 SHA와 대조하고
 * 불일치 시 즉시 중단한다 (ref는 끝까지 건드리지 않음).
 *
 * 사용법:
 *   npx tsx scripts/api-push.ts [브랜치]
 *   브랜치 생략 시 현재 브랜치. 자격증명은 `git credential fill`로
 *   키체인에서 읽는다 (키체인에 GitHub 자격증명 필요).
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.github.com";

function git(...args: string[]): Buffer {
  return execFileSync("git", args, { cwd: ROOT, maxBuffer: 512 * 1024 * 1024 });
}

function gitText(...args: string[]): string {
  return git(...args).toString("utf-8").trim();
}

interface RepoRef {
  owner: string;
  repo: string;
}

/** remote URL에서 owner/repo 추출 — https·ssh 두 형태 지원. */
function parseRemote(): RepoRef {
  const url = gitText("remote", "get-url", "origin");
  const m =
    url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/) ??
    url.match(/^([^/]+)\/(.+)$/);
  if (!m) throw new Error(`원격 저장소 주소를 해석할 수 없음: ${url}`);
  return { owner: m[1], repo: m[2] };
}

/** 키체인 자격증명 조회 — 파이프라인(비대화형) 환경에서도 동일 경로. */
function credentials(): { user: string; token: string } {
  const out = execFileSync("git", ["credential", "fill"], {
    cwd: ROOT,
    input: "protocol=https\nhost=github.com\n\n",
  })
    .toString("utf-8")
    .trim();
  const user = /^username=(.*)$/m.exec(out)?.[1];
  const token = /^password=(.*)$/m.exec(out)?.[1];
  if (!user || !token) {
    throw new Error("git credential fill이 자격증명을 주지 않음");
  }
  return { user, token };
}

let auth = "";

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<Record<string, any>> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: auth,
      Accept: "application/vnd.github+json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (res.status >= 300) {
    throw new Error(`API ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

async function createBlob(repoPath: string, gitSha: string): Promise<void> {
  const content = git("cat-file", "blob", gitSha);
  const r = await api("POST", `${repoPath}/git/blobs`, {
    content: content.toString("base64"),
    encoding: "base64",
  });
  if (r.sha !== gitSha) {
    throw new Error(`blob SHA 불일치: 로컬 ${gitSha} vs 원격 ${r.sha}`);
  }
}

interface Meta {
  tree: string;
  parent: string;
  an: string;
  ae: string;
  ad: string;
  cn: string;
  ce: string;
  cd: string;
  msg: string;
}

function metaOf(sha: string): Meta {
  const SEP = "\u0001";
  /* trim 금지 — %B 끝 개행이 커밋 오브젝트 바이트의 일부라 그대로
   * 전송해야 SHA가 보존된다 (깃 로그가 붙이는 패딩 한 개만 제거). */
  const raw = git(
    "log",
    "-1",
    `--format=%T${SEP}%P${SEP}%an${SEP}%ae${SEP}%aI${SEP}%cn${SEP}%ce${SEP}%cI${SEP}%B`,
    sha,
  ).toString("utf-8");
  const parts = raw.split(SEP);
  return {
    tree: parts[0],
    parent: parts[1].split(" ")[0],
    an: parts[2],
    ae: parts[3],
    ad: parts[4],
    cn: parts[5],
    ce: parts[6],
    cd: parts[7],
    msg: parts.slice(8).join(SEP).replace(/\n$/, ""),
  };
}

/** 커밋 하나를 원격에 재구성해 돌려준다 (SHA 불일치 시 예외). */
async function pushCommit(
  repoPath: string,
  sha: string,
  remoteParent: string,
): Promise<string> {
  const m = metaOf(sha);

  /* 변경 파일: 모드·종류·경로 수집. */
  const raw = gitText(
    "diff-tree",
    "-r",
    "-z",
    "--no-commit-id",
    m.parent,
    sha,
  );
  const entries: { path: string; mode: string; sha: string | null }[] = [];
  const parts = raw.split("\0");

  for (let i = 0; i < parts.length; i++) {
    const hdr = parts[i];
    if (!hdr.trim()) continue;
    const [, , , newSha, status] = hdr.split(" ");
    const path = parts[++i];
    const newPath =
      status.startsWith("R") || status.startsWith("C") ? parts[++i] : path;

    if (status.startsWith("D")) {
      entries.push({ path, mode: "100644", sha: null });
    } else {
      if (status.startsWith("R")) {
        entries.push({ path, mode: "100644", sha: null });
      }
      const mode = gitText("ls-tree", sha, "--", newPath).split(" ")[0];
      await createBlob(repoPath, newSha);
      entries.push({ path: newPath, mode, sha: newSha });
    }
  }

  const tree = await api("POST", `${repoPath}/git/trees`, {
    base_tree: gitText("rev-parse", `${m.parent}^{tree}`),
    tree: entries.map((e) =>
      e.sha === null
        ? { path: e.path, mode: "100644", type: "blob", sha: null }
        : { path: e.path, mode: e.mode, type: "blob", sha: e.sha },
    ),
  });
  if (tree.sha !== m.tree) {
    throw new Error(
      `tree SHA 불일치 (${sha}): 로컬 ${m.tree} vs 원격 ${tree.sha}`,
    );
  }

  const commit = await api("POST", `${repoPath}/git/commits`, {
    message: m.msg,
    tree: tree.sha,
    parents: [remoteParent],
    author: { name: m.an, email: m.ae, date: m.ad },
    committer: { name: m.cn, email: m.ce, date: m.cd },
  });
  if (commit.sha !== sha) {
    throw new Error(`commit SHA 불일치: 로컬 ${sha} vs 원격 ${commit.sha}`);
  }

  return commit.sha;
}

async function main(): Promise<void> {
  const branch = process.argv[2] || gitText("rev-parse", "--abbrev-ref", "HEAD");
  const { owner, repo } = parseRemote();
  const repoPath = `/repos/${owner}/${repo}`;
  const cred = credentials();
  auth = `Basic ${Buffer.from(`${cred.user}:${cred.token}`).toString("base64")}`;

  /* 원격 브랜치 현재 위치를 직접 조회 (트래킹 참조 스테일 대비). */
  const base =
    gitText("ls-remote", "origin", `refs/heads/${branch}`).split("\t")[0] ||
    "";
  if (!base) throw new Error(`원격에 브랜치 ${branch}가 없음`);

  const queue = gitText("rev-list", "--reverse", `${base}..HEAD`)
    .split("\n")
    .filter(Boolean);

  if (queue.length === 0) {
    console.log("[API 푸시] 원격과 동일 — 푸시할 커밋 없음");
    return;
  }

  console.log(`[API 푸시] ${queue.length}커밋 전송 시작 (${owner}/${repo} ${branch})`);

  let parent = base;
  for (let i = 0; i < queue.length; i++) {
    const sha = queue[i];
    const subject = gitText("log", "-1", "--format=%s", sha);
    parent = await pushCommit(repoPath, sha, parent);
    console.log(
      `[API 푸시] ✓ (${i + 1}/${queue.length}) ${sha.slice(0, 9)} ${subject.slice(0, 50)}`,
    );
  }

  await api("PATCH", `${repoPath}/git/refs/heads/${branch}`, {
    sha: parent,
    force: false,
  });
  console.log(`[API 푸시] 완료: ${branch} → ${parent.slice(0, 9)}`);
}

main().catch((e) => {
  console.error("[API 푸시] 실패:", e instanceof Error ? e.message : e);
  process.exit(1);
});
