#!/usr/bin/env python3
"""
네이버 쇼핑 키워드 트렌드 수집기 (2026-08-28, v1.7)

출처: snxbest.naver.com 공식 주간 쇼핑 키워드 랭킹.
차트 2종:
  - popular (인기 키워드, KEYWORD_POPULAR): 당주차 + 직전 주차 정도만
    사이트가 제공한다. 매 실행마다 최근 주차부터 과거로 시도해
    빈 응답이 나오면 멈춘다 → 주간 누적 방식으로 히스토리가 쌓인다.
  - new (급상승 키워드, KEYWORD_NEW): 사이트가 과거 주차 조회(ymd)를
    지원하므로 최초 실행 시 전체 히스토리를 백필한다.

부가 정보 (키워드 × 주차 단위):
  - 관련 기사수: Google News RSS 검색 (무키, 상한 100건).
  - 검색량: 네이버 검색광고 키워드도구 (키 필요, .env.local).
  - 관련 유튜브 콘텐츠수: YouTube Data API search (키 필요,
    호출당 100 유닛이라 기본 상한 40건/실행).

출력은 매니퍼스트 JSON 하나 (data/crawls/trends/). DB 쓰기는
scripts/ingest-trends.ts가 담당한다 (수집 = 전송 계층 원칙).

사용법:
  collector/.venv/bin/python collector/trends.py
  collector/.venv/bin/python collector/trends.py --news-all   # 전주차 기사 백필
"""

import argparse
import base64
import hashlib
import hmac
import json
import sqlite3
import sys
import time
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta
from pathlib import Path

from curl_cffi import requests

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "hotdeal.db"
OUT_DIR = ROOT / "data" / "crawls" / "trends"

SNX_BASE = "https://snxbest.naver.com/api/v1/snxbest/keyword/rank"
NEWS_RSS = "https://news.google.com/rss/search"
ADS_URL = "https://api.naver.com/keywordstool"
YT_SEARCH = "https://www.googleapis.com/youtube/v3/search"

# snxbest 카테고리 (사이트 기준). 'A' = 전체.
CATEGORIES = {
    "A": "전체",
    "50000000": "패션의류",
    "50000001": "패션잡화",
    "50000002": "화장품/미용",
    "50000003": "디지털/가전",
    "50000004": "생활/건강",
    "50000005": "식품",
    "50000006": "출산/육아",
    "50000007": "스포츠/레저",
    "50000008": "자동차",
}

SORT_TYPES = {"popular": "KEYWORD_POPULAR", "new": "KEYWORD_NEW"}

THROTTLE_RANK = 0.6
THROTTLE_NEWS = 0.8
THROTTLE_ADS = 0.5
THROTTLE_YT = 1.0

KST = timezone(timedelta(hours=9))

session = requests.Session(impersonate="chrome")
session.headers.update(
    {
        "Accept": "application/json",
        "Accept-Language": "ko-KR,ko;q=0.9",
        "Referer": "https://snxbest.naver.com/home",
    }
)


def now_kst_iso() -> str:
    return datetime.now(KST).isoformat(timespec="seconds")


def log(msg: str) -> None:
    print(f"[trends] {msg}", flush=True)


# ── 환경 키 (.env.local) ─────────────────────────────────────────


def load_env_local() -> dict:
    """루트 .env.local에서 키를 읽는다. 없으면 빈 값 (무키 모드)."""
    env = {}
    path = ROOT / ".env.local"
    if not path.exists():
        return env

    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, _, value = line.partition("=")
        env[key.strip()] = value.strip().strip("'\"")

    return env


# ── 기존 수집 상태 (읽기 전용) ────────────────────────────────────


def load_state() -> dict:
    """DB에서 이미 수집한 (차트, 주차, 카테고리)와 보강 상태를 읽는다."""
    state = {
        "complete": set(),   # (chart_type, ymd, category_id) — 20행 확보
        "news_done": set(),  # (ymd, keyword)
        "ads_done": set(),   # (ymd, keyword)
        "yt_done": set(),    # (ymd, keyword)
    }

    if not DB_PATH.exists():
        return state

    try:
        db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    except sqlite3.Error:
        return state

    try:
        try:
            rows = db.execute(
                "SELECT chart_type, ymd, category_id, COUNT(*) AS n"
                " FROM trend_keywords"
                " GROUP BY chart_type, ymd, category_id"
            ).fetchall()
            state["complete"] = {
                (ct, ymd, cat) for ct, ymd, cat, n in rows if n >= 20
            }
        except sqlite3.OperationalError:
            pass  # 테이블 미생성 — 첫 실행

        try:
            rows = db.execute(
                "SELECT ymd, keyword, news_fetched_at, ads_fetched_at,"
                " youtube_fetched_at FROM trend_enrichment"
            ).fetchall()
            for ymd, kw, news_at, ads_at, yt_at in rows:
                if news_at:
                    state["news_done"].add((ymd, kw))
                if ads_at:
                    state["ads_done"].add((ymd, kw))
                if yt_at:
                    state["yt_done"].add((ymd, kw))
        except sqlite3.OperationalError:
            pass
    finally:
        db.close()

    return state


