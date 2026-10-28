# Agent 应用包（不随本仓库开源）

**平台开源，Agent 私有。** 这个目录只放约定与模板，不放任何具体的业务 Agent。

## 应用包放在哪

默认读用户目录：

```
~/.elenva/agents/<agent-id>/manifest.json
```

可用环境变量改根目录（多套 Agent 集合、或把私有 Agent 放在另一个盘）：

```bash
ELENVA_AGENTS_DIR=D:\Agents hermes start
```

每个子目录是一个应用包，**目录名必须等于 manifest 里的 `id`**。坏包不会让工作台打不开：
它会被跳过，并在 `/api/agents` 的 `errors` 里留下一条原因。

## manifest.json 最小形状

```json
{
  "id": "house",
  "name": "装修 Agent",
  "description": "预算、决策与施工阶段",
  "icon": "🏠",
  "runtime": "hermes",
  "version": "0.1.0",
  "panels": ["budget", "decisions", "phases"],
  "capabilities": { "growth": false, "schedules": true },
  "dataDir": "data"
}
```

字段说明：

- `id`：小写字母 / 数字 / 连字符，≤64，必须与目录名一致。稳定键，改显示名不要改它。
- `runtime`：`pi`（进程内 SDK）或 `hermes`（ACP 子进程，P1 接入）。缺省 `pi`。
- `panels`：声明式面板 id。P0 只展示，不渲染。
- `capabilities`：平台面板开关（如 `growth` / `subagents`），只接受布尔值。
- `dataDir`：应用包自己的数据目录（相对包根），P1 起供面板读取。

## 为什么不在仓库里

本仓库会开源，且隐私审计按全历史算。具体 Agent 里通常带业务口径、客户信息、
本机路径与个人偏好，这些不该出现在平台的公开历史里。把 Agent 放在用户目录或
它们自己的私有仓库，平台只保留**加载器 + 契约 + 模板**。

## 内置 Agent

`justin`（编码 Agent）是平台自带的，写在 `lib/agents/manifest.ts` 里，不占用户目录，
也不允许被同名应用包覆盖（注册表会把冲突记进 `errors`）。
