#!/bin/bash
# elenva-gates-wrapper.sh —— 隔离门禁巡检的包装脚本（**安装模板，本文件不会被自动部署**）。
#
# 用途：替换 /root/.hermes/scripts/elenva-gates.sh（原脚本直接在真实工作区跑
# `git checkout -- .`，会抹掉未提交改动，且失败恒 exit 0）。本模板把巡检交给
# `tools/gates-isolated.mjs`：在固定提交的临时快照上跑，绝不触碰工作区。
#
# 对外接口与原脚本保持一致（cron no_agent 模式）：
#   · 只在 main 有新提交时跑（--if-changed 读同一个状态文件）
#   · 全绿静默（无 stdout、exit 0）
#   · 失败时把告警文本打到 stdout（cron 投递）
#   · 退出码固定 0（不改变 cron 语义；真实结论在 stdout 与状态文件里）
#
# 部署步骤 / 备份 / 回滚见：/root/content/elenva-work/module3-review/
#
# 可覆盖的环境变量：
#   ELENVA_GATES_REPO  仓库路径（默认 /root/elenva）
#   ELENVA_GATES_REF   巡检的 ref（默认 main）
#   ELENVA_GATES_STATE 状态文件（默认 /root/.hermes/elenva-gates-state.json）
#   ELENVA_GATES_LOG   日志目录（默认 /tmp/elenva-gates）
#   ELENVA_GATES_NODE  node 可执行文件（默认 node）

set -uo pipefail

REPO="${ELENVA_GATES_REPO:-/root/elenva}"
REF="${ELENVA_GATES_REF:-main}"
STATE="${ELENVA_GATES_STATE:-/root/.hermes/elenva-gates-state.json}"
LOG="${ELENVA_GATES_LOG:-/tmp/elenva-gates}"
NODE="${ELENVA_GATES_NODE:-node}"
TOOL="$REPO/tools/gates-isolated.mjs"

if [ ! -f "$TOOL" ]; then
  echo "❌ elenva-gates：找不到隔离巡检实现 $TOOL（升级未完成？）"
  exit 0
fi

# --cron：skipped（无新提交）折成退出码 0 且不输出，保持静默巡检语义
"$NODE" "$TOOL" --repo "$REPO" --ref "$REF" --state "$STATE" --log-dir "$LOG" --if-changed --cron

# 与旧脚本一致：cron 只看 stdout，退出码固定 0
exit 0
