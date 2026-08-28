/*
 * 상품명 표시 정제 (2026-08-27) — 파서는 건드리지 않고
 * 표시 계층에서만 적용하는 순수 함수.
 *
 * 배경: 커뮤니티발 상품명에 프로모션 수식어·스토어 괄호·카드사
 * 나열·가격 파편이 섞여 "중구난방"으로 보인다. 원본은 deals에
 * 그대로 두고, 표시용 이름만 보수적으로 다듬는다.
 *
 * 원칙:
 * - 실패해도 원본 유지 (규칙이 틀리면 안 다듬는 것만 못함).
 * - 잘라내는 패턴은 전부 실데이터 표본에서 관찰된 것만.
 * - 정보를 지우는 규칙(용량·구성)은 절대 추가하지 않는다.
 */

import { isOtherStore, normalizeStore } from "../db/taxonomy";

/** 카드사/은행 나열 — 이름 맨 뒤가 이걸로만 끝나면 제거 대상. */
const BANK_TAIL =
  /\s*\(?((농협|신한|우리|국민|하나|비씨|카카오|삼성|현대|롯데)(카드|뱅크)?)([\/·,\s]+(농협|신한|우리|국민|하나|비씨|카카오|삼성|현대|롯데)(카드|뱅크)?)*\)?$/;

/** 끝이 가격 파편으로 끝나는 케이스 ("...충전베이스 151,829원"). */
const PRICE_TAIL = /\s*\d{1,3}(?:,\d{3})+원$|\s*\d{4,}원$/;

/** 끝의 결제 수단 표기 ("...20pet 토스페이"). */
const PAY_TAIL =
  /\s*(토스페이|페이코|네이버페이|카카오페이|삼성페이|엘페이|스마일페이)$/;

/** 끝의 배송 조건 표기 ("양파 1.5kg 무배"). */
const SHIP_TAIL = /\s+(무배|무료배송|착불)$/;

/** 안 닫힌 프로모션 괄호 파편 ("...(와우474,800원" → 가격 제거 후 잔재). */
const UNCLOSED_PROMO_PAREN = /\s*\((와우|삼카|신카|현카|쿠폰|카드할인)[^()]*$/;

/** 가격 뒤에 붙는 카드사 속어 ("삼카369,830원" → 가격 제거 후 잔재). */
const CARD_SLANG_TAIL = /\s+(삼카|신카|현카|롯카|와우)$/;

/** 끝의 증정 사은구 ("+아이스크림홀더증정", "(+스타벅스 머그 증정)"). */
const GIFT_TAIL = /(\s*\+[^+()]*증정|\s*\([^)]*증정[^)]*\))$/;

/** 끝의 프로모션 괄호 — 가격 안내·멤버십 조건·번들 홍보만.
    "(총5kg)" 같은 구성 정보 괄호는 건드리지 않는다. */
const PROMO_TAIL_PAREN =
  /\s*\((체감가|할인가|특가|최종가|카드할인|와우할인|티멤버십|멤버십)[^)]*\)$|\s*\([^)]*프로모션\)$/;

/** 머리 프로모션 괄호 — 관찰된 조합만. */
const PROMO_HEAD_PAREN =
  /^\((재입고|품절임박|타임딜|오늘특가|단하루|상생특가[^)]*|체감가[^)]*|와우할인|티멤버십|카드할인[^)]*|즉시할인[^)]*|최대 ?\d+%[^)]*할인[^)]*)\)\s*/;

/** 머리 외로운 닫힘 ("타임딜) 튀겨나와..."). */
const PROMO_HEAD_ORPHAN = /^(타임딜|특가딜|핫딜|세일)\)\s*/;

/**
 * 표시용 상품명 정제.
 * @param name 원본 상품명 (null이면 그대로 null)
 * @param storeNorm 아이템의 정규화 스토어 — 머리 스토어 중복 제거용
 */
export function cleanDisplayName(
  name: string | null,
  storeNorm?: string,
): string | null {
  if (!name) return name;

  let out = name.trim();

  /* 1. 머리 스토어 괄호 — 알려진 스토어(필터 목록)일 때만 제거.
        [GIGABYTE]·[DESKER] 같은 브랜드나 [50개] 수량은 보존. */
  const bracket = out.match(/^\[([^\]]+)\]\s*/);
  if (bracket && !isOtherStore(normalizeStore(bracket[1]))) {
    out = out.slice(bracket[0].length);
  }

  /* 2. 머리 프로모션 괄호 — 반복 적용 ("(재입고) (특가) ..." 대비). */
  for (let i = 0; i < 3; i++) {
    const next = out
      .replace(PROMO_HEAD_PAREN, "")
      .replace(PROMO_HEAD_ORPHAN, "");
    if (next === out) break;
    out = next;
  }

  /* 3. 머리 스토어명 중복 ("무신사 미즈노 ..." → 스토어가 무신사일 때). */
  if (storeNorm) {
    const prefix = `${storeNorm} `;
    if (out.startsWith(prefix) && out.length > prefix.length + 2) {
      out = out.slice(prefix.length);
    }
  }

  /* 4. 꼬리 정리 — 순서: 증정 → 프로모션 괄호 → 카드사 → 결제수단
        → 가격 파편 → 잔재(안 닫힌 괄호·카드 속어) → 배송 조건.
        한 규칙이 벗겨낸 뒤에 드러나는 꼬리("...736,000원 무배"에서
        무배 제거 후 가격 파편)를 잡으려고 2회 반복한다. */
  for (let i = 0; i < 2; i++) {
    const next = out
      .replace(GIFT_TAIL, "")
      .replace(PROMO_TAIL_PAREN, "")
      .replace(BANK_TAIL, "")
      .replace(PAY_TAIL, "")
      .replace(PRICE_TAIL, "")
      .replace(UNCLOSED_PROMO_PAREN, "")
      .replace(CARD_SLANG_TAIL, "")
      .replace(SHIP_TAIL, "")
      .trim();
    if (next === out) break;
    out = next;
  }

  return out || name.trim();
}

