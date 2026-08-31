import fs from "node:fs";
import path from "node:path";
import { parsePpomppuHtml } from "../src/parsers/ppomppu";

/*
 * 가격 마커 라인 회귀 테스트 (2026-08-27)
 *
 * 버그 1: 체감가/혜택가/할인가 같은 마커 라인을 파싱할 때
 * 라인 전체의 첫 단위 토큰을 채택해서, 마커 앞에 나온
 * 적립금/정가 금액이 상품 가격으로 잡혔다.
 *
 * 실사례:
 * - 303707 "네멤이면 적립금 1,000원정도 있어서 체감가 4천원대"
 *   → 적립금 1,000원이 가격으로 적재됨. 정답은 제목의 5,400원.
 * - 303702 "월 101,400원 → [카드 할인가] 월 59,400원"
 *   → 정가 101,400원이 잡힘. 마커가 가리키는 값은 59,400원.
 *
 * 수정: 마커 뒤 구간만 파싱.
 *
 * 버그 2: 공구(공동구매) 글은 가격 라벨이 상품명보다 먼저 온다.
 *   "[공구혜택가 125만]" → 상품명 → 링크
 * 이전 파서는 라벨의 마커 앞 파편("[공구")을 상품명으로 잡고,
 * 이어지는 진짜 상품명 라인이 가격을 리셋해서 그룹핑이 실패 →
 * 혜택가 나열 폴백으로 이름 "[공구", 링크 없는 상품들이 나왔다.
 *
 * 수정: 통째로 대괄호인 라벨은 가격 라벨(섹션 헤더)로 취급해
 * 이름 후보를 비우고, 라벨 뒤 첫 텍스트 라인을 상품명으로 받는다.
 * - 303722: 5개 모델, 이름/가격/링크 전부 제자리인지 검증.
 *
 * 버그 3: 목록형 본문(번호 → 상품명 → "다나와 최저가 …" →
 *   "최종 혜택가…")에서 마커 앞 "최종"이 상품명으로 잡혔다.
 *
 * 실사례:
 * - 303752 다나와 기획전 글 — 31개 상품 전부 이름이 "최종",
 *   혜택가 나열(변형) 모드로 빠져 링크도 없음.
 *
 * 수정: 마커 앞이 가격 라벨 수식어(최종/최대…)뿐이면 인라인
 * 이름으로 쓰지 않고 직전 라인에서 상품명을 역추적한다.
 * 참조 가격 라인(최저가 등), 순번, 가격 전용 라인은 건너뜀.
 * - 303752: 31개 상품 이름/가격 검증 (이 글은 상품별 링크가
 *   없어 url null이 정답 — 기획전 링크를 임의로 배정하지 않음).
 */

type Expectation = {
  file: string;
  no: string;
  prices: Array<number | null>;
  /** 상품명까지 검증할 경우 (선택). */
  names?: Array<string | null>;
  /** 구매 링크 끝부분(상품 id)까지 검증할 경우 (선택). */
  urlSuffixes?: Array<string | null>;
};

