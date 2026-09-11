import * as cheerio from "cheerio";

/*
 * 게시글 본문 삽입 이미지 추출 (2026-09-11).
 *
 * 용도: 상품 썸네일(product_images)을 못 구한 딜의 2순위 폴백.
 * 커뮤니티 원문 본문에 들어있는 상품 캡처/이미지를 가져와
 * "상품 썸네일 → 본문 이미지 → 커뮤니티 로고" 체인의 중간을 채운다.
 *
 * 입력은 수집기가 저장한 원문 HTML 스냅샷 문자열(posts.snapshot_path).
 * 출력은 절대 URL 문자열 또는 null.
 *
 * 전략 (스코어링):
 * 1) 문서 전체 <img>를 수집하되 lazy-load 속성(data-src 등)도 인정.
 * 2) 아바타·아이콘·이모티콘·서명·배너·광고·레벨뱃지·트래킹 픽셀은 제외.
 * 3) 남은 후보를 커뮤니티별 "본문 콘텐츠 이미지" URL 패턴 우선으로 점수화.
 *    - 콘텐츠 패턴 매칭(+1000): 게시판이 본문 첨부에만 쓰는 호스트/경로.
 *    - 본문 컨테이너 내부(+100): 댓글/사이드바보다 본문 영역 우선.
 *    - 면적(width×height 속성) 가산: 큰 이미지가 대표 상품컷일 확률 높음.
 * 4) 최고점, 동점이면 문서 등장 순서(첫 이미지)를 택한다.
 *
 * 컨테이너 셀렉터만으로는 quasarzone처럼 본문이 비표준 래퍼에 있는 경우
 * 놓치므로, 콘텐츠 URL 패턴을 1차 신호로 삼는 것이 핵심이다.
 */

type Cheerio = ReturnType<typeof cheerio.load>;

/** 커뮤니티별 본문 컨테이너 셀렉터 (스코어 +100용, 첫 매칭). */
const BODY_SELECTORS: Record<string, string[]> = {
  fmkorea: [".fm_best_widget", ".xe_content"],
  ppomppu: ["td.board-contents", ".board-contents", "div.contents"],
  ruliweb: [".content_wrapper", ".article_content", ".content"],
  quasarzone: [".content-area", ".content-board-area", ".fr-view"],
  arca: [".article-body"],
  naver_cafe: [".se-component", "#postViewArea", ".article_content"],
};

/**
 * 커뮤니티별 "본문 첨부 이미지" URL 패턴 (스코어 +1000).
 * 게시판이 본문 업로드에만 사용하는 호스트/경로 시그니처.
 */
const CONTENT_PATTERNS: Record<string, RegExp> = {
  fmkorea: /image\d*\.fmkorea\.com\/files\/attach\//i,
  ppomppu: /ppomppu\.co\.kr\/zboard\/data/i,
  ruliweb: /i\d*\.ruliweb\.com\/(ori|img)\/\d{2}\/\d{2}\//i,
  quasarzone: /img\d*\.quasarzone\.com\/editor\//i,
  arca: /ac(?:-o)?\.arca\.live\/\d{8}sac\//i,
  naver_cafe: /(?:postfiles|blogfiles|phinf)\.pstatic\.net/i,
};

/**
 * 제외할 이미지 URL 패턴 — 아바타/프로필/아이콘/이모티콘/서명/배너/광고/
 * 레벨뱃지/스토어로고/트래킹/스프라이트/플레이스홀더 등. 대소문자 무시.
 */
const EXCLUDE_URL = new RegExp(
  [
    "avatar",
    "profile",
    "/icon",
    "icon_",
    "_icon",
    "emoji",
    "smiley",
    "emoticon",
    "/sign",
    "signature",
    "banner",
    "/ad/",
    "/ads/",
    "adpost",
    "googleads",
    "doubleclick",
    "logo",
    "button",
    "/btn",
    "sprite",
    "loading",
    "lazy",
    "transparent",
    "blank\\.(gif|png)",
    "noimg",
    "no_img",
    "thumb_small",
    "/level", // quasarzone 레벨뱃지
    "special_level",
    "grade_",
    "badge",
    "medal",
    "/store/", // quasarzone 스토어로고
    "/user/", // quasarzone 유저 아바타
    "/classes/", // fmkorea lazy 플레이스홀더
    "recom",
    "good_",
    "singo",
    "scrap",
    "/css/",
    "pixel",
    "tracker",
    "1x1",
    "spacer",
    "divider",
    "line\\.(gif|png)",
    "dot\\.(gif|png)",
    "/img/2016/", // ruliweb 공용 사이트 에셋
  ].join("|"),
  "i",
);

