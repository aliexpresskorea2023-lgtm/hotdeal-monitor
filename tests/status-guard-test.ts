import { stripFalseEndedSignals } from "../src/parsers/status";

/*
 * 상태(status) 판정의 "거짓 종료 신호 제거" 공통 헬퍼 회귀 테스트.
 *
 * 세 파서(fmkorea/ppomppu/ruliweb)가 이 헬퍼를 공유하므로,
 * 여기서 동작을 고정하면 전부 동시에 보호된다.
 *
 * 판정 흐름: extractStatus는 (제목+본문)에서
 *   1) stripFalseEndedSignals 로 거짓 신호 제거
 *   2) 종료/진행 키워드 매치
 * 순으로 동작한다. 여기서는 1단계 출력이 2단계 키워드 판정에
 * 미치는 영향을 대표적인 종료 키워드 정규식으로 함께 검증한다.
 */

/* ruliweb/ppomppu가 쓰는 대표 종료 키워드 정규식. */
const ENDED = /종료|품절|끝났|마감|판매\s*종료|딜\s*종료/;

let allPassed = true;

function check(label: string, ok: boolean): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  allPassed = ok && allPassed;
}

/* 1. 조건부 표현 — 시점상 진행중인데 ended로 잡히면 안 됨 */
{
  const input =
    "[스토어] 테스트 상품 (10,000원/무료) 7%할인 품절시 종료처리하겠습니다";
  const stripped = stripFalseEndedSignals(input);
  check(
    "조건부 '품절시 종료...' 제거 후 종료 신호 없음",
    !ENDED.test(stripped),
  );
}

{
  const input = "소진 시 자동 종료됩니다 서두르세요";
  const stripped = stripFalseEndedSignals(input);
  check(
    "조건부 '소진 시 ... 종료' 제거 후 종료 신호 없음",
    !ENDED.test(stripped),
  );
}

/* 2. 과거 서술 — 재입고 글인데 ended로 잡히면 안 됨 */
{
  const input =
    "[대원샵] 닌텐도 균일가 매번 품절만 뜨던 대원샵이 재고가 있네요";
  const stripped = stripFalseEndedSignals(input);
  check(
    "과거 서술 '품절만 뜨던' 제거 후 종료 신호 없음",
    !ENDED.test(stripped),
  );
}

{
  const input = "품절만 나던 상품 드디어 재입고";
  const stripped = stripFalseEndedSignals(input);
  check(
    "과거 서술 '품절만 나던' 제거 후 종료 신호 없음",
    !ENDED.test(stripped),
  );
}

/* 3. 진짜 종료 신호는 보존돼야 함 (과잉 제거 금지) */
{
  const input = "이 딜은 품절되었습니다";
  const stripped = stripFalseEndedSignals(input);
  check(
    "'품절되었습니다'는 종료 신호 유지",
    ENDED.test(stripped),
  );
}

{
  const input = "방금 종료되었습니다";
  const stripped = stripFalseEndedSignals(input);
  check(
    "'종료되었습니다'는 종료 신호 유지",
    ENDED.test(stripped),
  );
}

{
  const input = "판매종료 된 상품입니다";
  const stripped = stripFalseEndedSignals(input);
  check(
    "'판매종료'는 종료 신호 유지",
    ENDED.test(stripped),
  );
}

/* 4. 무해 통과 — 종료 관련 표현이 없으면 원문 유지 */
{
  const input = "[쿠팡] 고래밥 46g 4개 (2,620원/무료) 개당 600원대";
  const stripped = stripFalseEndedSignals(input);
  check(
    "종료 표현 없는 글은 원문 그대로",
    stripped === input,
  );
}

if (!allPassed) {
  console.log("\n거짓 종료 신호 제거 테스트 실패.");
  process.exit(1);
}

console.log("\n모든 거짓 종료 신호 제거 케이스 통과.");
