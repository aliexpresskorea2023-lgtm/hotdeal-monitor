#!/usr/bin/env python3
"""hotdeal-monitor 수집 워커 (transport layer).

역할 분담
----------
이 스크립트는 **수송만** 담당한다: 목록 요청 → 게시글 ref 발견 →
상세 요청 → HTML 스냅샷 저장 + manifest.json 기록.
딜 파싱(products/price/status 등)은 기존 TypeScript 순수 파서가
스냅샷 HTML 문자열을 받아 수행한다 (parser-native → normalize → Deal[]).

왜 Python + curl_cffi 인가 (2026-08-26 실측 결론)
--------------------------------------------------
fmkorea/arca.live/quasarzone의 봇 방어는 IP가 아닌 TLS/HTTP2 지문
기반이다. `curl_cffi`의 `impersonate="chrome"`으로 세 곳 모두 챌린지
없이 200을 받았다. Node 단독 TLS 지문 모방은 비권장이므로 수집 계층은
Python이 맡고, 파싱 계층은 TS로 유지한다.

운용 원칙
---------
- 보수적 스로틀: 지문 통과가 확인돼도 커뮤니티당 요청 간격 2.5~3초 유지.
- 챌린지/차단 페이지는 게시글로 저장하지 않는다. 감지 시 해당
  커뮤니티는 그 run에서 즉시 중단하고 manifest에 blocked로 기록한다.
- 200이 아닌 응답도 저장하지 않고 실패 기록만 남긴다.
- 출력은 append-only: <out>/<run-id>/<community>/<postId>.html

DB 인식 증분 수집 (--no-db로 비활성화 가능)
--------------------------------------------
인제스트 DB(data/hotdeal.db)를 읽어들여 상세 요청 자체를 줄인다.
- ended 게시글: 터미널 상태라 다시 크롤링할 이유가 없다 (동결 스킵).
- products=0 게시글: 폼 미입력/자유형이라 딜이 될 수 없다 (동결 스킵).
- active/unknown 게시글: 마지막 적재(last_seen_at)로부터
  --recheck-hours(기본 12h) 이내면 스킵, 경과 후 재수집해
  상태 전환(활성→종료)과 가격 변동을 관측한다.
스킵은 요청이 없으므로 --max-details 수집 예산을 소모하지 않는다.
--force는 스킵 판정을 무시하고 전부 재수집한다.

실행
----
    cd hotdeal-monitor
    collector/.venv/bin/python collector/collect.py                # 5곳 전체, 목록 1페이지, 상세 최대 5건
    collector/.venv/bin/python collector/collect.py --pages 3 --max-details 40   # 딥 크롤
    collector/.venv/bin/python collector/collect.py --communities ppomppu,ruliweb --max-details 3
    collector/.venv/bin/python collector/collect.py --list-only    # 목록 수집(게시글 발견)만

의존성: collector/requirements.txt (curl_cffi)
    python3 -m venv collector/.venv && collector/.venv/bin/pip install -r collector/requirements.txt
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

from curl_cffi import __version__ as CURL_CFFI_VERSION
from curl_cffi import requests as cffi_requests

# =========================================================
# 공통 상수
# =========================================================

KST = timezone(timedelta(hours=9))

HEADERS = {
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    ),
    "Accept-Language": "ko-KR,ko;q=0.9",
}

# fmkorea 통합공지(affiliated-preferred 도메인 목록 글) — 딜이 아님.
FMKOREA_NOTICE_SRL = "1200490157"

ALL_COMMUNITIES = ("fmkorea", "ppomppu", "ruliweb", "quasarzone", "arca")

PostRef = dict[str, str]  # {"id": ..., "url": ...}


# =========================================================
# 챌린지 감지
# =========================================================

CF_MARKERS = (
    "just a moment",
    "cf-chl",
    "_cf_chl",
    "/cdn-cgi/challenge-platform",
)

# 실제 챌린지(인터스티셜) 페이지의 <title>에 나타나는 문구.
# 주의: Cloudflare Managed Challenge가 켜진 사이트는 "통과한" 정상
# 페이지에도 __CF$cv$params 부트스트랩 스니펫을 주입한다. 따라서
# 마커 문자열 존재만으로는 챌린지라 판정할 수 없다 (퀘이사존 오탐 사례).
CHALLENGE_TITLE_PATTERNS = (
    "just a moment",
    "attention required",
    "verify you are human",
    "checking your browser",
    "one more step",
    "请稍候",
)

# 챌린지 인터스티셜은 본문이 거의 스크립트뿐이라 매우 작다.
# 정상 페이지는 사이트 크롬이 붙어 수십~수백 KB다.
CHALLENGE_SMALL_PAGE_BYTES = 64 * 1024


def _extract_title(html: str) -> str:
    m = re.search(r"<title[^>]*>(.*?)</title>", html, re.S | re.I)
    return m.group(1).strip().lower() if m else ""


def is_cloudflare_challenge(status: int, html: str) -> bool:
    """Cloudflare 'Just a moment' 계열 챌린지 페이지 판별."""
    if status in (403, 503):
        return True

    title = _extract_title(html)
    if any(p in title for p in CHALLENGE_TITLE_PATTERNS):
        return True

    # 보조 신호: 챌린지 마커가 있으면서 페이지가 매우 작은 경우.
    # 정상 페이지는 커다란 본문 때문에 이 조건에 걸리지 않는다.
    if len(html) < CHALLENGE_SMALL_PAGE_BYTES:
        low = html.lower()
        if any(marker in low for marker in CF_MARKERS):
            return True

    return False


# 삭제된 게시글 안내 문구. 사이트가 삭제/이동된 글 대신 보여주는
# 작은 안내 페이지인데, Cloudflare 비콘 스크립트가 함께 심겨 있어
# 챌린지 판별(작은 페이지 + CF 마커)에 오검출된다 — 챌린지 판정
# 전에 이 검사로 먼저 걸러야 수집이 중단되지 않는다.
GONE_POST_MARKERS = (
    "글이 존재하지 않습니다",
    "존재하지 않는 게시글",
    "존재하지 않는 게시물",
    "게시글이 존재하지 않습니다",
    "삭제된 게시글",
    "삭제된 게시물",
    "해당 게시글이 없습니다",
    "해당 게시물이 없습니다",
)


def is_gone_post(html: str) -> bool:
    """삭제/이동으로 사라진 게시글의 안내 페이지 판별."""
    if len(html) >= CHALLENGE_SMALL_PAGE_BYTES:
        return False

    return any(marker in html for marker in GONE_POST_MARKERS)


def is_fmkorea_challenge(html: str) -> bool:
    """fmkorea 자체 WAF(보안 시스템/ddosCheckOnly) 판별."""
    return (
        re.search(r"에펨코리아\s*보안\s*시스템", html) is not None
        or "ddosCheckOnly" in html
    )


# =========================================================
# 목록 파서 (HTML string → PostRef[])
#
# 주의: 여긴 "게시글 링크 발견"용 가벼운 정규식 파싱이다.
# 딜 데이터 추출은 TS 파서의 몫이며 여기서 어떤 값도 추측하지 않는다.
# =========================================================


def list_refs_fmkorea(html: str) -> list[PostRef]:
    refs: list[PostRef] = []
    seen: set[str] = set()
    for m in re.finditer(r'document_srl=(\d+)', html):
        pid = m.group(1)
        if pid == FMKOREA_NOTICE_SRL or pid in seen:
            continue
        seen.add(pid)
        refs.append(
            {
                "id": pid,
                "url": (
                    "https://www.fmkorea.com/index.php"
                    f"?mid=hotdeal&document_srl={pid}"
                ),
            }
        )
    return refs


def list_refs_ppomppu(html: str) -> list[PostRef]:
    refs: list[PostRef] = []
    seen: set[str] = set()
    for m in re.finditer(r'href="([^"]*view\.php[^"]*)"', html):
        href = m.group(1)
        # pmarket 게시판 글만 — 공지/규정 등 타 게시판 링크 제외.
        if not re.search(r"[?&]id=pmarket(&|$)", href):
            continue
        no = re.search(r"[?&]no=(\d+)", href)
        if not no or no.group(1) in seen:
            continue
        pid = no.group(1)
        seen.add(pid)
        refs.append(
            {
                "id": pid,
                "url": (
                    "https://www.ppomppu.co.kr/zboard/view.php"
                    f"?id=pmarket&no={pid}"
                ),
            }
        )
    return refs


def list_refs_ruliweb(html: str) -> list[PostRef]:
    refs: list[PostRef] = []
    seen: set[str] = set()
    # <tr> 단위로 잘라 공지(notice) 행을 제외한다.
    for chunk in html.split("<tr"):
        cls = re.search(r'class="([^"]*)"', chunk)
        classes = cls.group(1) if cls else ""
        if "table_body" not in classes or "notice" in classes:
            continue
        m = re.search(r"/board/1020/read/(\d+)", chunk)
        if not m or m.group(1) in seen:
            continue
        pid = m.group(1)
        seen.add(pid)
        refs.append(
            {
                "id": pid,
                "url": (
                    "https://bbs.ruliweb.com/community/board/1020"
                    f"/read/{pid}"
                ),
            }
        )
    return refs


def list_refs_quasarzone(html: str) -> list[PostRef]:
    refs: list[PostRef] = []
    seen: set[str] = set()

    # 공지(all-notice-wrap) 행은 게시판 규정/안내라 딜이 아니다.
    # "<span class="label">공지</span>" 바로 뒤 subject-link가
    # views/<id>를 가리키므로 이 id들을 먼저 모아 제외한다.
    # (파서가 규정 글을 가짜 딜로 오인하는 것 방지)
    notice_ids = set(
        re.findall(
            r'공지</span>\s*<a[^>]+href="/bbs/qb_saleinfo/views/(\d+)',
            html,
        )
    )

    # 제목 앵커와 섬네일 앵커가 동일 href를 중복 노출하므로 dedupe.
    # 목록 URL에 ?page=N이 있으면 앵커에도 ?page=N이 붙으므로
    # id 뒤는 쿼리스트링일 수 있다 (views/1981994?page=1).
    for m in re.finditer(
        r'href="/bbs/qb_saleinfo/views/(\d+)[^"]*"', html
    ):
        pid = m.group(1)
        if pid in seen or pid in notice_ids:
            continue
        seen.add(pid)
        refs.append(
            {
                "id": pid,
                "url": f"https://www.quasarzone.com/bbs/qb_saleinfo/views/{pid}",
            }
        )
    return refs


def list_refs_arca(html: str) -> list[PostRef]:
    refs: list[PostRef] = []
    seen: set[str] = set()
    # 일반 행: <a class="title hybrid-title" href="/b/hotdeal/<id>?p=1">
    # 공지 행은 class가 "vrow column notice ..."라 이 패턴에 걸리지 않는다.
    pattern = (
        r'<a[^>]+class="[^"]*hybrid-title[^"]*"'
        r'[^>]+href="/b/hotdeal/(\d+)[^"]*"'
    )
    for m in re.finditer(pattern, html):
        pid = m.group(1)
        if pid in seen:
            continue
        seen.add(pid)
        refs.append({"id": pid, "url": f"https://arca.live/b/hotdeal/{pid}"})
    return refs


# =========================================================
# 커뮤니티 설정
# =========================================================


@dataclass
class CommunityConfig:
    name: str
    list_url: Callable[[int], str]  # page (1-based) → URL
    throttle_s: float
    decode: Callable[[bytes], str]
    list_refs: Callable[[str], list[PostRef]]
    is_challenge: Callable[[int, str], bool]


def decode_utf8(raw: bytes) -> str:
    return raw.decode("utf-8", errors="replace")


def decode_cp949(raw: bytes) -> str:
    # ppomppu는 EUC-KR 계열(cp949 슈퍼셋) 인코딩.
    return raw.decode("cp949", errors="replace")


COMMUNITIES: dict[str, CommunityConfig] = {
    "fmkorea": CommunityConfig(
        name="fmkorea",
        list_url=lambda page: (
            "https://www.fmkorea.com/index.php"
            f"?mid=hotdeal&listStyle=list&page={page}"
        ),
        throttle_s=3.0,
        decode=decode_utf8,
        list_refs=list_refs_fmkorea,
        is_challenge=lambda status, html: is_fmkorea_challenge(html)
        or is_cloudflare_challenge(status, html),
    ),
    "ppomppu": CommunityConfig(
        name="ppomppu",
        list_url=lambda page: (
            "https://www.ppomppu.co.kr/zboard/zboard.php"
            f"?id=pmarket&page={page}"
        ),
        throttle_s=2.5,
        decode=decode_cp949,
        list_refs=list_refs_ppomppu,
        is_challenge=lambda status, html: is_cloudflare_challenge(
            status, html
        ),
    ),
    "ruliweb": CommunityConfig(
        name="ruliweb",
        list_url=lambda page: (
            f"https://bbs.ruliweb.com/community/board/1020?page={page}"
        ),
        throttle_s=2.5,
        decode=decode_utf8,
        list_refs=list_refs_ruliweb,
        is_challenge=lambda status, html: is_cloudflare_challenge(
            status, html
        ),
    ),
    "quasarzone": CommunityConfig(
        name="quasarzone",
        list_url=lambda page: (
            f"https://www.quasarzone.com/bbs/qb_saleinfo?page={page}"
        ),
        throttle_s=2.5,
        decode=decode_utf8,
        list_refs=list_refs_quasarzone,
        is_challenge=lambda status, html: is_cloudflare_challenge(
            status, html
        ),
    ),
    "arca": CommunityConfig(
        name="arca",
        list_url=lambda page: f"https://arca.live/b/hotdeal?p={page}",
        throttle_s=2.5,
        decode=decode_utf8,
        list_refs=list_refs_arca,
        is_challenge=lambda status, html: is_cloudflare_challenge(
            status, html
        ),
    ),
}


# =========================================================
# 워커 본체
# =========================================================


def now_iso() -> str:
    return datetime.now(KST).isoformat(timespec="seconds")


def log(msg: str) -> None:
    print(f"[{datetime.now(KST).strftime('%H:%M:%S')}] {msg}", flush=True)


@dataclass
class RunStats:
    """커뮤니티 한 곳의 run 결과 요약 (manifest 기록용)."""

    status: str = "ok"  # ok | blocked | list-failed
    list_found: int = 0
    detail_ok: int = 0
    detail_failed: int = 0
    challenge: int = 0
    skipped_frozen: int = 0  # ended/폼미입력 — DB 동결로 재수집 생략
    skipped_recent: int = 0  # TTL 내 재확인 완료 — 재수집 생략
    # 종료 딜 재검증 스윕 (--sweep-ended)
    sweep_checked: int = 0
    sweep_ok: int = 0
    sweep_failed: int = 0


def load_known_posts(
    db_path: str, community: str
) -> dict[str, tuple[str, int, datetime | None]]:
    """인제스트 DB에서 해당 커뮤니티의 기수집 게시글 상태를 읽는다.

    반환: post_id → (status, products_count, last_seen_at).
    DB가 없거나 읽기 실패 시 빈 dict (스킵 없이 전부 수집).
    """
    if not Path(db_path).exists():
        return {}

    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            rows = conn.execute(
                "SELECT post_id, status, products_count, last_seen_at "
                "FROM posts WHERE community = ?",
                (community,),
            ).fetchall()
        finally:
            conn.close()
    except sqlite3.Error as error:
        log(f"DB 읽기 실패({error}) — 스킵 없이 수집합니다.")
        return {}

    known: dict[str, tuple[str, int, datetime | None]] = {}

    for post_id, status, products_count, last_seen_at in rows:
        seen_at: datetime | None = None

        if last_seen_at:
            try:
                seen_at = datetime.fromisoformat(last_seen_at)
            except ValueError:
                seen_at = None

        known[post_id] = (status, products_count, seen_at)

    return known


def load_ended_posts(
    db_path: str, community: str, limit: int
) -> list[tuple[str, str]]:
    """ended 상태 게시글 중 스윕 재검증 대상을 읽는다.

    상품이 있는(products_count > 0) 글만 — 딜이 될 수 없는 글은
    되살아나도 의미가 없다. 최근 확인순으로 정렬(최근 글일수록
    재개장 가능성이 높다). 반환: [(post_id, url), ...].
    """
    if not Path(db_path).exists():
        return []

    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            rows = conn.execute(
                "SELECT post_id, url FROM posts "
                "WHERE community = ? AND status = 'ended' "
                "  AND products_count > 0 "
                "ORDER BY COALESCE(last_seen_at, '') DESC "
                "LIMIT ?",
                (community, limit),
            ).fetchall()
        finally:
            conn.close()
    except sqlite3.Error as error:
        log(f"종료 스윕 대상 읽기 실패({error}) — 스윕 생략.")
        return []

    return [(post_id, url) for post_id, url in rows]


def sweep_ended_posts(
    session: cffi_requests.Session,
    cfg: CommunityConfig,
    args: argparse.Namespace,
    run_dir: Path,
    entries: list[dict],
    stats: RunStats,
) -> None:
    """종료 게시글 원문을 다시 받아 되살아난 딜이 있는지 재검증한다.

    스냅샷은 일반 상세 수집과 동일한 형식(엔트리 + 커뮤니티 폴더
    HTML)으로 저장되어 인제스트가 같은 파서로 재판정한다 — 페이지에
    종료 신호가 사라졌으면 active/unknown으로 승격되고, 여전히
    종료면 ended 유지. 차단·삭제(404)된 글은 ended 그대로 둔다.

    스윕 중 챌린지가 뜨면 해당 커뮤니티 스윕만 중단한다 (목록 수집은
    이미 끝난 뒤라 전체 run 상태를 뒤집지 않는다).
    """
    if args.no_db:
        log("종료 스윕: --no-db 모드라 대상을 읽을 수 없어 생략.")
        return

    targets = load_ended_posts(args.db, cfg.name, args.sweep_limit)

    if not targets:
        return

    out_dir = run_dir / cfg.name
    out_dir.mkdir(parents=True, exist_ok=True)
    throttle = args.throttle if args.throttle else cfg.throttle_s

    log(f"종료 스윕: {cfg.name} 종료 게시글 {len(targets)}건 재확인")

    for post_id, url in targets:
        stats.sweep_checked += 1
        time.sleep(throttle)

        entry: dict = {
            "community": cfg.name,
            "postId": post_id,
            "url": url,
            "collectedAt": now_iso(),
            "sweep": True,
        }

        try:
            res = session.get(url, headers=HEADERS, timeout=30)
        except Exception as error:  # noqa: BLE001 — 스윕은 베스트 에포트
            log(f"  [스윕 {post_id}] 요청 실패 ({error}) — 건너뜀.")
            entry["httpStatus"] = 0
            entry["challenge"] = False
            entry["snapshot"] = None
            entries.append(entry)
            stats.sweep_failed += 1
            continue

        entry["httpStatus"] = res.status_code
        html = cfg.decode(res.content)

        if is_gone_post(html):
            log(f"  [스윕 {post_id}] 삭제된 게시글 — 종료 유지.")
            entry["challenge"] = False
            entry["gone"] = True
            entry["snapshot"] = None
            entries.append(entry)
            stats.sweep_failed += 1
            continue

        if cfg.is_challenge(res.status_code, html):
            log(
                f"  [스윕 {post_id}] 챌린지 감지 "
                f"(HTTP {res.status_code}) — {cfg.name} 스윕 중단."
            )
            entry["challenge"] = True
            entry["snapshot"] = None
            entries.append(entry)
            return

        if res.status_code != 200:
            log(f"  [스윕 {post_id}] HTTP {res.status_code} — 종료 유지.")
            entry["challenge"] = False
            entry["snapshot"] = None
            entries.append(entry)
            stats.sweep_failed += 1
            continue

        snap_path = out_dir / f"{post_id}.html"
        snap_path.write_text(html, encoding="utf-8")

        entry["challenge"] = False
        entry["snapshot"] = f"{cfg.name}/{post_id}.html"
        entry["bytes"] = len(res.content)
        entries.append(entry)
        stats.sweep_ok += 1

    log(
        f"종료 스윕 {cfg.name}: 확인 {stats.sweep_checked} / "
        f"저장 {stats.sweep_ok} / 실패 {stats.sweep_failed}"
    )


def crawl_community(
    session: cffi_requests.Session,
    cfg: CommunityConfig,
    args: argparse.Namespace,
    run_dir: Path,
    entries: list[dict],
    throttle_override: float | None,
) -> RunStats:
    stats = RunStats()
    throttle = throttle_override if throttle_override else cfg.throttle_s
    out_dir = run_dir / cfg.name
    out_dir.mkdir(parents=True, exist_ok=True)

    log(f"========== {cfg.name} ==========")

    # ---- 목록 수집 --------------------------------------
    refs: list[PostRef] = []
    seen: set[str] = set()

    for page in range(1, args.pages + 1):
        url = cfg.list_url(page)
        log(f"목록 {page}페이지: {url}")

        res = session.get(url, headers=HEADERS, timeout=30)
        html = cfg.decode(res.content)

        if cfg.is_challenge(res.status_code, html):
            log(
                f"목록이 챌린지/차단 페이지임 "
                f"(HTTP {res.status_code}) — {cfg.name} 중단."
            )
            stats.status = "blocked"
            return stats

        if res.status_code != 200:
            log(f"목록 요청 실패: HTTP {res.status_code} — {cfg.name} 중단.")
            stats.status = "list-failed"
            return stats

        page_refs = cfg.list_refs(html)
        log(f"  게시글 {len(page_refs)}개 발견")

        for ref in page_refs:
            if ref["id"] not in seen:
                seen.add(ref["id"])
                refs.append(ref)

        time.sleep(throttle)

    stats.list_found = len(refs)

    if args.list_only:
        log(f"--list-only: 상세 수집 생략 ({len(refs)}개 발견)")
        return stats

    # ---- 상세 수집 --------------------------------------
    # 수집 예산(--max-details)은 "실제 요청"에만 적용된다.
    # DB 동결/TTL 스킵은 요청이 없으므로 예산을 소모하지 않는다.
    known_posts: dict[str, tuple[str, int, datetime | None]] = {}

    if not args.no_db and not args.force:
        known_posts = load_known_posts(args.db, cfg.name)

        if known_posts:
            log(f"DB 기수집 게시글 {len(known_posts)}건 참조 ({args.db})")

    recheck_window = timedelta(hours=args.recheck_hours)
    collected = 0

    log(f"상세 수집: 최대 {args.max_details}건 (스로틀 {throttle}s)")

    for ref in refs:
        if collected >= args.max_details:
            break

        known = known_posts.get(ref["id"])

        if known:
            status, products_count, last_seen = known

            # ended는 터미널 상태, products=0은 딜이 될 수 없는 글 —
            # 둘 다 다시 크롤링할 이유가 없다 (동결).
            if status == "ended" or products_count == 0:
                stats.skipped_frozen += 1
                log(f"  [{ref['id']}] 동결 스킵 ({status}, products={products_count})")
                continue

            # active/unknown은 TTL 내 재확인 완료면 스킵.
            if (
                last_seen is not None
                and datetime.now(KST) - last_seen < recheck_window
            ):
                stats.skipped_recent += 1
                log(f"  [{ref['id']}] 최근 재확인 완료 스킵")
                continue

        collected += 1
        time.sleep(throttle)

        entry: dict = {
            "community": cfg.name,
            "postId": ref["id"],
            "url": ref["url"],
            "collectedAt": now_iso(),
        }

        res = session.get(ref["url"], headers=HEADERS, timeout=30)
        entry["httpStatus"] = res.status_code

        html = cfg.decode(res.content)

        if is_gone_post(html):
            log(f"  [{ref['id']}] 삭제된 게시글 — 동결 유지.")
            entry["challenge"] = False
            entry["gone"] = True
            entry["snapshot"] = None
            entries.append(entry)
            stats.detail_failed += 1
            continue

        if cfg.is_challenge(res.status_code, html):
            log(f"  [{ref['id']}] 챌린지 감지 (HTTP {res.status_code}) — 중단.")
            entry["challenge"] = True
            entry["snapshot"] = None
            entries.append(entry)
            stats.challenge += 1
            stats.status = "blocked"
            return stats

        if res.status_code != 200:
            log(f"  [{ref['id']}] HTTP {res.status_code} — 스킵.")
            entry["challenge"] = False
            entry["snapshot"] = None
            entries.append(entry)
            stats.detail_failed += 1
            continue

        snap_path = out_dir / f"{ref['id']}.html"
        snap_path.write_text(html, encoding="utf-8")

        entry["challenge"] = False
        entry["snapshot"] = f"{cfg.name}/{ref['id']}.html"
        entry["bytes"] = len(res.content)
        entries.append(entry)
        stats.detail_ok += 1

        log(f"  [{ref['id']}] 저장 ({entry['bytes']} bytes)")

    return stats


def main() -> int:
    parser = argparse.ArgumentParser(
        description="hotdeal-monitor 수집 워커 (transport layer)"
    )
    parser.add_argument(
        "--communities",
        default=",".join(ALL_COMMUNITIES),
        help="쉼표 구분 수집 대상 (기본: 5곳 전체)",
    )
    parser.add_argument(
        "--pages", type=int, default=1, help="커뮤니티당 목록 페이지 수"
    )
    parser.add_argument(
        "--max-details",
        type=int,
        default=5,
        help="커뮤니티당 상세 수집 최대 건수",
    )
    parser.add_argument(
        "--out",
        default=str(Path(__file__).resolve().parent.parent / "data" / "crawls"),
        help="스냅샷 출력 루트 (기본: data/crawls)",
    )
    parser.add_argument(
        "--throttle",
        type=float,
        default=None,
        help="초 단위 스로틀 강제 (기본: 커뮤니티별 기본값)",
    )
    parser.add_argument(
        "--list-only",
        action="store_true",
        help="목록 수집만 수행하고 상세는 생략",
    )
    parser.add_argument(
        "--db",
        default=str(
            Path(__file__).resolve().parent.parent / "data" / "hotdeal.db"
        ),
        help="인제스트 SQLite 경로 (기본: data/hotdeal.db)",
    )
    parser.add_argument(
        "--no-db",
        action="store_true",
        help="DB 스킵 판정 없이 무조건 수집",
    )
    parser.add_argument(
        "--recheck-hours",
        type=float,
        default=12.0,
        help="active/unknown 게시글 재확인 주기(시간, 기본 12)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="DB 동결/TTL 스킵을 무시하고 전부 재수집",
    )
    parser.add_argument(
        "--sweep-ended",
        action="store_true",
        help="종료 게시글 원문을 재수집해 재개장 여부 재검증",
    )
    parser.add_argument(
        "--sweep-limit",
        type=int,
        default=500,
        help="커뮤니티당 종료 스윕 최대 건수 (기본 500)",
    )
    args = parser.parse_args()

    requested = [c.strip() for c in args.communities.split(",") if c.strip()]
    unknown = [c for c in requested if c not in COMMUNITIES]
    if unknown:
        print(f"알 수 없는 커뮤니티: {unknown} (가능한 값: {list(COMMUNITIES)})")
        return 2

    started_at = now_iso()
    run_id = datetime.now(KST).strftime("%Y%m%dT%H%M%S")
    run_dir = Path(args.out) / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    log(f"run 시작: {run_id}")
    log(f"대상: {requested} | 목록 {args.pages}p | 상세 최대 {args.max_details}건")
    log(f"출력: {run_dir}")

    session = cffi_requests.Session(impersonate="chrome")
    entries: list[dict] = []
    community_stats: dict[str, dict] = {}

    for name in requested:
        stats = crawl_community(
            session,
            COMMUNITIES[name],
            args,
            run_dir,
            entries,
            args.throttle,
        )

        # 종료 딜 재검증 — 목록 수집이 정상 종료된 커뮤니티만.
        if args.sweep_ended and stats.status == "ok":
            sweep_ended_posts(
                session, COMMUNITIES[name], args, run_dir, entries, stats
            )

        community_stats[name] = {
            "status": stats.status,
            "listFound": stats.list_found,
            "detailOk": stats.detail_ok,
            "detailFailed": stats.detail_failed,
            "challenge": stats.challenge,
            "skippedFrozen": stats.skipped_frozen,
            "skippedRecent": stats.skipped_recent,
            "sweepChecked": stats.sweep_checked,
            "sweepOk": stats.sweep_ok,
            "sweepFailed": stats.sweep_failed,
        }

    manifest = {
        "runId": run_id,
        "startedAt": started_at,
        "finishedAt": now_iso(),
        "collector": {
            "script": "collector/collect.py",
            "transport": f"curl_cffi {CURL_CFFI_VERSION} impersonate=chrome",
            "pages": args.pages,
            "maxDetails": args.max_details,
            "throttleOverride": args.throttle,
            "listOnly": args.list_only,
            "db": None if args.no_db else args.db,
            "recheckHours": args.recheck_hours,
            "force": args.force,
            "sweepEnded": args.sweep_ended,
            "sweepLimit": args.sweep_limit,
        },
        "communities": community_stats,
        "entries": entries,
    }

    manifest_path = run_dir / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    # ---- 요약 -------------------------------------------
    ok = sum(s["detailOk"] for s in community_stats.values())
    found = sum(s["listFound"] for s in community_stats.values())
    frozen = sum(s["skippedFrozen"] for s in community_stats.values())
    recent = sum(s["skippedRecent"] for s in community_stats.values())
    sweep_ok = sum(s["sweepOk"] for s in community_stats.values())
    sweep_checked = sum(s["sweepChecked"] for s in community_stats.values())
    blocked = [n for n, s in community_stats.items() if s["status"] == "blocked"]

    log("========== 요약 ==========")
    for name, s in community_stats.items():
        log(
            f"{name}: {s['status']} | 목록 {s['listFound']}개 발견 | "
            f"상세 ok={s['detailOk']} failed={s['detailFailed']} "
            f"challenge={s['challenge']} "
            f"스킵(동결={s['skippedFrozen']}, 최근={s['skippedRecent']}) "
            f"스윕(확인={s['sweepChecked']}, 저장={s['sweepOk']})"
        )
    log(
        f"총 상세 저장: {ok}건 (목록 발견 {found}개, "
        f"동결 스킵 {frozen}, 최근 스킵 {recent}, "
        f"종료 스윕 {sweep_ok}/{sweep_checked})"
    )
    if blocked:
        log(f"차단 감지 커뮤니티: {blocked}")
    log(f"manifest: {manifest_path}")

    return 0 if not blocked else 1


if __name__ == "__main__":
    sys.exit(main())
