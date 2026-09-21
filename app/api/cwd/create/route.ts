import { NextResponse } from "next/server";
import { stat, mkdir } from "fs/promises";
import { join, resolve } from "path";
import { allowFileRoot } from "@/lib/file-access";
import { validateNewDirectoryName } from "@/lib/directory-browser";

export const dynamic = "force-dynamic";

/**
 * POST /api/cwd/create  body: { parent: string, name: string }
 *
 * 在用户当前浏览的目录下新建一个文件夹，作为新的会话工作区。
 *
 * 存在理由：以前要「在桌面上新建一个文件夹当工作区」只能先退回终端 mkdir ——
 * 在一个控制台里，不该为了建一个目录而离开界面。
 *
 * 安全边界：
 *  · parent 必须存在且是目录（不创建多级路径）
 *  · name 必须是**单个路径段**（validateNewDirectoryName 拒绝分隔符与 `..`）——
 *    否则这个接口就退化成了「在任意位置建目录」
 *  · 已存在则 409，不覆盖、不合并
 *  · 成功后 allowFileRoot，使新目录立即可作为工作区使用
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as { parent?: unknown; name?: unknown } | null;
    const parentRaw = typeof body?.parent === "string" ? body.parent.trim() : "";
    const nameRaw = typeof body?.name === "string" ? body.name : "";

    if (!parentRaw) return NextResponse.json({ error: "请先选择一个父目录" }, { status: 400 });

    const parent = resolve(parentRaw);
    let parentStat;
    try {
      parentStat = await stat(parent);
    } catch {
      return NextResponse.json({ error: `目录不存在：${parent}` }, { status: 400 });
    }
    if (!parentStat.isDirectory()) {
      return NextResponse.json({ error: `不是目录：${parent}` }, { status: 400 });
    }

    const validated = validateNewDirectoryName(nameRaw);
    if (!validated.ok) return NextResponse.json({ error: validated.error }, { status: 400 });

    const target = join(parent, validated.name);
    try {
      await stat(target);
      return NextResponse.json({ error: `「${validated.name}」已存在` }, { status: 409 });
    } catch {
      /* 不存在才继续 */
    }

    try {
      await mkdir(target);
    } catch (error) {
      return NextResponse.json(
        { error: `创建失败：${error instanceof Error ? error.message : String(error)}` },
        { status: 500 },
      );
    }

    allowFileRoot(target);
    return NextResponse.json({ ok: true, path: target, name: validated.name });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
