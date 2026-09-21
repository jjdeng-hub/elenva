import { NextResponse } from "next/server";
import { aggregateUsage } from "@/lib/usage-aggregate";

export const dynamic = "force-dynamic";

/** Offline token/cost aggregation across all persisted sessions (home dashboard). */
export async function GET() {
  try {
    const report = await aggregateUsage();
    return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