const cases: Expectation[] = [
  {
    file: "ppomppu-303707.html",
    no: "303707",
    prices: [5400],
  },
  {
    /*
     * 10개 모델 나열 중 9개만 그룹핑 — 10번째는 뒤에 상품
     * 링크가 없어 그룹핑 요건(이름+가격+링크) 미달. 기존 정책.
     */
    file: "ppomppu-303702.html",
    no: "303702",
    prices: [
      59400, 59600, 80200, 15200, 10900, 70300, 28200, 119200,
      15900,
    ],
  },
  {
    /*
     * 공구형: 가격 라벨 → 상품명 → 링크 반복.
     * 라벨("[공구혜택가 N만]")이 상품명이 되면 안 되고,
     * 각 모델명과 스마트스토어 링크가 짝지어져야 한다.
     */
    file: "ppomppu-303722.html",
    no: "303722",
    prices: [1250000, 1490000, 1560000, 1590000, 1930000],
    names: [
      "2026 LG그램북 16 16U55U-GS5CK AMD 라이젠 최신 AI",
      "2026 LG그램 14 14Z95U-GS5CK",
      "2026 LG그램 15 15ZD90U-GX56K 인텔 코어 AI 3세대 Ultra5 팬서레이크 4Xe 16GB 256GB 대학생 가벼운 노트북",
      "2026 LG그램 15 AMD 라이젠 AI 5 고르곤포인트 16GB 256GB Copilot+PC 대학생 직장인 노트북",
      "2026 LG그램 프로 16 AMD 라이젠 5 16GB 256GB 초경량 AI 노트북 신소재 에어로미늄 화이트",
    ],
    urlSuffixes: [
      "/products/13398297355",
      "/products/13684363439",
      "/products/13398294933",
      "/products/12968422164",
      "/products/13398296167",
    ],
  },
  {
    /*
     * 다나와 기획전 목록형: 번호 → 상품명 → "다나와 최저가 …" →
     * "최종 혜택가…" 반복. 마커 앞 "최종"은 라벨 수식어라
     * 상품명이 되면 안 되고, 직전 라인에서 역추적한 모델명이
     * 들어가야 한다. 상품별 링크가 없는 글이라 url은 전부
     * null (기획전 링크 임의 배정 금지 정책 유지 확인).
     */
    file: "ppomppu-303752.html",
    no: "303752",
    prices: [
      1394290, 2249430, 1479000, 1429000, 1799000, 1799370,
      2099440, 579680, 1114730, 2349680, 1006820, 1439980,
      1711800, 1307230, 1212130, 238990, 228650, 213970,
      203220, 734700, 848160, 1798980, 639020, 85930, 85940,
      370670, 328290, 328290, 229080, 147400, 89100,
    ],
    names: [
      "HP 빅터스 15-fa2710TX (SSD 512GB)",
      "HP HyperX 오멘 16-ap1061AX (SSD 512GB)",
      "ASUS Gaming V16 V3607VM-TK158 (SSD 512GB)",
      "ASUS TUF Gaming F16 FX608JHI-TU236 (SSD 512GB)",
      "ASUS TUF Gaming A14 FA401UM-RG006 (SSD 512GB",
      "MSI 소드 GF76 HX B14WFK-i9 QHD (SSD 512GB)",
      "MSI 소드 GF76 HX B14WGK-i9 QHD (SSD 1TB)",
      "레노버 V15 G5 IRL i5 (SSD 256GB)",
      "ASUS 젠북 14 UX3405CA-QD1069W (SSD 512GB)",
      "MSI 프레스티지 14 AI+ D3MG-U9 OLED (SSD 1TB)",
      "삼성전자 데스크탑 Slim DM500SGZ-AD3A (8GB, M.2 256GB)",
      "LG전자 27V70T-GR50K (8GB, M.2 256GB)",
      "MSI MAG Codex Z2 A7NVM MA10 R5-7500F RTX 5060 Ti 게이밍 (16GB, M.2 1TB)",
      "삼성전자 데스크탑 Slim DM500SHZ-AD5A (8GB, M.2 256GB)",
      "MSI MAG Codex Z2 A5NVL A01 R5-5600 RTX 5060 게이밍 (16GB, M.2 500GB)",
      "Razer Huntsman V3 TKL 8K US",
      "로지텍 G PRO X TKL (정품) (블랙)",
      "Razer DeathAdder V4 Pro 화이트 (정품)",
      "Razer Viper V3 Pro (정품) (블랙)",
      "플레이스테이션 5 슬림 825GB 디지털 에디션 본체",
      "플레이스테이션 5 슬림 1TB 본체",
      "LEGION GO 2 1TB",
      "클로 A1M-U7 512GB",
      "PS5 듀얼센스 화이트",
      "PS5 듀얼센스 +PC용 USB 케이블, 미드나이트 블랙",
      "T300RS GT 에디션 레이싱 휠 기본형(3페달)",
      "플레이스테이션 포탈 화이트",
      "플레이스테이션 포탈 미드나이트 블랙",
      "Seagate Game Drive 외장 SSD for PS5 (1TB)",
      "마이크로닉스 Classic II 850W 80PLUS골드 풀모듈러 ATX3.1",
      "마이크로닉스 WIZMAX 우드리안 PRIME",
    ],
    urlSuffixes: Array.from({ length: 31 }, () => null),
  },
];

let failed = 0;

for (const expected of cases) {
  const html = fs.readFileSync(
    path.join(process.cwd(), "tests", "fixtures", expected.file),
    "utf-8",
  );

  const result = parsePpomppuHtml(html, {
    sourceUrl: `https://www.ppomppu.co.kr/zboard/view.php?id=pmarket&no=${expected.no}`,
  });

  const actual = result.products.map((product) => product.price);

  const priceOk =
    actual.length === expected.prices.length &&
    actual.every((price, index) => price === expected.prices[index]);

  if (!priceOk) {
    failed++;
    console.log(
      `FAIL ${expected.file}: 가격 기대 [${expected.prices.join(", ")}] ` +
        `실제 [${actual.join(", ")}]`,
    );
    continue;
  }

  if (expected.names) {
    const actualNames = result.products.map((p) => p.name);
    const namesOk =
      actualNames.length === expected.names.length &&
      actualNames.every((name, i) => name === expected.names![i]);

    if (!namesOk) {
      failed++;
      console.log(`FAIL ${expected.file}: 상품명 불일치`);
      actualNames.forEach((name, i) => {
        if (name !== expected.names![i]) {
          console.log(`  #${i} 기대: ${expected.names![i]}`);
          console.log(`  #${i} 실제: ${name}`);
        }
      });
      continue;
    }
  }

  if (expected.urlSuffixes) {
    const actualUrls = result.products.map((p) => p.url);
    const urlsOk =
      actualUrls.length === expected.urlSuffixes.length &&
      actualUrls.every((url, i) => {
        const suffix = expected.urlSuffixes![i];

        return suffix === null
          ? url === null
          : url !== null && url.endsWith(suffix);
      });

    if (!urlsOk) {
      failed++;
      console.log(`FAIL ${expected.file}: 링크 불일치`);
      actualUrls.forEach((url, i) => {
        console.log(`  #${i} 기대 끝: ${expected.urlSuffixes![i]} / 실제: ${url}`);
      });
      continue;
    }
  }

  console.log(`PASS ${expected.file}: [${actual.join(", ")}]`);
}

if (failed > 0) {
  console.log(`\n${failed}개 케이스 실패`);
  process.exit(1);
}

console.log("\n가격 마커 회귀 케이스 전부 통과.");
