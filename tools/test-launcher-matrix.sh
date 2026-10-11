#!/bin/bash
# start-launcher.js 的构建判定与清理测试矩阵
# 用法（仓库根目录）: bash tools/test-launcher-matrix.sh
# 用例: T1 无 .next / T2 dev 缓存 / T3 有效构建 / T4 构建过期 / T5 重建前清理 /
#       T6 构建未产出 BUILD_ID / T7 有 BUILD_ID 但无启动器成功标记（半成品）
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
  printf 'const fs=require("fs");fs.mkdirSync(".next",{recursive:true});fs.writeFileSync(".next/BUILD_ID","test-build");fs.writeFileSync(".next/.elenva-build-stamp","ok");console.log("FAKE-BUILD-DONE");' > "$ROOT/fake-build.js"
  echo "source" > "$ROOT/src/app.js"
}

run_case() {
  local name="$1" expect="$2" expect_start="${3:-yes}" must_contain="${4:-}" out built started
  out=$( (cd "$ROOT" && PORT=30398 timeout 60 node bin/start-launcher.js) 2>&1 )
  built="no"; grep -q "正在构建" <<<"$out" && built="yes"
  started="no"; grep -q "FAKE-NEXT-START" <<<"$out" && started="yes"
  local ok=1
  [ "$built" = "$expect" ] || ok=0
  [ "$started" = "$expect_start" ] || ok=0
  if [ -n "$must_contain" ]; then grep -q "$must_contain" <<<"$out" || ok=0; fi
  if [ "$ok" = "1" ]; then
    echo "PASS: $name  (build=$built start=$started)"; PASS=$((PASS+1))
  else
    echo "FAIL: $name  (expect build=$expect start=$expect_start${must_contain:+ contains=$must_contain}, got build=$built start=$started)"; FAIL=$((FAIL+1))
    echo "$out" | head -14 | sed 's/^/    | /'
  fi
}

# T1 完全没有 .next → 应构建
setup; rm -rf "$ROOT/.next"; run_case "T1 无 .next" yes

# T2 dev 缓存：.next 目录在、无 BUILD_ID、mtime 比源码新 → 应构建（回归点①）
setup; mkdir -p "$ROOT/.next"; echo "dev-cache" > "$ROOT/.next/trace"; run_case "T2 dev 缓存(无 BUILD_ID)" yes

# T3 有效构建（BUILD_ID + 启动器标记，均新于源码）→ 不应构建
setup; sleep 1; mkdir -p "$ROOT/.next"; echo "test-build" > "$ROOT/.next/BUILD_ID"; echo ok > "$ROOT/.next/.elenva-build-stamp"; run_case "T3 有效构建(新于源码)" no

# T4 有效构建但源码更新（如刚 git pull）→ 应构建
setup; mkdir -p "$ROOT/.next"; echo "test-build" > "$ROOT/.next/BUILD_ID"; echo ok > "$ROOT/.next/.elenva-build-stamp"; sleep 1; touch "$ROOT/src/app.js"; run_case "T4 构建过期(源码更新)" yes

# T5 重建前必须清空旧 .next（dev 缓存里的 .next/dev/types 会污染 next build 的类型检查，回归点②）
setup; mkdir -p "$ROOT/.next/dev/types"; echo "junk" > "$ROOT/.next/junk.txt"; echo "junk" > "$ROOT/.next/dev/types/routes.d.ts"; run_case "T5 无效 .next 重建" yes
if [ ! -e "$ROOT/.next/junk.txt" ] && [ ! -e "$ROOT/.next/dev" ]; then
  echo "PASS: T5b 旧产物已被清理"; PASS=$((PASS+1))
else
  echo "FAIL: T5b 旧产物未清理"; FAIL=$((FAIL+1))
fi

# T6 构建"成功"但没生成 BUILD_ID → 应视为失败、不启动
setup; rm -rf "$ROOT/.next"
printf 'console.log("NO-BUILD-ID");' > "$ROOT/fake-build-noid.js"
printf '{"name":"launcher-test","version":"0.0.0","scripts":{"build":"node fake-build-noid.js"}}' > "$ROOT/package.json"
run_case "T6 构建未产出 BUILD_ID" yes no "未生成构建标记"

# T7 有 BUILD_ID 但没有启动器成功标记（如上次构建中途失败/手动构建过）→ 应重建（回归点③）
setup; mkdir -p "$ROOT/.next"; echo "test-build" > "$ROOT/.next/BUILD_ID"; run_case "T7 半成品(BUILD_ID 无成功标记)" yes

echo; echo "结果: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "ALL_PASS" || echo "HAS_FAILURE"
