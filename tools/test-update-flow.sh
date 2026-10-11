#!/bin/bash
# 一键更新流程的桩测试（假 git / 假 npm / 假 next，不需要网络）
# 用法（仓库根目录）: bash tools/test-update-flow.sh
# 用例: U1 正常更新 / U2 本地脏改动拒绝 / U3 构建失败回滚 / U4 无新提交
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
ROOT=/tmp/update-flow-test
PORT=30395
PASS=0; FAIL=0

setup() {
  rm -rf "$ROOT"; mkdir -p "$ROOT/bin" "$ROOT/stub-bin" "$ROOT/node_modules/next/dist/bin"
  cp "$REPO/bin/start-launcher.js" "$ROOT/bin/"
  cp "$REPO/bin/node-version.js" "$ROOT/bin/"

  # 假 next：打印标记 + 起 HTTP 服务 + 常驻（等待被杀）
  cat > "$ROOT/node_modules/next/dist/bin/next" <<'EOF'
#!/usr/bin/env node
console.log("FAKE-NEXT-START");
const http = require("http");
const port = Number(process.argv[process.argv.indexOf("-p") + 1] || 30395);
http.createServer((q, s) => s.end("ok")).listen(port, "127.0.0.1");
EOF
  chmod +x "$ROOT/node_modules/next/dist/bin/next"

  # 假 npm：记录调用；run build 按 FAKE_BUILD_FAIL 决定成败
  cat > "$ROOT/stub-bin/npm" <<EOF
#!/bin/bash
echo "STUB-NPM \$*" >> "$ROOT/calls.log"
case "\$*" in
  *"run build"*)
    if [ "\${FAKE_BUILD_FAIL:-}" = "1" ]; then echo "STUB-BUILD-FAILED"; exit 1; fi
    mkdir -p "$ROOT/.next"; echo "fake-build" > "$ROOT/.next/BUILD_ID"; echo "STUB-BUILD-DONE";;
esac
exit 0
EOF
  chmod +x "$ROOT/stub-bin/npm"

  # 假 git：状态/分支/HEAD/拉取/diff 全部可控
  cat > "$ROOT/stub-bin/git" <<EOF
#!/bin/bash
echo "STUB-GIT \$*" >> "$ROOT/calls.log"
case "\$*" in
  "checkout -- next-env.d.ts") exit 0;;
  "status --porcelain") [ -f "$ROOT/fake-dirty.txt" ] && cat "$ROOT/fake-dirty.txt"; exit 0;;
  "rev-parse --abbrev-ref HEAD") echo main; exit 0;;
  "rev-parse HEAD") cat "$ROOT/fake-head.txt"; exit 0;;
  "pull --ff-only origin main")
    if [ "\${FAKE_PULL_FAIL:-}" = "1" ]; then echo "STUB-PULL-FAILED"; exit 1; fi
    if [ "\${FAKE_PULL_NOCHANGE:-}" = "1" ]; then echo "STUB-PULL-NOCHANGE"; exit 0; fi
    echo "bbb222" > "$ROOT/fake-head.txt"
    sed -i 's/"version": *"[^"]*"/"version": "0.9.9"/' "$ROOT/package.json"
    echo "STUB-PULL-OK"; exit 0;;
  "diff --name-only "*) cat "$ROOT/fake-diff.txt" 2>/dev/null; exit 0;;
esac
exit 0
EOF
  chmod +x "$ROOT/stub-bin/git"

  # 基础工程文件
  printf '{"name":"update-flow-test","version":"0.0.1"}' > "$ROOT/package.json"
  printf 'source' > "$ROOT/app-file.txt"
  echo "aaa111" > "$ROOT/fake-head.txt"
  : > "$ROOT/calls.log"
  # 一个「有效且比源码新」的旧构建（含回滚标记）
  mkdir -p "$ROOT/.next"
  echo "old-build" > "$ROOT/.next/BUILD_ID"
  echo "old-marker" > "$ROOT/.next/old-marker.txt"
  touch "$ROOT/.next/.elenva-build-stamp"
}

start_launcher() {
  # 额外环境变量通过 $@ 传入。日志/pid 放 /tmp（放进仓库目录会污染「源码是否更新」的判定）。
  (cd "$ROOT" && PATH="$ROOT/stub-bin:$PATH" PORT=$PORT \
    ELENVA_UPDATE_POLL_MS=300 ELENVA_HEARTBEAT_MS=500 \
    env "$@" node bin/start-launcher.js > /tmp/update-flow-out.log 2>&1 &
   echo $! > /tmp/update-flow-launcher.pid)
  # 等假服务器就绪
  for _ in $(seq 1 50); do
    curl -s -o /dev/null "http://127.0.0.1:$PORT/" && return 0
    sleep 0.2
  done
  return 1
}

