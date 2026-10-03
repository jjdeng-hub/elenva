# 内置起步技能（starter skills）

给 ELENVA 的 agent（Elen）开箱即用的第一批技能：**通用、公开安全、随仓库分发**。

- 格式：每个子目录一个技能，`SKILL.md` 为入口（Agent Skills 标准，pi 内核原生支持）。
- 安装：`node skills/install.mjs`（复制到 `<agentDir>/skills/`，默认 `~/.pi/agent/skills/`）。
- 卸载：`node skills/install.mjs --uninstall`（只删本仓库管理的这几个）。
- 与「个人技能」的区别：本目录是**仓库内置**的通用技能；本机个人/私有技能放在
  `.pi/skills/` 或 `~/.pi/agent/skills/`，**不进仓库**（见 AGENTS.md 仓库边界）。
- 附带好处：仓库根目录的 `skills/` 同时是 pi 包的约定目录——`pi install` 本仓库时
  这些技能会自动随包分发。

## 当前技能

| 技能 | 用途 |
|---|---|
| plan-first | 非平凡改动先出方案再动手 |
| repo-recon | 陌生代码库的侦察法（含远程仓库读取） |
| verify-before-claim | 验证纪律：证据先于结论 |
| git-workflow | 分支/提交/推送（含国内网络绕行） |
| web-research | 用 curl 做检索与抓取的可靠配方 |
| doc-extract | PDF / Word / Excel 文本提取 |
