export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

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
