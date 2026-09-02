/*
 * curl_cffi 배치 HTML 수집 브릿지 (2026-09-02).
 *
 * collector/fetch-html-batch.py를 자식 프로세스로 실행해 Chrome TLS/HTTP2
 * 지문으로 HTML을 받아온다. Node 내장 fetch가 쿠팡(Akamai)·지마켓·옥션·
 * 네이버 계열에서 403/429/JS 챌린지로 광범위하게 차단되는 문제를
 * collector에서 검증된 curl_cffi 경로로 우회한다.
 *
 * 사용법:
 *   const results = await fetchBatchCffi([
 *     { url: "https://...", timeoutMs: 25000, hostGroup: "naver" },
 *     ...
 *   ], {
 *     throttleByGroup: { default: 1500, naver: 10000, slow: 3000 },
 *     warmupHosts: ["smartstore.naver.com"],
 *   });
 *
 * 반환값은 입력과 같은 순서의 결과 배열. 각 결과는
 *   { url, status, body, elapsedMs } 또는 { url, error, elapsedMs }.
 *
 * Python venv가 없거나 실행이 실패하면 전체 결과를 error로 채워 반환한다
 * (호출자가 Node fetch 폴백 등 자체 판단).
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const PYTHON = path.join(ROOT, "collector", ".venv", "bin", "python");
const SCRIPT = path.join(ROOT, "collector", "fetch-html-batch.py");

export interface CffiRequest {
  url: string;
  /** 요청 단위 타임아웃(ms). 기본 25000. */
  timeoutMs?: number;
  /** 호스트 그룹 — Python 쪽 per-group 스로틀 키. 기본 "default". */
  hostGroup?: string;
}

export interface CffiResult {
  url: string;
  status: number | null;
  body: string | null;
  error: string | null;
  elapsedMs: number;
}

export interface CffiOptions {
  /** 그룹별 요청 사이 딜레이(ms). Python 기본값 default=1500. */
  throttleByGroup?: Record<string, number>;
  /** 세션 시작 시 homepage를 한 번 GET해 쿠키 웜업할 호스트 목록. */
  warmupHosts?: string[];
  /** 응답 본문 캡(바이트). Python 기본 2MB. */
  maxBodyBytes?: number;
  /** 전체 배치 타임아웃(ms). 기본: 요청 수 × (최대 스로틀 + 30s) + 30s. */
  totalTimeoutMs?: number;
}

interface PythonLine {
  url: string | null;
  status: number | null;
  body: string | null;
  error?: string;
  elapsed_ms?: number;
}

/**
 * Python 브릿지 가용성 체크. venv가 없으면 false — 호출자는
 * Node fetch 폴백 등 다른 경로를 써야 한다.
 */
export function cffiAvailable(): boolean {
  const fs = require("node:fs") as typeof import("node:fs");
  return fs.existsSync(PYTHON) && fs.existsSync(SCRIPT);
}

export async function fetchBatchCffi(
  requests: CffiRequest[],
  options: CffiOptions = {},
): Promise<CffiResult[]> {
  if (requests.length === 0) return [];

  if (!cffiAvailable()) {
    return requests.map((r) => ({
      url: r.url,
      status: null,
      body: null,
      error: "CffiUnavailable: collector/.venv/bin/python 또는 fetch-html-batch.py 없음",
      elapsedMs: 0,
    }));
  }

  const stdinPayload = requests
    .map((r) =>
      JSON.stringify({
        url: r.url,
        timeout_ms: r.timeoutMs ?? 25000,
        host_group: r.hostGroup ?? "default",
      }),
    )
    .join("\n");

  const throttleJson = JSON.stringify(options.throttleByGroup ?? {});
  const warmupJson = JSON.stringify(options.warmupHosts ?? []);

  const maxThrottle = Math.max(
    1500,
    ...Object.values(options.throttleByGroup ?? { default: 1500 }),
  );
  const totalTimeoutMs =
    options.totalTimeoutMs ??
    requests.length * (maxThrottle + 30_000) + 30_000;

  const args = [
    SCRIPT,
    "--throttle-json",
    throttleJson,
    "--warmup-hosts-json",
    warmupJson,
  ];
  if (options.maxBodyBytes) {
    args.push("--max-body-bytes", String(options.maxBodyBytes));
  }

  try {
    /*
     * execFileSync + input — async execFile은 input 옵션을 지원하지 않아
     * stdin이 비어 Python이 0건 처리한다(2026-09-02 실측). 동기 호출은
     * 배치 잡이라 이벤트 루프 블로킹이 문제없다.
     */
    const stdout = execFileSync(PYTHON, args, {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: totalTimeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      input: stdinPayload,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
    const results: CffiResult[] = [];

    for (let i = 0; i < requests.length; i++) {
      const line = lines[i];
      if (!line) {
        results.push({
          url: requests[i].url,
          status: null,
          body: null,
          error: "NoResponse: Python 출력이 요청 수보다 적음",
          elapsedMs: 0,
        });
        continue;
      }
      try {
        const parsed = JSON.parse(line) as PythonLine;
        results.push({
          url: parsed.url ?? requests[i].url,
          status: parsed.status ?? null,
          body: parsed.body ?? null,
          error: parsed.error ?? null,
          elapsedMs: parsed.elapsed_ms ?? 0,
        });
      } catch (e) {
        results.push({
          url: requests[i].url,
          status: null,
          body: null,
          error: `BadResponseJSON: ${String(e).slice(0, 100)}`,
          elapsedMs: 0,
        });
      }
    }

    return results;
  } catch (e) {
    /*
     * execFileSync는 비정상 종료 시 throw — stdout이 partial로 붙어 있다.
     * 부분 결과가 있으면 살리고, 나머지는 error로 채운다.
     */
    const partial =
      typeof (e as { stdout?: unknown }).stdout === "string"
        ? ((e as { stdout: string }).stdout ?? "")
        : "";
    const msg = String((e as Error).message ?? e).slice(0, 200);
    const lines = partial.split("\n").filter((l) => l.trim().length > 0);

    return requests.map((r, i) => {
      const line = lines[i];
      if (line) {
        try {
          const parsed = JSON.parse(line) as PythonLine;
          return {
            url: parsed.url ?? r.url,
            status: parsed.status ?? null,
            body: parsed.body ?? null,
            error: parsed.error ?? null,
            elapsedMs: parsed.elapsed_ms ?? 0,
          };
        } catch {
          /* fall through to error */
        }
      }
      return {
        url: r.url,
        status: null,
        body: null,
        error: `CffiExecFailed: ${msg}`,
        elapsedMs: 0,
      };
    });
  }
}
