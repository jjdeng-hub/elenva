#!/bin/bash
# dev-launcher.js 的桩测试（不需要真实 next、不联网）
# 用法（仓库根目录）: bash tools/test-dev-launcher.sh
# 用例: D1 正常启动（不构建）/ D2 已在运行 / D3 依赖缺失自动安装
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
ROOT=/tmp/dev-launcher-test
PASS=0; FAIL=0

fake_next_src() {
  cat <<'EOF'
#!/usr/bin/env node
// 假 dev 服务器：打印参数、监听端口、约 6 秒后自行退出
console.log("FAKE-NEXT-DEV " + process.argv.slice(2).join(" "));
const http = require("http");
const args = process.argv;
const portIndex = args.indexOf("-p");
const port = Number(portIndex >= 0 ? args[portIndex + 1] : 30299);
const server = http.createServer((req, res) => { res.end("ok"); });
server.listen(port, "127.0.0.1", () => console.log("Ready in 1ms"));
setTimeout(() => { server.close(() => process.exit(0)); }, 6000);
EOF
}

setup() {
  rm -rf "$ROOT"; mkdir -p "$ROOT/bin" "$ROOT/node_modules/next/dist/bin"
  cp "$REPO/bin/dev-launcher.js" "$ROOT/bin/"
  cp "$REPO/bin/node-version.js" "$ROOT/bin/"
  fake_next_src > "$ROOT/fake-next.js"
  cp "$ROOT/fake-next.js" "$ROOT/node_modules/next/dist/bin/next"
  printf '{"name":"dev-launcher-test","version":"0.0.0"}' > "$ROOT/package.json"
}

check() {
  local name="$1" out="$2" ok="$3"
  if [ "$ok" = "1" ]; then
    echo "PASS: $name"; PASS=$((PASS+1))
  else
    echo "FAIL: $name"; FAIL=$((FAIL+1))
    echo "$out" | head -12 | sed 's/^/    | /'
  fi
}

# D1 正常启动：起服务 → 就绪 → 打开浏览器（且不做任何构建）
setup
out=$( (cd "$ROOT" && PORT=30398 timeout 40 node bin/dev-launcher.js) 2>&1 )
ok=1
grep -q "正在启动开发服务（端口 30398" <<<"$out" || ok=0
grep -q "FAKE-NEXT-DEV dev -H 127.0.0.1 -p 30398" <<<"$out" || ok=0
grep -q "已就绪 → http://127.0.0.1:30398" <<<"$out" || ok=0
grep -q "正在构建" <<<"$out" && ok=0
check "D1 正常启动（不构建、就绪、开浏览器）" "$out" "$ok"

# D2 已在运行：只提示 + 打开浏览器，不重复启动
setup
node -e 'require("http").createServer((q,s)=>s.end("x")).listen(30397,"127.0.0.1")' >/dev/null 2>&1 &
SRV_PID=$!
sleep 0.6
out=$( (cd "$ROOT" && PORT=30397 timeout 20 node bin/dev-launcher.js) 2>&1 )
kill "$SRV_PID" 2>/dev/null
wait "$SRV_PID" 2>/dev/null
ok=1
grep -q "开发模式已在运行 → http://127.0.0.1:30397" <<<"$out" || ok=0
grep -q "FAKE-NEXT-DEV" <<<"$out" && ok=0
check "D2 已在运行（不重复启动）" "$out" "$ok"

# D3 依赖缺失 → 自动安装后启动（stub npm 造出假的 next）
setup; rm -rf "$ROOT/node_modules"; mkdir -p "$ROOT/stub-bin"
cat > "$ROOT/stub-bin/npm" <<EOF
#!/bin/bash
echo "STUB-NPM \$*"
mkdir -p "$ROOT/node_modules/next/dist/bin"
cp "$ROOT/fake-next.js" "$ROOT/node_modules/next/dist/bin/next"
EOF
chmod +x "$ROOT/stub-bin/npm"
out=$( (cd "$ROOT" && PATH="$ROOT/stub-bin:$PATH" PORT=30396 timeout 40 node bin/dev-launcher.js) 2>&1 )
ok=1
grep -q "正在安装 npm 依赖" <<<"$out" || ok=0
grep -q "STUB-NPM install" <<<"$out" || ok=0
grep -q "已就绪 → http://127.0.0.1:30396" <<<"$out" || ok=0
check "D3 依赖缺失自动安装" "$out" "$ok"

echo; echo "结果: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "ALL_PASS" || echo "HAS_FAILURE"
