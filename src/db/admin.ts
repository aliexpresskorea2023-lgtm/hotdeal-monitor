import type { DatabaseSync } from "node:sqlite";
import { nowKstIso, openDb } from "./index";

/*
 * 어드민 쓰기 계층 (로컬 전용).
 *
 * 모든 쓰기는 이 모듈을 통한다 — 감사 로그(admin_audit) 기록이
 * 한 곳에서 보장되도록. 읽기 전용 웹 계층(queries.ts)과 분리:
 * 여긴 openDb()로 열고(쓰기 가능), 운영 환경에서는 어드민이
 * 꺼져 있어 이 코드가 실행되지 않는다.
 *
 * 오버라이드 원칙: 파서 값 컬럼은 절대 쓰지 않는다. 수동 수정은
 * *_override 컬럼에만 기록하고, 노출은 queries.ts가 합성한다.
 */

export function openAdminDb(): DatabaseSync {
  return openDb();
}

export function audit(
  db: DatabaseSync,
  action: string,
  entity: string,
  entityId: number,
  field: string | null,
  oldValue: string | null,
  newValue: string | null,
): void {
  db.prepare(
    `INSERT INTO admin_audit (at, actor, action, entity, entity_id, field, old_value, new_value)
     VALUES (?, 'local', ?, ?, ?, ?, ?, ?)`,
  ).run(nowKstIso(), action, entity, entityId, field, oldValue, newValue);
}