def load_all_keyword_pairs() -> set:
    """--news-all 백필용: DB에 쌓인 전체 (ymd, keyword) 쌍."""
    if not DB_PATH.exists():
        return set()

    try:
        db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    except sqlite3.Error:
        return set()

    try:
        try:
            rows = db.execute(
                "SELECT DISTINCT ymd, keyword FROM trend_keywords"
            ).fetchall()
            return {(ymd, kw) for ymd, kw in rows}
        except sqlite3.OperationalError:
            return set()
    finally:
        db.close()


def load_latest_week_pairs() -> tuple[set, set]:
    """(당주차 보강 대상, 최신 주차 집합) — 차트별 최신 주차 기준.

    안정 상태에서 랭킹 행이 새로 없을 때도(= 이미 수집 완료) 최신
    주차 키워드의 보강(기사·검색량·유튜브)을 이어갈 수 있게
    대상은 이번 실행 수집분이 아니라 DB에서 뽑는다.
    """
    if not DB_PATH.exists():
        return set(), set()

    try:
        db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    except sqlite3.Error:
        return set(), set()

    try:
        try:
            rows = db.execute(
                "SELECT k.ymd, k.keyword"
                " FROM trend_keywords k"
                " JOIN ("
                "   SELECT chart_type, MAX(ymd) AS m"
                "   FROM trend_keywords GROUP BY chart_type"
                " ) t ON t.chart_type = k.chart_type AND k.ymd = t.m"
            ).fetchall()
            pairs = {(ymd, kw) for ymd, kw in rows}
            ymds = {p[0] for p in pairs}
            return pairs, ymds
        except sqlite3.OperationalError:
            return set(), set()
    finally:
        db.close()


# ── snxbest 차트 API ─────────────────────────────────────────────


def item_from_dict(raw: dict) -> dict:
    return {
        "rank": int(raw.get("rank", 0)),
        "keyword": raw.get("title", ""),
        "sub_title": raw.get("subTitle") or None,
        "status": raw.get("status", "STABLE"),
        "fluctuation": int(raw.get("rankFluctuation", 0) or 0),
        "sync_date": raw.get("syncDate") or None,
        "rank_id": raw.get("rankId") or None,
    }


def item_from_xml(node) -> dict | None:
    def text(tag: str) -> str:
        el = node.find(tag)
        return el.text.strip() if el is not None and el.text else ""

    if not text("title"):
        return None

    try:
        rank = int(text("rank") or 0)
        fluct = int(text("rankFluctuation") or 0)
    except ValueError:
        return None

    return {
        "rank": rank,
        "keyword": text("title"),
        "sub_title": text("subTitle") or None,
        "status": text("status") or "STABLE",
        "fluctuation": fluct,
        "sync_date": text("syncDate") or None,
        "rank_id": text("rankId") or None,
    }


def fetch_rank(chart_type: str, category_id: str, ymd: str | None) -> list:
    """키워드 랭킹 조회. 빈 주차면 []를 돌려준다."""
    params = {
        "ageType": "ALL",
        "categoryId": category_id,
        "sortType": SORT_TYPES[chart_type],
        "periodType": "WEEKLY",
    }
    if ymd:
        params["ymd"] = ymd

    url = SNX_BASE + "?" + urllib.parse.urlencode(params)
    resp = session.get(url, timeout=30)
    resp.raise_for_status()

    body = resp.text.strip()
    if not body or body == "[]":
        return []

    if body.startswith("<"):
        # ymd 변형이 XML을 돌려주는 경우가 있음 — 같은 필드로 파싱.
        root = ET.fromstring(body)
        items = [item_from_xml(node) for node in root.iter("item")]
        return [it for it in items if it]

    data = json.loads(body)
    if not isinstance(data, list):
        raise ValueError(f"예상 밖 응답 형식: {body[:120]}")

    return [item_from_dict(raw) for raw in data]


