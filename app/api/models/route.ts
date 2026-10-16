import { stat } from "fs/promises";
import { resolve } from "path";
import { loadModelsWithCache, withSafeModelLoadFailure } from "@/lib/models-cache";
import { EMPTY_MODELS, loadModelsForCwd } from "@/lib/models-loader";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const requestedCwd = new URL(req.url).searchParams.get("cwd");
  // 缺省 cwd（无参数）= 应用自身目录，由启动者选定、并非调用方输入，因此不适用
  // 文件访问白名单——白名单防的是把任意目录当项目加载（那里会跑项目级扩展）。
  // 此前缺省也过白名单，导致应用目录不在允许根（会话 cwd / ~/pi-workspace /
  // ~/pi-cwd-*）的机器上模型库整体 403：编辑器和「接入模型」对话框显示 0 个模型，
  // 而聊天（带会话 cwd，必在允许根内）正常。见 2026-10-09 反馈。
  const cwd = resolve(requestedCwd || process.cwd());

  let cwdStat;
  try {
    cwdStat = await stat(cwd);
  } catch {
    return Response.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
  }
  if (!cwdStat.isDirectory()) {
    return Response.json({ error: `Not a directory: ${cwd}` }, { status: 400 });
  }
  if (requestedCwd) {
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return Response.json({ error: "Access denied" }, { status: 403 });
    }
  }

  try {
    return Response.json(await loadModelsWithCache(cwd, () => loadModelsForCwd(cwd)));
  } catch {
    return Response.json(withSafeModelLoadFailure(EMPTY_MODELS));
  }
}
