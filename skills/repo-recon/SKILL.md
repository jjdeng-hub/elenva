---
name: repo-recon
description: 接手陌生代码库/目录时的侦察方法——先读懂结构、入口、约定和活跃面，再决定动手；含远程仓库"不克隆直接读"的配方。Use when starting work in an unfamiliar repository, before changing code you have not explored, or when asked to understand/summarize a project.
---

# 代码库侦察（动手前先读懂）

目标：在改任何东西之前，能回答"这个项目的入口在哪、约定是什么、我该动哪里"。

## 顺序（从便宜到贵）

1. **读门面文件**：`README.md` → `AGENTS.md` / `CLAUDE.md`（项目给 agent 的规矩，优先级最高）
   → `package.json` / `Makefile` / `pyproject.toml`（入口脚本、检查门）。
2. **看结构**：`ls` 顶层 + `find . -maxdepth 2 -type d | head -40`（跳过 node_modules/.git）。
3. **找入口**：从"程序从哪里启动"追起（bin 字段、main、app/ 目录、cmd/ 目录）。
4. **看活跃面**：`git log --oneline -20`——最近在改哪里，哪里就是重点。
5. **找真相源头**：别停在"看起来像"的文件；追数据流：谁调用谁、状态存在哪、副作用发生在哪。
6. **按需搜索**：`rg <关键词>`（没有 rg 用 `grep -rn`）；先搜定义，再搜调用点。

## 远程仓库不克隆也能读

- 仓库元信息：`curl -s https://api.github.com/repos/<owner>/<repo>`
- 目录列表：`curl -s https://api.github.com/repos/<owner>/<repo>/contents/<path>`
- 读文件：`https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>`
  - 本机实测直连不通 → 直接走代理：`https://gh-proxy.com/https://raw.githubusercontent.com/...`
- 需要整仓操作（改、跑）时再克隆；git 的网络问题见 git-workflow 技能。

## 输出

一页纸侦察结论：结构（顶层目录各干什么）· 入口 · 关键约定 · 风险点 · 建议动刀的位置。
不要输出文件清单的复读。

## 反模式

- 没读完门面文件就开始改代码
- 只 grep 了表面符号，没追调用链
- 把"文件里写了 X"当成"系统行为是 X"（要跑、或读调用方才能确认）
