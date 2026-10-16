export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // 宿主判别信号（模块 5 · 第 5 轮）：进程级标记「本进程是 ELENVA Web」。
  // 用途只有一个 —— 让 agentDir 扩展 `elenva-host-guard`（CLI / 飞书侧的硬护栏）
  // 在这里整体静默，避免同一条命令被拦两次（web 的审批闸门就在本进程内）。
  // 为什么放这里：本文件是 Next 服务进程的启动钩子，会话创建早于任何请求；
  // `lib/agent-runtime.ts` 里另有一处兜底（只 import lib 的测试/脚本路径覆盖不到这里）。
  process.env.ELENVA_WEB_HOST = "1";

  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();

  // 节律调度器：服务启动即挂上单例调度循环（不依赖用户先打开某个页面）。
  // 延迟到启动流程之外动态装载，既不拖慢启动，也不在此把 pi 内核拉进来
  // ——真正的会话执行链在触发时才 import（见 lib/scheduler.ts）。
  void import("@/lib/scheduler")
    .then(({ ensureSchedulerStarted }) => ensureSchedulerStarted())
    .catch((error) => {
      console.error(
        "[elenva] failed to start rhythm scheduler:",
        error instanceof Error ? error.message : error,
      );
    });
}