/*
 * 필드 분리 (2026-08-28) — 커머스 상품명 등록 관례를 본뜬 표시 규칙.
 *
 * 정제는 "어지러운 수식어 제거"고, 분리는 "남은 이름에서 구성/수량
 * 정보를 별도 필드로 빼는 것"이다. 예:
 *   "머스크멜론 특대과 2통(총5kg) 1개당 2.5kg"
 *   → main: "머스크멜론 특대과" / quantity: "2통(총5kg) · 1개당 2.5kg"
 *
 * 카테고리별 관례는 단위 목록 자체에 반영되어 있다:
 * - 식품·생활(통/팩/병/캔/kg/L...)과 패션·잡화(개/매/쌍/켤레...)의
 *   수량·구성 토큰만 분리 대상이다.
 * - 가전/PC의 스펙(256GB, i5, 512GB, 16인치)은 단위 목록에 없어
 *   이름에 그대로 남는다 — 스펙은 전자제품 이름의 정체성이다.
 * - 번들 표기("+ 포코 피아")는 단위가 아니라 분리하지 않는다.
 *
 * 없는 필드는 노출하지 않는 것이 규칙 — quantity가 null이면 화면에
 * 아무것도 붙지 않는다.
 */

export interface NameParts {
  /** 상품 이름 본체 */
  main: string;
  /** 분리된 구성/수량 표기 (없으면 null) */
  quantity: string | null;
}

/** 꼬리의 개수 단위 토큰 — 뒤에 설명 괄호를 달 수 있다. */
const COUNT_TAIL =
  /\s*\d{1,3}(?:,\d{3})*\s*(?:통|개|박스|팩|병|캔|매|세트|입|수|장|쌍|켤레|포|스틱|캡슐|시트|정|권|튜브)(?:\s*\([^)]*\))?$/;

/** 꼬리의 중량·용량 토큰. */
const WEIGHT_TAIL =
  /\s*(?:총\s*)?\d+(?:\.\d+)?\s*(?:kg|g|L|ml|리터|킬로|그램)(?:\s*\([^)]*\))?$/;

/** 꼬리의 1+1 계열. */
const PLUS_DEAL_TAIL = /\s*\d{1,2}\s*\+\s*\d{1,2}(?:\s*\+\s*\d{1,2})?$/;

/** 꼬리의 단위당 표기 ("1개당 2.5kg"). */
const PER_UNIT_TAIL = /\s*\d{1,3}\s*개당[^()]*$/;

/** 머리의 수량 라벨 ("[50개] 양말" → 50개를 구성 필드로). */
const QTY_HEAD_BRACKET = /^\[(\d{1,3}(?:,\d{3})*(?:\s*[+x×]\s*\d{1,3})?\s*(?:통|개|박스|팩|병|캔|매|세트|입|수|장|쌍|켤레|포|정|권)?|[+]\s*\d{1,3})\]\s*/;

export function splitNameParts(display: string): NameParts {
  let main = display.trim();
  const parts: string[] = [];

  const head = main.match(QTY_HEAD_BRACKET);
  if (head) {
    parts.push(head[1].trim());
    main = main.slice(head[0].length);
  }

  /* 꼬리 체인 — "2통(총5kg) 1개당 2.5kg"처럼 연달아 붙은 구성을
     전부 벗겨낸다. 단위당 표기가 수치 꼬리를 포함하므로 가장
     먼저 매칭한다. */
  for (let i = 0; i < 4; i++) {
    const m = main.match(PER_UNIT_TAIL) ?? main.match(
      COUNT_TAIL,
    ) ?? main.match(WEIGHT_TAIL) ?? main.match(PLUS_DEAL_TAIL);

    if (!m) break;

    parts.unshift(m[0].trim());
    main = main.slice(0, m.index).trim();
  }

  /* 과분리 방지: 본체가 너무 짧아지면 분리하지 않은 것만 못하다. */
  if (main.length < 2) {
    return { main: display.trim(), quantity: null };
  }

  return {
    main,
    quantity: parts.length > 0 ? parts.join(" · ") : null,
  };
}
