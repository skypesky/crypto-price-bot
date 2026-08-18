#!/usr/bin/env bash
# CI 工作流契约检查 —— 防止关键步骤被无意中删掉。
#
# 历史教训：2026-08-17 的 price-report.yml 漏掉 "Build server" 步骤，
# CI 在 node dist/index.js 阶段 MODULE_NOT_FOUND 崩溃。
#
# 这个脚本作为回归测试：一旦 workflow 缺失以下任一关键步骤，立即失败。
# 可以 `make check.ci` 本地跑，也可以在 CI 中作为第一道关卡。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/price-report.yml"

if [[ ! -f "$WORKFLOW" ]]; then
  echo "❌ workflow not found: $WORKFLOW"
  exit 1
fi

fail() { echo "❌ $1"; exit 1; }
pass() { echo "✓ $1"; }

# 检查 1: 必须存在 server 的构建步骤
# 匹配 "Build server" 或同义名（"Compile server" / "tsc server"）
if ! grep -qE 'name:[[:space:]]*(Build|Compile)[[:space:]]+server' "$WORKFLOW"; then
  fail "workflow missing 'Build server' step — node dist/index.js will MODULE_NOT_FOUND"
fi
pass "workflow contains server build step"

# 检查 2: 必须存在运行测试的步骤
# 匹配 "Run tests" / "Test" / "npm test" / "npm ci && npm test"
if ! grep -qE '(npm[[:space:]]+(ci[[:space:]]+&&[[:space:]]+)?test|make[[:space:]]+test)' "$WORKFLOW"; then
  fail "workflow missing test step — regressions will not be caught"
fi
pass "workflow contains test step"

# 检查 3: 构建步骤必须在 "node dist/index.js" 之前
# （粗略检查：用 awk 看两个 name 出现的相对顺序）
if ! awk '
  /name:[[:space:]]*(Build|Compile)[[:space:]]+server/ { build=NR }
  /node[[:space:]]+dist\/index\.js/                     { run=NR }
  END { exit !(build && run && build < run) }
' "$WORKFLOW"; then
  fail "workflow order wrong — 'Build server' must precede 'node dist/index.js'"
fi
pass "workflow step order: build server → run dist/index.js"

echo ""
echo "✅ All CI contract checks passed."