/**
 * UI 自己实现的「内置斜杠命令」。
 *
 * 为什么单独列出来：内核的 `get_commands` 只返回**扩展 / 技能 / 提示模板**注册的命令，
 * 而 /compact、/clone 这些是我们在 handleBuiltinSlashCommand 里自己实现的 ——
 * 它们既不在内核的返回里，也就从来没出现在 `/` 菜单中（实测：`/` 弹出空列表）。
 *
 * 这里是单一来源：菜单展示与实际执行的分支都以此为准。
 * 新增内置命令时改这里 + handleBuiltinSlashCommand 的分支即可。
 */
export interface BuiltinSlashCommand {
  name: string;
  description: string;
}

export const BUILTIN_SLASH_COMMANDS: BuiltinSlashCommand[] = [
  { name: "compact", description: "压缩上下文，释放上下文窗口" },
  { name: "session", description: "查看本会话统计（token / 成本 / 上下文占用）" },
  { name: "name", description: "用模型为会话生成标题" },
  { name: "clone", description: "克隆本会话为一个新会话" },
  { name: "copy", description: "复制上一条助手回复" },
  { name: "reload", description: "热重载扩展、技能、提示模板与上下文文件" },
];

/**
 * 把内置命令合并进内核返回的命令列表。
 * 内置优先：`/reload` 这类同名项由我们自己的实现处理，避免菜单里出现两条一样的。
 */
export function mergeBuiltinSlashCommands<T extends { name: string }>(
  kernelCommands: T[],
): ({ name: string; description: string; source: "builtin" } | T)[] {
  const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map((c) => c.name));
  return [
    ...BUILTIN_SLASH_COMMANDS.map((c) => ({ ...c, source: "builtin" as const })),
    ...kernelCommands.filter((c) => !builtinNames.has(c.name)),
  ];
}
