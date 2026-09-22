#!/bin/sh
# 用本机 Chrome 无头模式对代表页逐视口取证，产出 <视口>/<页面>.dom.html 供 audit-summary.mjs 解析。
# 只读原型文件，不写仓库其它位置；输出目录默认在仓库外，可用 OUT_DIR 覆盖。
set -eu

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${OUT_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/omk-studio-proto-audit.XXXXXX")}"
# 视口含断点两侧：1279/1280 与 1023/1024 是 .panes 退化档的边界，必须各测一次。
VIEWPORTS="${VIEWPORTS:-1440x900 1280x800 1279x800 1024x768 1023x768 860x900 720x640 1440x620}"
PAGES="${PAGES:-index observe measure knowledge report states}"
SPECS="${SPECS:-target baseline}"

if [ ! -x "$CHROME" ]; then
  echo "找不到 Chrome：$CHROME（可用 CHROME=... 覆盖）" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
USER_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/omk-studio-proto-chrome.XXXXXX")"
trap 'rm -rf "$USER_DATA_DIR"' EXIT INT TERM

for viewport in $VIEWPORTS; do
  width="${viewport%x*}"
  height="${viewport#*x}"
  for spec in $SPECS; do
    mkdir -p "$OUT_DIR/$viewport/$spec"
    for page in $PAGES; do
    "$CHROME" \
      --headless \
      --disable-gpu \
      --no-sandbox \
      --no-first-run \
      --disable-extensions \
      --disable-background-networking \
      --user-data-dir="$USER_DATA_DIR" \
      --window-size="$width,$height" \
      --hide-scrollbars \
      --dump-dom \
      "file://$HERE/$page.html?audit=1&spec=$spec" \
      >"$OUT_DIR/$viewport/$spec/$page.dom.html" 2>/dev/null &
    chrome_pid=$!

    # --dump-dom 打印完 DOM 后可能因页面里的无限动画不退出：等到自测报告出现就收尾，
    # 最多 15 秒，避免整条取证链挂住。
    waited=0
    while [ "$waited" -lt 30 ]; do
      if grep -q 'id="audit-report"' "$OUT_DIR/$viewport/$spec/$page.dom.html" 2>/dev/null; then
        break
      fi
      sleep 0.5
      waited=$((waited + 1))
    done
    kill "$chrome_pid" 2>/dev/null || true
    wait "$chrome_pid" 2>/dev/null || true
    done
    printf '%s %s -> %s/%s/%s\n' "$viewport" "$spec" "$OUT_DIR" "$viewport" "$spec"
  done
done

echo "取证完成，汇总：node $HERE/audit-summary.mjs $OUT_DIR"
