/**
 * 遥测 —— 本地 jsonl 追加（`<agentDir>/elenva-compact-log.jsonl`）。
 *
 * 只做一事：把每轮微压缩 / 压缩 / 失败事件按行追加落盘，供事后观察与第 1 轮任务的
 * 隔离验证读数。写失败静默吞掉（遥测不该影响会话），但通过 onTelemetryError 回调
 * 暴露给 index.ts 做一次性提示。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const TELEMETRY_FILENAME = "elenva-compact-log.jsonl";

export function resolveAgentDir(): string {
	if (process.env.PI_CODING_AGENT_DIR) return path.resolve(process.env.PI_CODING_AGENT_DIR);
	return path.join(os.homedir(), ".pi", "agent");
}

export function telemetryPath(agentDir = resolveAgentDir()): string {
	return path.join(agentDir, TELEMETRY_FILENAME);
}

export interface TelemetryEvent {
	/** ISO 时间戳 */
	ts: string;
	kind: "microcompact" | "compact" | "compact_failed";
	sessionId?: string;
	/** 事件负载（微压缩：tools/tokensSaved；压缩：reason/pre/post/usage/ms） */
	[key: string]: unknown;
}

let hasWarned = false;

/** 追加一行遥测；全程容错，任何写失败都不抛。 */
export function appendTelemetry(event: TelemetryEvent, opts?: { agentDir?: string }): void {
	try {
		const dir = opts?.agentDir ?? resolveAgentDir();
		fs.mkdirSync(dir, { recursive: true });
		fs.appendFileSync(path.join(dir, TELEMETRY_FILENAME), `${JSON.stringify(event)}\n`, "utf8");
	} catch (error) {
		if (!hasWarned) {
			hasWarned = true;
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[elenva-compact] 遥测写入失败（后续同类错误不再提示）：${message}`);
		}
	}
}

/** 便捷构造：现在时间戳 + kind + 负载。 */
export function makeTelemetryEvent(
	kind: TelemetryEvent["kind"],
	sessionId: string | undefined,
	payload: Record<string, unknown>,
): TelemetryEvent {
	return { ts: new Date().toISOString(), kind, sessionId, ...payload };
}
