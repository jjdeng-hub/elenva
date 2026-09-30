# elenva-todo —— 会话内任务清单（任务拆解）

给 Elen 的「外部记忆」：多步骤任务先拆解成清单，边做边翻状态，用户与模型都能随时看到进行到哪一步。

## 机制

1. **`todo_write` 工具**：模型全量提交清单（每项 `{text, status}`）。校验在代码侧：≤20 项、文本 ≤160 字、
   同一时刻仅一项 `in_progress`。校验失败 → 清单保持原样，模型收到错误说明后修正重提。
2. **状态注入**（`context` 钩子）：每轮 LLM 调用前，把当前清单作为 `<elenva_todos>` user 消息追加到上下文
   末尾；先摘掉上一轮注入的那条（实现一：每轮替换，只在短后缀上失效缓存）。
3. **`/todos` 命令**：CLI 里随时查看当前清单。

状态存在 tool result details 里（不是外部文件）——切分支 / 回滚时清单自动跟随该分支的历史，与内核
`examples/extensions/todo.ts` 同一机制。

## 依据（docs/agent-design-standard.md）

- ch2 **L912 任务规划**：TODO 列表把任务分解成清晰步骤、放在轨迹末尾持续提醒（对治目标偏离）。
- ch2 **L924**：状态栏以 user 消息注入上下文末尾；**L955 实现一（每轮替换）**。
- ch2 **L963-971（实验 2-9）**：TODO 作为外部记忆，启用后平均 15 次迭代完成任务（禁用 21 次、常漏步骤）。
- 与实验版的取舍（单工具 vs 双工具、三状态 vs 四状态含 cancelled）记录在
  `docs/agent-design-standard.md`「偏离登记」。

## 安装与自检

```bash
node extensions/elenva-todo/install.mjs   # 安装 / 更新到 <agentRoot>/extensions/elenva-todo/
node extensions/elenva-todo/selftest.mjs  # 纯函数自检（不装扩展、不起会话、不调模型）
```

环境变量：`ELENVA_TODO_STATUS_BUDGET`（注入块字符预算，默认 400；`0` 或 `off` = 关闭注入）。

## 与 elenva-worklog 的分工

`elenva-worklog` = 跨会话的项目工作记录（情景记忆的当前段）；`elenva-todo` = **当前会话**这一件多步任务的
执行清单。两者都走「末尾 user 消息注入」，各认各的标记（`<agent_status>` / `<elenva_todos>`），互不干扰。