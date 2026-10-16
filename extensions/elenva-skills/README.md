# elenva-skills —— 会话里的做法，一键起草成技能

给 ELENVA 补上「值得留的做法 → 技能库」的最小闭环：**起草 → 人工确认 → 入库**。

## 它解决什么（一次真实摩擦）

会话里经常出现「这段做法值得留」的时刻（用户纠正、摸索出的流程、踩坑解法），
但沉淀成技能只能手工开文件写 SKILL.md。本扩展提供 `skill_draft` 工具：
模型把做法整理成草稿，网页侧渲染成草稿卡，用户点「保存到技能库」后才落盘。
**工具本身不写任何文件** —— 入库是人的动作，不是模型的。

## 用法

- `skill_draft(name, description, body)`：整理成技能草稿
  - `name`：小写字母 / 数字 / 连字符，≤64（例：`debug-node-esm`）
  - `description`：一句话说清「何时用这个技能」
  - `body`：SKILL.md 正文（markdown，含标题与分节；不要 frontmatter）
- 返回后，网页在助手消息里渲染成**技能草稿卡**，三档动作：
  - **保存到技能库** → `POST /api/skills/draft/save` → `~/.pi/agent/skills/<name>/SKILL.md`
    （重名 → 409，不覆盖）
  - **复制**：SKILL.md 全文写入剪贴板
  - **丢弃**：仅收起本卡，不删消息
- 入口：助手消息操作条上的「沉淀为技能」，会向会话发一条指令，让模型用本工具整理当前这条回复。

## 边界

- 只起草，不落盘；删除 / 归档技能不在本扩展职责内。
- 保存只写**全局技能库**（`<agentRoot>/skills/`），项目级技能先不做。

## 安装

```bash
node extensions/elenva-skills/install.mjs            # 安装 / 更新（复制到 <agentRoot>/extensions/elenva-skills/）
node extensions/elenva-skills/install.mjs --uninstall # 卸载
```

自检：`node extensions/elenva-skills/selftest.mjs`（纯函数层，不起会话）。
