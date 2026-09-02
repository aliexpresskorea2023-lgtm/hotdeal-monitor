#!/usr/bin/env python3
"""
fetch-html-batch.py — curl_cffi Chrome 지문 HTML 배치 수집 브릿지.

배경(2026-09-02):
  scripts/fetch-thumbnails.ts가 Node 내장 fetch로 상품 페이지를 열 때
  쿠팡(Akamai Bot Manager)·지마켓·옥션·에픽(403 + JS 챌린지)·네이버
  계열(429 rate-limit) 등에서 광범위하게 차단된다. collector/collect.py
  에서 검증된 curl_cffi impersonate="chrome" 경로를 썸네일 수집에도
  이식해 TLS/HTTP2 지문 기반 1차 차단을 우회한다.

인터페이스:
  stdin  — NDJSON, 한 줄에 한 요청:
           {"url": "...", "timeout_ms": 25000, "host_group": "naver"}
           host_group은 선택. 없으면 "default".
  stdout — NDJSON, 한 줄에 한 결과:
           {"url": "...", "status": 200, "body": "...", "elapsed_ms": 1234}
           실패 시:
           {"url": "...", "status": null, "body": null,
            "error": "Timeout|CffiError|...", "elapsed_ms": 25000}

CLI:
  --throttle-json '{"default": 1500, "naver": 10000}'
      호스트 그룹별 요청 사이 딜레이(ms). 기본값 default=1500.
  --warmup-hosts-json '["smartstore.naver.com", ...]'
      세션 시작 시 한 번씩 homepage를 GET해 쿠키를 웜업하는 호스트 목록.
  --max-body-bytes N
      응답 본문 캡(기본 2MB). og:image 추출에는 수십 KB면 충분하지만
      SPA 번들 페이지가 수 MB인 경우가 있어 안전장치.

주의:
  - Python은 per-host-group 스로틀만 적용한다. 같은 그룹 안에서는 순차.
  - 세션은 전체 배치 동안 하나 — 쿠키가 host별로 자동 유지된다.
  - 예외는 삼키고 NDJSON error 필드로 보고 (호출자가 판단).
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from typing import Any
from urllib.parse import urlparse

from curl_cffi import requests as cffi_requests

DEFAULT_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)
DEFAULT_HEADERS = {
    "User-Agent": DEFAULT_UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8",
}
DEFAULT_THROTTLE_MS = 1500
DEFAULT_TIMEOUT_MS = 25000
DEFAULT_MAX_BODY = 2 * 1024 * 1024


def host_of(url: str) -> str:
    try:
        return urlparse(url).netloc.lower()
    except Exception:
        return ""


def warmup_session(
    session: cffi_requests.Session,
    hosts: list[str],
    timeout_s: float,
) -> None:
    """호스트 홈페이지를 한 번씩 GET해 쿠키/세션을 웜업."""
    for host in hosts:
        if not host:
            continue
        url = f"https://{host}/"
        try:
            session.get(
                url,
                headers=DEFAULT_HEADERS,
                timeout=timeout_s,
                allow_redirects=True,
            )
        except Exception:
            # 웜업 실패는 치명적이지 않다 — 본 요청에서 재시도됨.
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--throttle-json", default="{}")
    parser.add_argument("--warmup-hosts-json", default="[]")
    parser.add_argument("--max-body-bytes", type=int, default=DEFAULT_MAX_BODY)
    args = parser.parse_args()

    try:
        throttle_map: dict[str, int] = json.loads(args.throttle_json)
    except Exception:
        throttle_map = {}
    try:
        warmup_hosts: list[str] = json.loads(args.warmup_hosts_json)
    except Exception:
        warmup_hosts = []

    session = cffi_requests.Session(impersonate="chrome")

    if warmup_hosts:
        warmup_session(session, warmup_hosts, timeout_s=10.0)

    # 호스트 그룹별 마지막 요청 시각(ms)
    last_by_group: dict[str, float] = {}

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req: dict[str, Any] = json.loads(line)
        except Exception as e:
            emit(
                {
                    "url": None,
                    "status": None,
                    "body": None,
                    "error": f"BadRequestJSON: {e}",
                    "elapsed_ms": 0,
                }
            )
            continue

        url = req.get("url")
        if not isinstance(url, str) or not url:
            emit(
                {
                    "url": url,
                    "status": None,
                    "body": None,
                    "error": "BadRequestURL",
                    "elapsed_ms": 0,
                }
            )
            continue

        group = req.get("host_group") or "default"
        timeout_ms = int(req.get("timeout_ms") or DEFAULT_TIMEOUT_MS)
        timeout_s = max(1.0, timeout_ms / 1000.0)

        # 그룹별 스로틀 — 지난 요청 이후 충분히 지났는지 확인.
        throttle_ms = int(throttle_map.get(group, DEFAULT_THROTTLE_MS))
        now = time.monotonic() * 1000.0
        last = last_by_group.get(group)
        if last is not None:
            wait = throttle_ms - (now - last)
            if wait > 0:
                time.sleep(wait / 1000.0)
        last_by_group[group] = time.monotonic() * 1000.0

        started = time.monotonic()
        try:
            resp = session.get(
                url,
                headers=DEFAULT_HEADERS,
                timeout=timeout_s,
                allow_redirects=True,
            )
            elapsed_ms = int((time.monotonic() - started) * 1000)
            body = resp.text or ""
            if len(body) > args.max_body_bytes:
                body = body[: args.max_body_bytes]
            emit(
                {
                    "url": url,
                    "status": int(resp.status_code),
                    "body": body,
                    "elapsed_ms": elapsed_ms,
                }
            )
        except Exception as e:
            elapsed_ms = int((time.monotonic() - started) * 1000)
            emit(
                {
                    "url": url,
                    "status": None,
                    "body": None,
                    "error": f"{type(e).__name__}: {str(e)[:200]}",
                    "elapsed_ms": elapsed_ms,
                }
            )

    return 0


def emit(obj: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    sys.exit(main())
