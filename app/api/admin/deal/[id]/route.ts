import { NextResponse } from "next/server";
import { adminGate } from "@/src/lib/admin-gate";
import {
  normalizeOptionalNumber,
  normalizeOptionalText,
  openAdminDb,
  patchDeal,
  setDealRestored,
} from "@/src/db/admin";

/*
 * 어드민 딜 행 쓰기.
 *
 * PATCH — 오버라이드·숨김 수정. 본문 필드만 적용한다.
 *   { name_override?, price_override?, category_override?,
 *     store_override?, url_override?, hidden? }
 *   url_override는 비우면(빈 문자열·공백) 해제, 설정 시
 *   http(s):// 링크만 허용한다.
 * POST — 액션.
 *   { action: "restore" }     제외 복원
 *   { action: "reexclude" }   복원 철회 (다음 인제스트에서 재제외)
 *   { action: "clear" }       오버라이드 전부 해제
 */

type Params = { params: Promise<{ id: string }> };

/** 쓰기 전용 — 게이트와 무관하게 라우트 존재를 숨긴다. */
export function GET() {
  return NextResponse.json({ error: "not found" }, { status: 404 });
}

export async function PATCH(req: Request, { params }: Params) {
  const gate = await adminGate(req);
  if (gate) return gate;

  const { id } = await params;
  const dealId = Number(id);
  if (!Number.isInteger(dealId)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }

  const body = (await req.json()) as Record<string, unknown>;

  /* 구매링크 수동 지정은 http(s) 링크만 허용. */
  const urlOverride = normalizeOptionalText(body.url_override);
  if (urlOverride !== undefined && urlOverride !== null) {
    if (!/^https?:\/\//i.test(urlOverride)) {
      return NextResponse.json(
        { error: "구매링크는 http:// 또는 https:// 주소만 가능합니다" },
        { status: 400 },
      );
    }
  }

  const db = openAdminDb();

  try {
    patchDeal(db, dealId, {
      name_override: normalizeOptionalText(body.name_override),
      price_override: normalizeOptionalNumber(body.price_override),
      category_override: normalizeOptionalText(body.category_override),
      store_override: normalizeOptionalText(body.store_override),
      url_override: urlOverride,
      hidden:
        body.hidden === 0 || body.hidden === 1 ? body.hidden : undefined,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 400 },
    );
  } finally {
    db.close();
  }
}

export async function POST(req: Request, { params }: Params) {
  const gate = await adminGate(req);
  if (gate) return gate;

  const { id } = await params;
  const dealId = Number(id);
  if (!Number.isInteger(dealId)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }

  const body = (await req.json()) as { action?: string };

  const db = openAdminDb();

  try {
    if (body.action === "restore") {
      setDealRestored(db, dealId, true);
    } else if (body.action === "reexclude") {
      setDealRestored(db, dealId, false);
    } else if (body.action === "clear") {
      patchDeal(db, dealId, {
        name_override: null,
        price_override: null,
        category_override: null,
        store_override: null,
        url_override: null,
      });
    } else {
      return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400 });
  } finally {
    db.close();
  }
}
