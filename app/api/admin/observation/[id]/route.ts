import { NextResponse } from "next/server";
import { adminGate } from "@/src/lib/admin-gate";
import {
  deleteObservation,
  openAdminDb,
  patchObservation,
} from "@/src/db/admin";

/*
 * 어드민 가격 관측 시점 쓰기.
 * PATCH { deal_price: number } — 오염 관측 정정.
 * DELETE — 오염 관측 물리 삭제.
 */

type Params = { params: Promise<{ id: string }> };

/** 쓰기 전용 — 게이트와 무관하게 라우트 존재를 숨긴다. */
export function GET() {
  return NextResponse.json({ error: "not found" }, { status: 404 });
}

export async function PATCH(req: Request, { params }: Params) {
  const gate = adminGate();
  if (gate) return gate;

  const { id } = await params;
  const obsId = Number(id);
  if (!Number.isInteger(obsId)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }

  const body = (await req.json()) as { deal_price?: unknown };
  const price = Number(body.deal_price);

  if (!Number.isFinite(price) || price < 0) {
    return NextResponse.json(
      { error: "deal_price must be a non-negative number" },
      { status: 400 },
    );
  }

  const db = openAdminDb();

  try {
    patchObservation(db, obsId, price);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400 });
  } finally {
    db.close();
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const gate = adminGate();
  if (gate) return gate;

  const { id } = await params;
  const obsId = Number(id);
  if (!Number.isInteger(obsId)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }

  const db = openAdminDb();

  try {
    deleteObservation(db, obsId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400 });
  } finally {
    db.close();
  }
}
