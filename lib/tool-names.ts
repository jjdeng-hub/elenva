/**
 * Tool-name predicates shared by the chat views.
 *
 * Pi's built-in names are plain `write` / `edit`, but MCP servers expose the
 * same operations under prefixed or namespaced names, so each predicate also
 * accepts the common decorated forms.
 */

export function isWriteToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "write" ||
    name.startsWith("write_") ||
    name.endsWith(".write") ||
    name.endsWith("_write");
}

export function isEditToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "edit" ||
    name.startsWith("edit_") ||
    name.endsWith(".edit") ||
    name.endsWith("_edit") ||
    name.includes("str_replace") ||
    name.includes("replace_editor");
}

export function isBashToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "bash" ||
    name === "shell" ||
    name === "powershell" ||
    name.startsWith("bash_") ||
    name.endsWith(".bash") ||
    name.endsWith("_bash") ||
    name.endsWith("_shell");
}

/**
 * `mcp__<server>__<tool>` → { server, tool }；非 MCP 名返回 null。
 * 内核把 MCP 工具注册为 `mcp__<server>__<tool>`（字符规范化：非字母数字→下划线），
 * 展示层用它把长名字拆成「服务器 · 工具」。
 */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice("mcp__".length);
  const sep = rest.indexOf("__");
  if (sep <= 0 || sep + 2 >= rest.length) return null;
  return { server: rest.slice(0, sep).replace(/_/g, "-"), tool: rest.slice(sep + 2) };
}
