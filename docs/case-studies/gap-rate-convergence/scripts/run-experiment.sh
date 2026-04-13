#!/usr/bin/env bash
# run-experiment.sh — 执行完整的 gap rate convergence 实验
#
# 顺序：
#   1. 应用 v0 状态（strip 4 个主题）→ 跑 omk bench run
#   2. 应用 v1 状态（部分回补）→ 跑 omk bench run
#   3. 应用 v2 状态（完整）→ 跑 omk bench run
#   4. 无论成功失败都保证恢复到 v2
#
# 输出：
#   - 三份 report JSON 到 ../reports/{v0,v1,v2}/
#   - 实时日志到 stdout

set -euo pipefail

# ---------- 路径定义 ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OMK_REPO="/Users/lizhiyao/Documents/oh-my-knowledge"
OMK_CLI="$OMK_REPO/dist/src/cli.js"
WORKSPACE="/Users/lizhiyao/Projects/workspace"
SAMPLES="$CASE_DIR/samples/gap-demo.samples.json"
REPORTS_ROOT="$CASE_DIR/reports"

# ---------- 清理保障 ----------
trap 'echo ""; echo "=== 异常退出，自动还原到 v2 ==="; node "$SCRIPT_DIR/apply-state.cjs" v2 || true' EXIT INT TERM

# ---------- 预检 ----------
if [[ ! -f "$OMK_CLI" ]]; then
  echo "ERROR: omk dist 未找到，先跑 npm run build" >&2
  exit 1
fi
if [[ ! -f "$SAMPLES" ]]; then
  echo "ERROR: samples 文件缺失: $SAMPLES" >&2
  exit 1
fi
if [[ ! -d "$WORKSPACE" ]]; then
  echo "ERROR: workspace 路径不存在: $WORKSPACE" >&2
  exit 1
fi

# ---------- 单次评测 ----------
run_one() {
  local state="$1"
  local out_dir="$REPORTS_ROOT/$state"
  mkdir -p "$out_dir"

  echo ""
  echo "============================================================"
  echo "STATE: $state"
  echo "============================================================"

  node "$SCRIPT_DIR/apply-state.cjs" "$state"

  echo ""
  echo "--- running omk bench run (state=$state) ---"
  pushd "$WORKSPACE" > /dev/null
  node "$OMK_CLI" bench run \
    --samples "$SAMPLES" \
    --skill-dir .claude/skills \
    --variants "baseline,consult" \
    --repeat 1 \
    --concurrency 2 \
    --output-dir "$out_dir" \
    --no-serve \
    --skip-preflight \
    --timeout 300
  popd > /dev/null

  echo ""
  echo "--- state=$state 完成 ---"
  ls -lh "$out_dir"/*.json 2>/dev/null | tail -3 || true
}

# ---------- 主流程 ----------
echo "============================================================"
echo "乙-step-4: gap rate convergence 实验"
echo "============================================================"
echo "workspace:   $WORKSPACE"
echo "samples:     $SAMPLES"
echo "reports:     $REPORTS_ROOT"
echo ""

run_one v0
run_one v1
run_one v2

echo ""
echo "============================================================"
echo "✓ 三个 state 全部完成"
echo "============================================================"

# 关闭 trap — 正常退出时不需要再还原
trap - EXIT INT TERM
node "$SCRIPT_DIR/apply-state.cjs" v2
