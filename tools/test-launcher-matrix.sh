#!/bin/bash
# start-launcher.js 的构建判定测试矩阵（四态）
# 用法（仓库根目录）: bash tools/test-launcher-matrix.sh
# 四态: T1 无 .next / T2 dev 缓存(无 BUILD_ID) / T3 有效构建 / T4 构建过期
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LAUNCHER="${1:-$REPO/bin/start-launcher.js}"
ROOT=/tmp/launcher-test
PASS=0; FAIL=0

setup() {
  rm -rf "$ROOT"; mkdir -p "$ROOT/bin" "$ROOT/src" "$ROOT/node_modules/next/dist/bin"
  cp "$LAUNCHER" "$ROOT/bin/start-launcher.js"
  cp "$REPO/bin/node-version.js" "$ROOT/bin/"
  printf '#!/usr/bin/env node\nconsole.log("FAKE-NEXT-START");\nprocess.exit(0);\n' > "$ROOT/node_modules/next/dist/bin/next"
  chmod +x "$ROOT/node_modules/next/dist/bin/next"
  printf '{"name":"launcher-test","version":"0.0.0","scripts":{"build":"node fake-build.js"}}' > "$ROOT/package.json"
  printf 'const fs=require("fs");fs.mkdirSync(".next",{recursive:true});fs.writeFileSync(".next/BUILD_ID","test-build");console.log("FAKE-BUILD-DONE");' > "$ROOT/fake-build.js"
  echo "source" > "$ROOT/src/app.js"
}

run_case() {
  local name="$1" expect="$2" out built started
  out=$( (cd "$ROOT" && PORT=30398 timeout 60 node bin/start-launcher.js) 2>&1 )
  built="no"; grep -q "正在构建" <<<"$out" && built="yes"
  started="no"; grep -q "FAKE-NEXT-START" <<<"$out" && started="yes"
  if [ "$built" = "$expect" ]; then
    echo "PASS: $name  (build=$built start=$started)"; PASS=$((PASS+1))
  else
    echo "FAIL: $name  (expect build=$expect, got build=$built, start=$started)"; FAIL=$((FAIL+1))
    echo "$out" | head -12 | sed 's/^/    | /'
  fi
}

# T1 完全没有 .next → 应构建
setup; rm -rf "$ROOT/.next"; run_case "T1 无 .next" yes

# T2 dev 缓存：.next 目录在、无 BUILD_ID、mtime 比源码新 → 应构建（回归点）
setup; mkdir -p "$ROOT/.next"; echo "dev-cache" > "$ROOT/.next/trace"; run_case "T2 dev 缓存(无 BUILD_ID)" yes

# T3 有效构建且比源码新 → 不应构建
setup; sleep 1; mkdir -p "$ROOT/.next"; echo "test-build" > "$ROOT/.next/BUILD_ID"; run_case "T3 有效构建(新于源码)" no

# T4 有效构建但源码更新（如刚 git pull）→ 应构建
setup; mkdir -p "$ROOT/.next"; echo "test-build" > "$ROOT/.next/BUILD_ID"; sleep 1; touch "$ROOT/src/app.js"; run_case "T4 构建过期(源码更新)" yes

echo; echo "结果: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "ALL_PASS" || echo "HAS_FAILURE"
