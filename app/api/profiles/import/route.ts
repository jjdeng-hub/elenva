import { NextResponse } from "next/server";
import { ApiError, importArchive } from "@/lib/profiles-mutate";

export const dynamic = "force-dynamic";

interface ImportBody {
  archive?: string;
  name?: string;
  connect?: boolean;
}

/** POST /api/profiles/import —— 从回收站归档恢复 profile（{archive, name?, connect?}）。 */
export async function POST(req: Request) {
  let body: ImportBody;
  try {
    body = (await req.json()) as ImportBody;
  } catch {
    return NextResponse.json({ error: "body 不是 JSON" }, { status: 400 });
  }

  try {
    const result = await importArchive({
      archive: body.archive ?? "",
      name: body.name,
      connect: body.connect,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