send_request() {
  printf '{"phase":"requested","requestedAt":%s,"targetVersion":"0.9.9","fromVersion":"0.0.1"}' "$(date +%s%3N)" > "$ROOT/.elenva-update.json"
}

wait_phase() {
  # $1 = 目标 phase；最多等 40s
  for _ in $(seq 1 200); do
    phase=$(python3 -c "import json;print(json.load(open('$ROOT/.elenva-update.json')).get('phase',''))" 2>/dev/null || true)
    [ "$phase" = "$1" ] && return 0
    [ "$phase" = "failed" ] && return 1
    sleep 0.2
  done
  return 1
}

stop_launcher() {
  kill "$(cat /tmp/update-flow-launcher.pid)" 2>/dev/null
  sleep 1
  pid=$(ss -ltnp 2>/dev/null | grep ":$PORT" | grep -oP 'pid=\K[0-9]+' | head -1)
  [ -n "$pid" ] && kill "$pid" 2>/dev/null
  sleep 0.3
}

check() {
  local name="$1" ok="$2"
  if [ "$ok" = "1" ]; then
    echo "PASS: $name"; PASS=$((PASS+1))
  else
    echo "FAIL: $name"; FAIL=$((FAIL+1))
    echo "--- out.log 尾部:"; tail -8 /tmp/update-flow-out.log 2>/dev/null | sed 's/^/    | /'
    echo "--- calls.log:"; sed 's/^/    | /' "$ROOT/calls.log" 2>/dev/null | tail -10
  fi
}

state_field() {
  python3 -c "import json;print(json.load(open('$ROOT/.elenva-update.json')).get('$1',''))" 2>/dev/null || true
}

# ---------------- U1 正常更新 ----------------
setup
printf 'package-lock.json\n' > "$ROOT/fake-diff.txt"
start_launcher
ok=1
[ -f "$ROOT/.elenva-launcher.json" ] || ok=0
send_request
wait_phase done || ok=0
[ "$(state_field toVersion)" = "0.9.9" ] || ok=0
grep -q "STUB-GIT pull --ff-only origin main" "$ROOT/calls.log" || ok=0
grep -q "STUB-NPM install" "$ROOT/calls.log" || ok=0
grep -q "STUB-NPM run build" "$ROOT/calls.log" || ok=0
[ "$(grep -c FAKE-NEXT-START /tmp/update-flow-out.log)" = "2" ] || ok=0
[ ! -f "$ROOT/.next/old-marker.txt" ] || ok=0
[ ! -d "$ROOT/.next.prev" ] || ok=0
curl -s -o /dev/null "http://127.0.0.1:$PORT/" || ok=0
check "U1 正常更新（拉取→安装→重建→重启→done）" "$ok"
stop_launcher

# ---------------- U2 本地脏改动拒绝 ----------------
setup
printf ' M local-note.txt\n' > "$ROOT/fake-dirty.txt"
start_launcher
ok=1
send_request
wait_phase failed || ok=0
msg=$(state_field message)
case "$msg" in *未提交改动*) ;; *) ok=0;; esac
grep -q "STUB-GIT pull" "$ROOT/calls.log" && ok=0
[ "$(grep -c FAKE-NEXT-START /tmp/update-flow-out.log)" = "1" ] || ok=0
curl -s -o /dev/null "http://127.0.0.1:$PORT/" || ok=0
check "U2 本地脏改动拒绝（不拉取、不停服）" "$ok"
stop_launcher

# ---------------- U3 构建失败回滚 ----------------
setup
printf 'package-lock.json\n' > "$ROOT/fake-diff.txt"
start_launcher FAKE_BUILD_FAIL=1
ok=1
send_request
wait_phase failed || ok=0
msg=$(state_field message)
case "$msg" in *回滚*) ;; *) ok=0;; esac
[ -f "$ROOT/.next/old-marker.txt" ] || ok=0
[ "$(grep -c FAKE-NEXT-START /tmp/update-flow-out.log)" = "2" ] || ok=0
curl -s -o /dev/null "http://127.0.0.1:$PORT/" || ok=0
check "U3 构建失败回滚（旧构建恢复、服务照常）" "$ok"
stop_launcher

# ---------------- U4 无新提交 ----------------
setup
start_launcher FAKE_PULL_NOCHANGE=1
ok=1
send_request
wait_phase done || ok=0
msg=$(state_field message)
case "$msg" in *已是最新*) ;; *) ok=0;; esac
grep -q "STUB-NPM run build" "$ROOT/calls.log" && ok=0
[ "$(grep -c FAKE-NEXT-START /tmp/update-flow-out.log)" = "1" ] || ok=0
check "U4 无新提交（直接 done，不重建）" "$ok"
stop_launcher

echo; echo "结果: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "ALL_PASS" || echo "HAS_FAILURE"