/** null 허용 문자열 필드 갱신 헬퍼 — 빈 문자열은 null로 정규화. */
export function normalizeOptionalText(
  value: unknown,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;

  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** null 허용 숫자 필드 헬퍼. */
export function normalizeOptionalNumber(
  value: unknown,
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;

  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return undefined;

  return num;
}

export interface DealPatch {
  name_override?: string | null;
  price_override?: number | null;
  category_override?: string | null;
  store_override?: string | null;
  url_override?: string | null;
  hidden?: number;
}

const DEAL_PATCH_FIELDS = [
  "name_override",
  "price_override",
  "category_override",
  "store_override",
  "url_override",
  "hidden",
] as const;

/** 딜 오버라이드/하이드 갱신. 변경 필드만 감사 기록. */
export function patchDeal(db: DatabaseSync, dealId: number, patch: DealPatch): void {
  const current = db
    .prepare(
      `SELECT name_override, price_override, category_override,
              store_override, url_override, hidden
       FROM deals WHERE id = ?`,
    )
    .get(dealId) as Record<string, string | number | null> | undefined;

  if (!current) throw new Error(`deal ${dealId} 없음`);

  const sets: string[] = [];
  const values: (string | number | null)[] = [];

  for (const field of DEAL_PATCH_FIELDS) {
    const next = patch[field];
    if (next === undefined) continue;

    const before = current[field];

    if (before !== next) {
      audit(
        db,
        "update",
        "deal",
        dealId,
        field,
        before === null ? null : String(before),
        next === null ? null : String(next),
      );
    }

    sets.push(`${field} = ?`);
    values.push(next);
  }

  if (sets.length === 0) return;

  values.push(dealId);
  db.prepare(`UPDATE deals SET ${sets.join(", ")} WHERE id = ?`).run(
    ...values,
  );
}

/** 제외 복원 / 복원 철회. */
export function setDealRestored(
  db: DatabaseSync,
  dealId: number,
  restored: boolean,
): void {
  const current = db
    .prepare(`SELECT excluded_reason, exclusion_restored FROM deals WHERE id = ?`)
    .get(dealId) as
    | { excluded_reason: string | null; exclusion_restored: number }
    | undefined;

  if (!current) throw new Error(`deal ${dealId} 없음`);

  if (restored) {
    db.prepare(
      `UPDATE deals SET exclusion_restored = 1, excluded_reason = NULL WHERE id = ?`,
    ).run(dealId);
    audit(db, "restore", "deal", dealId, "excluded_reason",
      current.excluded_reason, null);
  } else {
    db.prepare(
      `UPDATE deals SET exclusion_restored = 0 WHERE id = ?`,
    ).run(dealId);
    audit(db, "reexclude", "deal", dealId, "exclusion_restored", "1", "0");
  }
}

export interface PostPatch {
  status_override?: "active" | "ended" | null;
  hidden?: number;
}

/** 게시글 상태 지정/하이드 갱신. */
export function patchPost(
  db: DatabaseSync,
  postId: number,
  patch: PostPatch,
): void {
  const current = db
    .prepare(`SELECT status_override, hidden FROM posts WHERE id = ?`)
    .get(postId) as Record<string, string | number | null> | undefined;

  if (!current) throw new Error(`post ${postId} 없음`);

  const sets: string[] = [];
  const values: (string | number | null)[] = [];

  for (const field of ["status_override", "hidden"] as const) {
    const next = patch[field];
    if (next === undefined) continue;

    const before = current[field];

    if (before !== next) {
      audit(
        db,
        "update",
        "post",
        postId,
        field,
        before === null ? null : String(before),
        next === null ? null : String(next),
      );
    }

    sets.push(`${field} = ?`);
    values.push(next);
  }

  if (sets.length === 0) return;

  values.push(postId);
  db.prepare(`UPDATE posts SET ${sets.join(", ")} WHERE id = ?`).run(
    ...values,
  );
}

/** 관측 시점 가격 수정. */
export function patchObservation(
  db: DatabaseSync,
  observationId: number,
  dealPrice: number,
): void {
  const current = db
    .prepare(
      `SELECT deal_price, currency FROM price_observations WHERE id = ?`,
    )
    .get(observationId) as
    | { deal_price: number | null; currency: string | null }
    | undefined;

  if (!current) throw new Error(`observation ${observationId} 없음`);

  /* 원화 관측이면 추정 원화도 동기화. 외화는 관측가만 수정. */
  const estimated =
    current.currency === "KRW" || current.currency === null
      ? dealPrice
      : null;

  db.prepare(
    `UPDATE price_observations
     SET deal_price = ?, estimated_krw = COALESCE(?, estimated_krw)
     WHERE id = ?`,
  ).run(dealPrice, estimated, observationId);

  audit(db, "update", "observation", observationId, "deal_price",
    current.deal_price === null ? null : String(current.deal_price),
    String(dealPrice));
}

/** 관측 시점 삭제 (오염 데이터 제거용 — 물리 삭제 확정). */
export function deleteObservation(
  db: DatabaseSync,
  observationId: number,
): void {
  const current = db
    .prepare(
      `SELECT deal_rowid, deal_price FROM price_observations WHERE id = ?`,
    )
    .get(observationId) as
    | { deal_rowid: number; deal_price: number | null }
    | undefined;

  if (!current) throw new Error(`observation ${observationId} 없음`);

  db.prepare(`DELETE FROM price_observations WHERE id = ?`).run(
    observationId,
  );

  audit(db, "delete", "observation", observationId, null,
    current.deal_price === null ? null : String(current.deal_price), null);
}

/** 썸네일 수동 지정 / 해제. */
export function setImageOverride(
  db: DatabaseSync,
  productKey: string,
  url: string | null,
): void {
  const current = db
    .prepare(`SELECT image_override FROM product_images WHERE product_key = ?`)
    .get(productKey) as { image_override: string | null } | undefined;

  if (current) {
    db.prepare(
      `UPDATE product_images SET image_override = ? WHERE product_key = ?`,
    ).run(url, productKey);
  } else {
    /* 행이 없으면 생성 — attempts를 포기로 채워 자동 수집을 막는다. */
    db.prepare(
      `INSERT INTO product_images (product_key, image_url, attempts, fetched_at, image_override)
       VALUES (?, '', 3, ?, ?)`,
    ).run(productKey, nowKstIso(), url);
  }

  audit(db, url === null ? "clear" : "update", "image", 0, productKey,
    current?.image_override ?? null, url);
}

/** 썸네일 캐시 초기화 (재시도할 수 있게 행 삭제). */
export function resetImageCache(db: DatabaseSync, productKey: string): void {
  db.prepare(`DELETE FROM product_images WHERE product_key = ?`).run(
    productKey,
  );
  audit(db, "delete", "image", 0, productKey, null, null);
}
