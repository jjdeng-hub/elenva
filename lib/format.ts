/** 取路径最后一段（兼容 Windows 反斜杠） */
export function basename(p: string): string {
  const norm = p.replace(/[\\/]+$/, "");
  const idx = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

/** 会话列表时间标签：当天显示 HH:mm，否则 M/D */
export function timeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / M,D */
export function relTime(iso: string): string {
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return "—";
  const diff = Date.now() - d;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const day = Math.floor(h / 24);
  if (day === 1) return "昨天";
  if (day < 30) return `${day} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

/** 文件大小格式化 */
export function formatSize(n: number): string {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** token 数量格式化：1,234 / 12.6k / 3.2M */
export function formatTokens(n: number): string {
  if (!n) return "0";
  if (n < 10_000) return n.toLocaleString("en-US");
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** 时刻（时:分:秒）：过程时间线的节点时间戳 */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * 时长格式化：2.3s / 42s / 1m23s / 2h05m。
 *
 * 10 秒以内保留一位小数 —— 这个函数的两个调用场景都吃这个精度：单个工具的耗时
 * 中位数 8 秒级（全部会话样本），整秒会把「2.3s」显示成「2s」，快慢分不出来；
 * 会话活跃时长久看不会落在 10 秒内。
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  if (min < 60) return `${min}m${String(totalSec % 60).padStart(2, "0")}s`;
  const h = Math.floor(min / 60);
  return `${h}h${String(min % 60).padStart(2, "0")}m`;
}

/** 费用格式化（Pi 计价为 USD）：$0.0111 / $2.48 / $12.50 */
export function formatCost(usd: number): string {
  if (!usd) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 10) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(1)}`;
}
