import { NextResponse } from "next/server";
import { listAgentMemoryFiles, readAgentMemorySnapshot } from "@/lib/agent-memory";
import { findMemoryConflicts, type MemoryConflictPair } from "@/lib/memory-conflicts";

export const dynamic = "force-dynamic";

/** 一组同文件内的疑似对照（只在有候选时返回） */
interface ConflictGroup {
  file: string;
  label: string;
  pairs: MemoryConflictPair[];
}

/**
 * 记忆冲突候选（只读）。
 *
 * GET /api/memory/conflicts → { groups: [{ file, label, pairs }] }
 *
 * 逐文件跑纯函数 `findMemoryConflicts`（文件内两两比对，零模型调用）；空文件 / 无候选的文件
 * 不进结果，所以 `groups` 为空就代表「没有值得看的对照」。**只提示，不合并、不改写任何文件。**
 */
export async function GET() {
  try {
    const groups: ConflictGroup[] = [];
    for (const file of listAgentMemoryFiles().files) {
      const snapshot = readAgentMemorySnapshot(file.id);
      const pairs = findMemoryConflicts(
        snapshot.entries.map((entry) => ({ text: entry.text, created: entry.created })),
      );
      if (pairs.length > 0) groups.push({ file: file.id, label: file.label, pairs });
    }
    return NextResponse.json({ groups });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