/** 확장자가 이미지인지 (쿼리스트링 허용). */
function isImageExt(url: string): boolean {
  const path = url.split("?")[0].split("#")[0].toLowerCase();
  return /\.(jpg|jpeg|png|webp|gif|avif|bmp)$/.test(path);
}

/** 상대 URL을 기준 URL로 절대화. data:/실패 시 null. */
function absolutize(src: string, baseUrl: string | null): string | null {
  const s = src.trim();
  if (!s) return null;
  if (s.startsWith("data:")) return null;
  if (s.startsWith("//")) return `https:${s}`.replace(/\/\.\//g, "/");
  if (/^https?:\/\//i.test(s)) return s.replace(/\/\.\//g, "/");
  if (!baseUrl) return null;
  try {
    return new URL(s, baseUrl).toString();
  } catch {
    return null;
  }
}

function firstNum(v: string | undefined): number {
  if (!v) return 0;
  const m = v.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

/** width/height 속성 또는 인라인 style에서 추정 면적(px²). 모르면 0. */
function estimateArea($: Cheerio, el: any): number {
  let w = firstNum($(el).attr("width"));
  let h = firstNum($(el).attr("height"));
  if (w === 0 || h === 0) {
    const style = $(el).attr("style") ?? "";
    const wm = style.match(/width\s*:\s*(\d+)px/i);
    const hm = style.match(/height\s*:\s*(\d+)px/i);
    if (wm && w === 0) w = parseInt(wm[1], 10);
    if (hm && h === 0) h = parseInt(hm[1], 10);
  }
  if (w > 0 && h === 0) h = w;
  if (h > 0 && w === 0) w = h;
  return w > 0 && h > 0 ? w * h : 0;
}

/** 명백히 작은 이미지(아이콘·픽셀) 제외. 크기를 모르면 통과. */
function tooSmall($: Cheerio, el: any): boolean {
  const w = firstNum($(el).attr("width"));
  const h = firstNum($(el).attr("height"));
  if (w > 0 && w < 80) return true;
  if (h > 0 && h < 80) return true;
  return false;
}

export interface ExtractBodyImageOptions {
  /** 상대 URL 절대화용 원문 URL. 없으면 절대 URL만 인정. */
  baseUrl?: string | null;
}

/**
 * 게시글 HTML에서 본문 대표 이미지를 추출한다.
 * @returns 절대 이미지 URL 또는 null (없거나 전부 필터됨).
 */
export function extractBodyImage(
  community: string,
  html: string,
  options: ExtractBodyImageOptions = {},
): string | null {
  if (!html) return null;

  let $: Cheerio;
  try {
    $ = cheerio.load(html);
  } catch {
    return null;
  }

  const baseUrl = options.baseUrl ?? null;
  const contentPattern = CONTENT_PATTERNS[community];

  // 본문 컨테이너 요소 집합 (스코어 +100 판정용).
  let containerEl: cheerio.Cheerio<any> | null = null;
  for (const sel of BODY_SELECTORS[community] ?? []) {
    try {
      const el = $(sel).first();
      if (el.length > 0) {
        containerEl = el;
        break;
      }
    } catch {
      /* 잘못된 셀렉터 무시 */
    }
  }

  const candidates: { url: string; score: number; order: number }[] = [];
  let order = 0;

  $("body img").each((_, el) => {
    order += 1;
    const $el = $(el);

    const rawSrc =
      $el.attr("data-original") ||
      $el.attr("data-src") ||
      $el.attr("data-lazy-src") ||
      $el.attr("src") ||
      $el.attr("data-url") ||
      "";

    const abs = absolutize(rawSrc, baseUrl);
    if (!abs) return;
    if (!isImageExt(abs)) return;
    if (EXCLUDE_URL.test(abs)) return;
    if (tooSmall($, el)) return;

    let score = 0;
    if (contentPattern && contentPattern.test(abs)) score += 1000;
    if (containerEl && containerEl.find($el).length > 0) score += 100;
    // 면적 가산: 로그 스케일로 눌러서 패턴/컨테이너 우선순위를 넘지 않게.
    const area = estimateArea($, el);
    if (area > 0) score += Math.min(99, Math.round(Math.log10(area) * 10));

    candidates.push({ url: abs, score, order });
  });

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.score - a.score || a.order - b.order);
  return candidates[0].url;
}