def fetch_periods() -> list:
    """급상승 차트의 주차 목록 (과거~현재, 30+주)."""
    url = (
        SNX_BASE
        + "/period?ageType=ALL&categoryId=A"
        + "&sortType=KEYWORD_NEW&periodType=WEEKLY"
    )
    resp = session.get(url, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    if not isinstance(data, list):
        raise ValueError(f"period 응답 이상: {str(data)[:120]}")

    return data


# ── Google News RSS (무키) ───────────────────────────────────────


def fetch_news(keyword: str) -> tuple[int, list]:
    """관련 기사수(상한 100)와 최근 3건 샘플."""
    query = urllib.parse.urlencode(
        {"q": keyword, "hl": "ko", "gl": "KR", "ceid": "KR:ko"}
    )
    resp = session.get(f"{NEWS_RSS}?{query}", timeout=30)
    resp.raise_for_status()

    root = ET.fromstring(resp.content)
    items = root.findall(".//item")

    sample = []
    for item in items[:3]:
        raw_title = item.findtext("title") or ""
        # "헤드라인 - 언론사" 형식에서 마지막 ' - ' 기준 분리.
        title, _, source = raw_title.rpartition(" - ")
        sample.append(
            {
                "title": title or raw_title,
                "source": source or None,
                "date": item.findtext("pubDate") or None,
                "link": item.findtext("link") or None,
            }
        )

    return len(items), sample


# ── 네이버 검색광고 키워드도구 (키 필요) ─────────────────────────


def fetch_ads_batch(keywords: list, creds: dict) -> dict:
    """hintKeywords(≤5개) → {키워드: {pc, mobile}}. 관련어는 버린다."""
    ts = str(int(time.time() * 1000))
    path = "/keywordstool"
    message = f"{ts}.GET.{path}"
    signature = base64.b64encode(
        hmac.new(
            creds["secret"].encode("utf-8"),
            message.encode("utf-8"),
            hashlib.sha256,
        ).digest()
    ).decode("ascii")

    url = (
        ADS_URL
        + "?hintKeywords="
        + urllib.parse.quote(",".join(keywords))
        + "&showDetail=1"
    )

    resp = session.get(
        url,
        timeout=30,
        headers={
            "Content-Type": "application/json; charset=UTF-8",
            "X-Timestamp": ts,
            "X-API-KEY": creds["api_key"],
            "X-Customer": creds["customer_id"],
            "X-Signature": signature,
        },
    )
    resp.raise_for_status()
    data = resp.json()

    def parse_count(value):
        # "< 10" 같은 문자열은 정확치가 아니므로 None 처리.
        if isinstance(value, (int, float)):
            return int(value)
        try:
            return int(str(value).strip())
        except (TypeError, ValueError):
            return None

    wanted = set(keywords)
    result = {}
    for row in data.get("keywordList", []):
        kw = row.get("relKeyword")
        if kw in wanted and kw not in result:
            result[kw] = {
                "pc": parse_count(row.get("monthlyPcQcCnt")),
                "mobile": parse_count(row.get("monthlyMobileQcCnt")),
            }

    return result


# ── YouTube Data API (키 필요) ───────────────────────────────────


def fetch_youtube_count(keyword: str, api_key: str) -> int | None:
    """search 호출 1회(100유닛)로 관련 영상수 추정치 조회."""
    query = urllib.parse.urlencode(
        {
            "part": "snippet",
            "type": "video",
            "maxResults": 1,
            "q": keyword,
            "key": api_key,
        }
    )
    resp = session.get(f"{YT_SEARCH}?{query}", timeout=30)

    if resp.status_code == 403:
        # 쿼터 소진 등 — 이번 실행은 유튜브 수집 중단.
        raise PermissionError(resp.text[:200])

    resp.raise_for_status()
    data = resp.json()
    return (data.get("pageInfo") or {}).get("totalResults")


# ── 본 흐름 ──────────────────────────────────────────────────────


def main() -> int:
    parser = argparse.ArgumentParser(description="네이버 키워드 트렌드 수집")
    parser.add_argument(
        "--news-all",
        action="store_true",
        help="전체 주차 기사수 백필 (기본: 최신 주차만)",
    )
    parser.add_argument(
        "--youtube-limit",
        type=int,
        default=40,
        help="유튜브 보강 상한 (호출당 100유닛, 일 10,000유닛)",
    )
    args = parser.parse_args()

    env = load_env_local()
    ads_creds = None
    if env.get("NAVER_ADS_CUSTOMER_ID") and env.get("NAVER_ADS_API_KEY") \
            and env.get("NAVER_ADS_SECRET_KEY"):
        ads_creds = {
            "customer_id": env["NAVER_ADS_CUSTOMER_ID"],
            "api_key": env["NAVER_ADS_API_KEY"],
            "secret": env["NAVER_ADS_SECRET_KEY"],
        }

    yt_key = env.get("YOUTUBE_API_KEY") or None

    log(
        "모드: "
        + ("검색광고 O, " if ads_creds else "검색광고 키 없음, ")
        + ("유튜브 O" if yt_key else "유튜브 키 없음")
    )

    state = load_state()
    weeks_out: list[dict] = []
    keywords_out: list[dict] = []
    week_meta: dict[str, dict] = {}  # ymd → {month, week}

    # 1) 주차 목록 (급상승 차트 기준 — 인기 차트도 같은 주차 키 사용).
    periods = fetch_periods()
    if not periods:
        log("오류: 주차 목록을 가져오지 못했습니다")
        return 1

    for p in periods:
        week_meta[p["ymd"]] = {"month": p.get("month"), "week": p.get("week")}

    period_ymds = [p["ymd"] for p in periods]
    latest_ymd = period_ymds[-1]
    log(f"주차 {len(period_ymds)}개 ({period_ymds[0]}~{latest_ymd})")

    # 2) 인기 키워드 — 최근 주차부터 과거로, 빈 응답 전까지.
    for ymd in reversed(period_ymds[-4:]):
        got_any = False
        for cat_id, cat_name in CATEGORIES.items():
            if ("popular", ymd, cat_id) in state["complete"]:
                got_any = True
                continue

            try:
                items = fetch_rank("popular", cat_id, ymd)
            except Exception as exc:  # noqa: BLE001
                log(f"인기 {ymd}/{cat_id} 실패: {exc}")
                time.sleep(THROTTLE_RANK)
                continue

            time.sleep(THROTTLE_RANK)

            if not items:
                continue

            got_any = True
            for it in items:
                keywords_out.append(
                    {
                        "chart_type": "popular",
                        "ymd": ymd,
                        "category_id": cat_id,
                        "category_name": cat_name,
                        **it,
                    }
                )
            weeks_out.append(
                {
                    "chart_type": "popular",
                    "ymd": ymd,
                    "month": week_meta.get(ymd, {}).get("month"),
                    "week": week_meta.get(ymd, {}).get("week"),
                }
            )

        if not got_any:
            # 이 주차는 사이트가 제공하지 않음 — 더 과거도 무의미.
            log(f"인기 {ymd}: 데이터 없음 — 과거 조회 중단")
            break

    # 3) 급상승 키워드 — 미수집 주차 백필.
    # 급상승 차트는 사이트가 전체('A')만 제공한다 — 카테고리별
    # 데이터는 존재하지 않는다 (2026-08-28 실측).
    new_targets = sum(
        1 for ymd in period_ymds if ("new", ymd, "A") not in state["complete"]
    )
    log(f"급상승 수집 대상: {new_targets}건 (주차)")

    for ymd in period_ymds:
        cat_id, cat_name = "A", CATEGORIES["A"]
        if ("new", ymd, cat_id) in state["complete"]:
            continue

        try:
            items = fetch_rank("new", cat_id, ymd)
        except Exception as exc:  # noqa: BLE001
            log(f"급상승 {ymd} 실패: {exc}")
            time.sleep(THROTTLE_RANK)
            continue

        time.sleep(THROTTLE_RANK)

        if not items:
            continue

        for it in items:
            keywords_out.append(
                {
                    "chart_type": "new",
                    "ymd": ymd,
                    "category_id": cat_id,
                    "category_name": cat_name,
                    **it,
                }
            )
        weeks_out.append(
            {
                "chart_type": "new",
                "ymd": ymd,
                "month": week_meta.get(ymd, {}).get("month"),
                "week": week_meta.get(ymd, {}).get("week"),
            }
        )

    log(f"랭킹 수집 완료: {len(keywords_out)}행")

    # 4) 보강 대상 키워드 선정.
    # 기본 대상 = 차트별 최신 주차 키워드(DB 기준) ∪ 이번 실행 수집분.
    # 랭킹 행이 새로 없는 안정 상태에서도 보강이 이어지도록.
    db_pairs, db_latest_ymds = load_latest_week_pairs()
    run_latest_pairs = {
        (r["ymd"], r["keyword"])
        for r in keywords_out
        if r["ymd"] == latest_ymd
    }
    base_pairs = db_pairs | run_latest_pairs

    # 기사수는 최신 주차만 매 실행 수집 — 과거 주차는 --news-all 수동 백필.
    news_pairs = {
        pair
        for pair in base_pairs
        if pair[0] == latest_ymd or pair[0] in db_latest_ymds
    } - state["news_done"]

    if args.news_all:
        # 이전 실행이 DB에 쌓은 키워드도 백필 대상에 포함.
        news_pairs |= load_all_keyword_pairs() - state["news_done"]

    news_targets = sorted(news_pairs)

    yt_targets: list[tuple[str, str]] = []
    if yt_key:
        yt_targets = sorted(base_pairs - state["yt_done"])
        yt_targets = yt_targets[: args.youtube_limit]

    ads_targets: list[tuple[str, str]] = []
    if ads_creds:
        ads_targets = sorted(base_pairs - state["ads_done"])

    log(
        f"보강 대상: 기사 {len(news_targets)}, "
        f"유튜브 {len(yt_targets)}, 검색광고 {len(ads_targets)}"
    )

    enrichment: dict[tuple[str, str], dict] = {}

    def slot(pair: tuple[str, str]) -> dict:
        return enrichment.setdefault(
            pair, {"ymd": pair[0], "keyword": pair[1]}
        )

    # 4a) 기사.
    news_ok = 0
    for i, pair in enumerate(news_targets):
        try:
            count, sample = fetch_news(pair[1])
            entry = slot(pair)
            entry["news_count"] = count
            entry["news_sample"] = sample
            entry["news_fetched_at"] = now_kst_iso()
            news_ok += 1
        except Exception as exc:  # noqa: BLE001
            log(f"기사 실패 '{pair[1]}': {exc}")

        if i < len(news_targets) - 1:
            time.sleep(THROTTLE_NEWS)

    if news_targets:
        log(f"기사 수집 {news_ok}/{len(news_targets)}")

    # 4b) 유튜브.
    yt_ok = 0
    yt_stopped = False
    for i, pair in enumerate(yt_targets):
        if yt_stopped:
            break
        try:
            count = fetch_youtube_count(pair[1], yt_key)
            entry = slot(pair)
            entry["youtube_count"] = count
            entry["youtube_fetched_at"] = now_kst_iso()
            yt_ok += 1
        except PermissionError as exc:
            log(f"유튜브 중단 (권한/쿼터): {str(exc)[:100]}")
            yt_stopped = True
        except Exception as exc:  # noqa: BLE001
            log(f"유튜브 실패 '{pair[1]}': {exc}")

        if i < len(yt_targets) - 1:
            time.sleep(THROTTLE_YT)

    if yt_targets:
        log(f"유튜브 수집 {yt_ok}/{len(yt_targets)}")

    # 4c) 검색광고 (5개 단위 배치).
    ads_ok = 0
    for i in range(0, len(ads_targets), 5):
        batch = ads_targets[i : i + 5]
        kws = [pair[1] for pair in batch]
        try:
            stats = fetch_ads_batch(kws, ads_creds)
            fetched_at = now_kst_iso()
            for pair in batch:
                entry = slot(pair)
                stat = stats.get(pair[1])
                # API가 행을 안 돌려줘도 시도 사실은 기록(재조회 방지).
                entry["monthly_pc_qc"] = stat["pc"] if stat else None
                entry["monthly_mobile_qc"] = stat["mobile"] if stat else None
                entry["ads_fetched_at"] = fetched_at
                ads_ok += 1
        except Exception as exc:  # noqa: BLE001
            log(f"검색광고 실패 {kws}: {exc}")

        if i + 5 < len(ads_targets):
            time.sleep(THROTTLE_ADS)

    if ads_targets:
        log(f"검색광고 수집 {ads_ok}/{len(ads_targets)}")

    # 5) 매니퍼스트 작성.
    if not keywords_out and not enrichment:
        log("새로 수집할 데이터 없음 — 매니퍼스트 생략")
        return 0

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(KST).strftime("%Y%m%d-%H%M%S")
    out_path = OUT_DIR / f"trends-{stamp}.json"
    unique_weeks = {(w["chart_type"], w["ymd"]): w for w in weeks_out}
    payload = {
        "generated_at": now_kst_iso(),
        "weeks": list(unique_weeks.values()),
        "keywords": keywords_out,
        "enrichment": list(enrichment.values()),
    }
    out_path.write_text(
        json.dumps(payload, ensure_ascii=False), encoding="utf-8"
    )
    log(
        f"매니퍼스트: {out_path.name} (주차 {len(unique_weeks)}, "
        f"키워드 {len(keywords_out)}, 보강 {len(enrichment)})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
