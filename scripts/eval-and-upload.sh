#!/usr/bin/env bash
#
# eval-and-upload.sh — 克隆一个 skill 仓库，用 omk 生成评测报告，并把报告上报到 AIMA。
#
# 用法:
#   scripts/eval-and-upload.sh <git-url> [branch]
#
# 示例:
#   scripts/eval-and-upload.sh git@code.alipay.com:aima-skill-package/xiaoling-baoxiankeji004.git
#   scripts/eval-and-upload.sh git@code.alipay.com:aima-skill-package/xiaoling-baoxiankeji004.git main
#
# 流程(对齐语雀《小灵 Skill 评测指南》 https://yuque.antfin.com/aima/doc/pu0gtt5ild8sm37c):
#   1. git clone 传入的 skill 仓库
#   2. 过滤官方 skill —— 从 official 仓库 skills.json 读官方清单，把克隆副本里命中
#                       的官方 skill 删掉，评测只跑业务自建 skill
#   3. omk sample  —— 为缺用例的 skill 自动生成评测用例(写进仓库 .omk/，不入数据目录)
#   4. omk doctor  —— skill 写法健康检查
#   4. omk eval    —— 用例驱动模型执行 + 评委打分，产出评测报告
#   5. 上报        —— 按 kind(doctor / evaluation / observe-inbox)过滤字段后，POST 到
#                     AIMA omkReportUpload 接口。
#
# 怎么"只上报本批次"的报告(关键)：
#   - eval 支持 --output-dir：本批次 eval 报告全部写进一个专属目录 $BATCH_DIR，
#     扫描该目录即本批次产物，零歧义。
#   - doctor 不支持自定义目录(源码写死 ~/.oh-my-knowledge/doctors)，且默认执行器
#     claude 依赖 ~/.claude 鉴权，不能用改 HOME 的方式隔离。所以 doctor 用"跑前/跑后
#     文件名快照做差集"识别本批次新增的报告。
#
# 上报逻辑(接口 / token / payload 结构 / 字段过滤)复刻自 skill-sync 的 _omk_upload.py。
#
# 环境变量:
#   OMK_UPLOAD_URL    上报接口，默认 https://inslightbuildbff.alipay.com/ai/needle/omkReportUpload
#   OMK_UPLOAD_TOKEN  上报 token(默认沿用 skill-sync 内置 token)
#   OMK_AGENT_NAME    上报归属 agent 名(中文，如 小灵-保险科技004)。必填:不设则运行时
#                     交互提示输入;非交互环境(无 TTY)未设会直接报错退出。
#   OMK_REPO_NAME     上报归属 repo 名，默认取 git url 仓库名(已是拼音化，与真实
#                     name_to_repo(agent_name) 约定一致)
#   OMK_HOME          omk 数据目录，默认 ~/.oh-my-knowledge
#   OMK_MODEL         被测模型，默认沿用 omk 默认值(sonnet)
#   OMK_SKILL_SUBDIR  仓库内 skill 根目录，默认自动探测(优先 skills/，否则仓库根)
#   OMK_OFFICIAL_REPO        官方清单仓库，默认 git@code.alipay.com:aima-skill-package/official.git
#   OMK_OFFICIAL_BRANCH      官方清单分支，默认 main
#   OMK_OFFICIAL_SKILLS_FILE 本地 skills.json 路径(设置后跳过克隆，直接读它)
#   OMK_ONLY_SKILLS   逗号分隔白名单:只评测这些 skill(按目录名或 frontmatter name 匹配)，
#                     其余连同官方一并跳过。用于"只测一个/几个"。
#   OMK_SAMPLE_COUNT  传给 omk sample --count，限制每个 skill 生成的样本条数(测试时省 token)。
#   OMK_KEEP_CLONE    设为 1 则保留克隆目录(默认评测完删除)
#   OMK_KEEP_BATCH    设为 1 则保留本批次 eval 报告目录(默认上报完删除)
#   OMK_UPLOAD_DRY_RUN 设为 1 则只打印待上报报告，不实际发请求
#
set -euo pipefail

# ---------- 参数 ----------
GIT_URL="${1:-}"
BRANCH="${2:-}"
if [[ -z "$GIT_URL" ]]; then
  echo "用法: $0 <git-url> [branch]" >&2
  echo "示例: $0 git@code.alipay.com:aima-skill-package/xiaoling-baoxiankeji004.git" >&2
  exit 2
fi

OMK_HOME="${OMK_HOME:-$HOME/.oh-my-knowledge}"
DOCTORS_DIR="$OMK_HOME/doctors"
UPLOAD_URL="${OMK_UPLOAD_URL:-https://inslightbuildbff.alipay.com/ai/needle/omkReportUpload}"
UPLOAD_TOKEN="${OMK_UPLOAD_TOKEN:-19715bb371b74685fd5e85625fb2703bc28b60bba5f984150e3f473a42a8f7fa}"

log() { printf '\033[1;36m[eval-upload]\033[0m %s\n' "$*" >&2; }
err() { printf '\033[1;31m[eval-upload]\033[0m %s\n' "$*" >&2; }

command -v omk     >/dev/null 2>&1 || { err "未找到 omk，请先安装: tnpm i oh-my-knowledge -g"; exit 1; }
command -v git     >/dev/null 2>&1 || { err "未找到 git"; exit 1; }
command -v python3 >/dev/null 2>&1 || { err "未找到 python3"; exit 1; }

# 从 git url 推导仓库名(去掉 .git 后缀和路径前缀)
REPO_SLUG="$(basename "$GIT_URL")"; REPO_SLUG="${REPO_SLUG%.git}"
REPO_NAME="${OMK_REPO_NAME:-$REPO_SLUG}"
# agent_name 必须是中文显示名(上报归属);运行时由用户提供:OMK_AGENT_NAME 优先，否则交互输入。
AGENT_NAME="${OMK_AGENT_NAME:-}"
if [[ -z "$AGENT_NAME" ]]; then
  if [[ -t 0 ]]; then
    printf '请输入 agent 名称(中文，如 小灵-保险科技004): ' >&2
    IFS= read -r AGENT_NAME
  fi
fi
# 去掉首尾空白
AGENT_NAME="${AGENT_NAME#"${AGENT_NAME%%[![:space:]]*}"}"
AGENT_NAME="${AGENT_NAME%"${AGENT_NAME##*[![:space:]]}"}"
[[ -n "$AGENT_NAME" ]] || { err "必须提供 agent 名称(设环境变量 OMK_AGENT_NAME 或在交互终端输入)"; exit 2; }
BATCH_ID="${REPO_SLUG}-$(date +%Y%m%d-%H%M%S)"

# ---------- 工作目录 ----------
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/omk-eval-XXXXXX")"
CLONE_DIR="$WORK_DIR/$REPO_SLUG"
# 本批次 eval 报告专属目录(放在数据目录下，便于 omk studio --reports-dir 查看)
BATCH_DIR="$OMK_HOME/batches/$BATCH_ID"
mkdir -p "$BATCH_DIR"

cleanup() {
  if [[ "${OMK_KEEP_CLONE:-0}" == "1" ]]; then log "保留克隆目录: $CLONE_DIR"; else rm -rf "$WORK_DIR"; fi
  if [[ "${OMK_KEEP_BATCH:-0}" == "1" ]]; then
    log "保留本批次报告目录: $BATCH_DIR (查看: omk studio --reports-dir \"$BATCH_DIR\")"
  else
    rm -rf "$BATCH_DIR"
  fi
}
trap cleanup EXIT

log "克隆仓库 $GIT_URL ..."
if [[ -n "$BRANCH" ]]; then
  git clone --depth 1 --branch "$BRANCH" "$GIT_URL" "$CLONE_DIR"
else
  git clone --depth 1 "$GIT_URL" "$CLONE_DIR"
fi

# ---------- 探测 skill 根目录 ----------
if [[ -n "${OMK_SKILL_SUBDIR:-}" ]]; then
  SKILL_DIR="$CLONE_DIR/$OMK_SKILL_SUBDIR"
elif [[ -d "$CLONE_DIR/skills" ]]; then
  SKILL_DIR="$CLONE_DIR/skills"
else
  SKILL_DIR="$CLONE_DIR"
fi
[[ -d "$SKILL_DIR" ]] || { err "skill 目录不存在: $SKILL_DIR"; exit 1; }
log "skill 根目录: $SKILL_DIR"
log "本批次 eval 报告目录: $BATCH_DIR"

# ---------- 过滤官方 skill ----------
# 官方 skill 由 AIMA 统一维护，不在业务仓库评测范围内。先拿到官方清单，再把克隆副本里
# 命中的官方 skill 删掉(克隆是一次性的，直接删最干净，batch 扫描自然就跳过了)。
OFFICIAL_FILE="${OMK_OFFICIAL_SKILLS_FILE:-}"
if [[ -z "$OFFICIAL_FILE" ]]; then
  OFFICIAL_REPO="${OMK_OFFICIAL_REPO:-git@code.alipay.com:aima-skill-package/official.git}"
  OFFICIAL_BRANCH="${OMK_OFFICIAL_BRANCH:-main}"
  OFFICIAL_DIR="$WORK_DIR/official"
  log "拉取官方 skill 清单 $OFFICIAL_REPO ..."
  git clone --depth 1 --branch "$OFFICIAL_BRANCH" "$OFFICIAL_REPO" "$OFFICIAL_DIR" \
    || { err "克隆官方清单仓库失败；如需跳过过滤可设 OMK_OFFICIAL_SKILLS_FILE 指向本地 skills.json"; exit 1; }
  OFFICIAL_FILE="$OFFICIAL_DIR/skills.json"
fi
[[ -f "$OFFICIAL_FILE" ]] || { err "官方清单文件不存在: $OFFICIAL_FILE"; exit 1; }

log "按官方清单过滤 skill ..."
# 注意:把 python 写到临时文件再执行，不要把 `python3 - <<'PY'` 放进 $(...) 命令替换里——
# macOS 自带 bash 3.2 对 "命令替换内嵌 quoted heredoc" 解析有 bug 会报 EOF。
PRUNE_PY="$WORK_DIR/prune.py"
cat > "$PRUNE_PY" <<'PY'
import json, os, re, shutil, sys

SKILL_DIR = os.environ["SKILL_DIR"]
d = json.load(open(os.environ["OFFICIAL_FILE"], encoding="utf-8"))

# 收集官方 skill 名:顶层 skills[].name + 任意嵌套的 skills 数组(levels/claudeLevels 等)
official = set()
def add(n):
    if isinstance(n, str) and n.strip():
        official.add(n.strip().lower())
def walk(o):
    if isinstance(o, dict):
        for k, v in o.items():
            if k == "skills" and isinstance(v, list):
                for s in v:
                    if isinstance(s, str): add(s)
                    elif isinstance(s, dict): add(s.get("name") or s.get("id") or s.get("skillName") or s.get("slug"))
            else:
                walk(v)
    elif isinstance(o, list):
        for x in o: walk(x)
walk(d)

# 读 SKILL.md frontmatter 的 name 字段:这才是 skill 的规范身份(目录名可能与之不符，
# 例如 FILES/ 实为 ticket-analysis、mobileflow/ 实为官方 mobileflow-test)。
def frontmatter_name(md_path):
    try:
        text = open(md_path, encoding="utf-8", errors="replace").read()
    except OSError:
        return None
    m = re.match(r'^---\s*\n(.*?)\n---', text, re.S)
    if not m:
        return None
    nm = re.search(r'^name:\s*(.+?)\s*$', m.group(1), re.M)
    return nm.group(1).strip().strip('"\'') if nm else None

# OMK_ONLY_SKILLS:逗号分隔的白名单(按目录名或 frontmatter name 匹配)。设了就只保留
# 名单内的 skill，其余(连同官方)一并删掉。主要用于"只测一个/几个" skill。
only = {s.strip().lower() for s in os.environ.get("OMK_ONLY_SKILLS", "").split(",") if s.strip()}

def discard(target, is_dir, name):
    if is_dir:
        shutil.rmtree(target)
    else:
        os.remove(target)
        sib = os.path.join(SKILL_DIR, name + ".eval-samples.json")
        if os.path.isfile(sib): os.remove(sib)

removed, kept, skipped = [], [], []
for entry in sorted(os.listdir(SKILL_DIR)):
    p = os.path.join(SKILL_DIR, entry)
    # 与 omk discoverBatchSkills 的发现规则对齐:目录(含 SKILL.md) 或 *.md 文件
    if os.path.isdir(p) and os.path.isfile(os.path.join(p, "SKILL.md")):
        name, target, is_dir, md = entry, p, True, os.path.join(p, "SKILL.md")
    elif entry.endswith(".md") and entry != "SKILL.md":
        name, target, is_dir, md = entry[:-3], p, False, p
    else:
        continue
    fm = frontmatter_name(md)
    idents = {name.lower()} | ({fm.lower()} if fm else set())
    # 官方判定:目录/文件名 或 frontmatter name 命中即算官方
    if idents & official:
        discard(target, is_dir, name); removed.append(name)
    elif only and not (idents & only):
        discard(target, is_dir, name); skipped.append(name)
    else:
        kept.append(name)

print("REMOVED=" + ",".join(removed))
if only:
    print("SKIPPED=" + ",".join(skipped))
print("KEPT=" + ",".join(kept))
sys.exit(3 if not kept else 0)
PY
PRUNE_OUT="$(SKILL_DIR="$SKILL_DIR" OFFICIAL_FILE="$OFFICIAL_FILE" python3 "$PRUNE_PY")" && PRUNE_RC=0 || PRUNE_RC=$?

echo "$PRUNE_OUT" | sed 's/^REMOVED=/  过滤官方 skill: /; s/^SKIPPED=/  非白名单跳过: /; s/^KEPT=/  保留待评测 skill: /' >&2
if [[ "$PRUNE_RC" == "3" ]]; then
  err "过滤后没有可评测的业务 skill，结束"
  exit 0
elif [[ "$PRUNE_RC" != "0" ]]; then
  err "过滤官方 skill 失败 (rc=$PRUNE_RC)"
  exit 1
fi

MODEL_ARGS=()
[[ -n "${OMK_MODEL:-}" ]] && MODEL_ARGS=(--model "$OMK_MODEL")

# ---------- doctor 跑前快照(用于差集识别本批次新增) ----------
DOCTOR_BEFORE="$WORK_DIR/doctors.before"
if [[ -d "$DOCTORS_DIR" ]]; then
  find "$DOCTORS_DIR" -maxdepth 1 -name '*.json' -type f 2>/dev/null | sort > "$DOCTOR_BEFORE"
else
  : > "$DOCTOR_BEFORE"
fi

# ---------- 1. 生成评测用例 ----------
log "omk sample —— 为缺用例的 skill 生成评测用例"
SAMPLE_ARGS=()
[[ -n "${OMK_SAMPLE_COUNT:-}" ]] && SAMPLE_ARGS=(--count "$OMK_SAMPLE_COUNT")
omk sample --batch --skill-dir "$SKILL_DIR" ${SAMPLE_ARGS[@]+"${SAMPLE_ARGS[@]}"} || err "omk sample 部分失败，继续"

# 兼容 shim:已发布的 omk(<=0.32.0) batch 发现只认 <skill>/eval-samples.json，而 omk sample
# 写的是 <skill>/.omk/samples.json。把后者复制成前者，让 omk eval --batch 能发现样本。
# (新版 omk 直接支持 .omk/，多复制一份 eval-samples.json 无害。)
while IFS= read -r sj; do
  d="$(dirname "$(dirname "$sj")")"
  [[ -f "$d/eval-samples.json" ]] || cp "$sj" "$d/eval-samples.json"
done < <(find "$SKILL_DIR" -maxdepth 3 -path '*/.omk/samples.json' -type f 2>/dev/null)

# ---------- 2. 健康检查 ----------
log "omk doctor —— skill 健康检查"
omk doctor "$SKILL_DIR" || err "omk doctor 部分失败，继续"

# ---------- 3. 评测(写进本批次专属目录) ----------
log "omk eval —— 用例驱动评测打分 (--output-dir $BATCH_DIR)"
omk eval --batch --skill-dir "$SKILL_DIR" --skip-doctor --output-dir "$BATCH_DIR" ${MODEL_ARGS[@]+"${MODEL_ARGS[@]}"} \
  || err "omk eval 部分失败，继续"

# ---------- 4. 汇总本批次报告文件 ----------
FILE_LIST="$WORK_DIR/files.list"
: > "$FILE_LIST"
# eval：专属目录下全部 JSON 即本批次
find "$BATCH_DIR" -maxdepth 1 -name '*.json' -type f 2>/dev/null | sort >> "$FILE_LIST"
# doctor：跑后快照 − 跑前快照 = 本批次新增
if [[ -d "$DOCTORS_DIR" ]]; then
  find "$DOCTORS_DIR" -maxdepth 1 -name '*.json' -type f 2>/dev/null | sort \
    | comm -13 "$DOCTOR_BEFORE" - >> "$FILE_LIST"
fi

N_FILES=$(grep -c . "$FILE_LIST" || true)
log "本批次待上报报告文件: $N_FILES 个"
if [[ "$N_FILES" -eq 0 ]]; then
  err "没有发现本批次生成的报告，跳过上报(检查 omk eval/doctor 是否真的产出了报告)"
  exit 0
fi

# ---------- 5. 过滤字段并上报 ----------
log "上报 -> $UPLOAD_URL"
FILE_LIST="$FILE_LIST" \
UPLOAD_URL="$UPLOAD_URL" \
UPLOAD_TOKEN="$UPLOAD_TOKEN" \
AGENT_NAME="$AGENT_NAME" \
REPO_NAME="$REPO_NAME" \
DRY_RUN="${OMK_UPLOAD_DRY_RUN:-0}" \
python3 - <<'PY'
import json, os, sys, urllib.request

URL     = os.environ["UPLOAD_URL"]
TOKEN   = os.environ["UPLOAD_TOKEN"]
AGENT   = os.environ["AGENT_NAME"]
REPO    = os.environ["REPO_NAME"]
DRY_RUN = os.environ.get("DRY_RUN", "0") == "1"

with open(os.environ["FILE_LIST"], encoding="utf-8") as f:
    FILES = [ln.strip() for ln in f if ln.strip()]


# ---- 字段过滤(与 skill-sync/_omk_upload.py 一致) ----
def filter_doctor(raw):
    if raw.get('kind') != 'doctor':
        return None
    return {
        'kind': 'doctor',
        'id': raw.get('id', ''),
        'timestamp': raw.get('timestamp', ''),
        'model': raw.get('model', ''),
        'outcome': raw.get('outcome', ''),
        'ruleStats': raw.get('ruleStats', {}),
        'skills': [
            {
                'skillName': s.get('skillName', ''),
                'results': [
                    {
                        'ruleId': r.get('ruleId', ''),
                        'status': r.get('status', ''),
                        'detail': {'displayName': r.get('detail', {}).get('displayName', '')},
                    }
                    for r in s.get('results', [])
                ],
            }
            for s in raw.get('skills', [])
        ],
    }


def filter_evaluation(raw):
    if raw.get('kind') != 'evaluation':
        return None
    keep = {'ok', 'compositeScore', 'assertions', 'llmScore'}
    results = []
    for r in raw.get('results', []):
        fv = {}
        for vk, vv in r.get('variants', {}).items():
            if isinstance(vv, dict):
                fv[vk] = {k: v for k, v in vv.items() if k in keep}
        results.append({'sample_id': r.get('sample_id', ''), 'variants': fv})
    meta = raw.get('meta', {})
    analysis = raw.get('analysis', {})
    return {
        'kind': 'evaluation',
        'id': raw.get('id', ''),
        'meta': {
            'timestamp': meta.get('timestamp', ''),
            'model': meta.get('model', ''),
            'sampleCount': meta.get('sampleCount', 0),
            'totalCostUSD': meta.get('totalCostUSD', 0),
        },
        'summary': raw.get('summary', {}),
        'results': results,
        'analysis': {'gapReports': analysis.get('gapReports', {})},
    }


def filter_observe_inbox(raw):
    if raw.get('kind') != 'observe-inbox':
        return None
    meta = raw.get('meta', {})
    experience = raw.get('experience', {})
    keep_ind = {
        'toolCallCount', 'toolFailureCount', 'userCorrectionCount',
        'userInterruptionCount', 'negativeFeedbackCount', 'positiveFeedbackCount',
        'selfCorrectionCount', 'highObservationCount', 'mediumObservationCount',
        'assistantDeliverySignalCount', 'deliverableArtifactSignalCount',
    }
    fskills = []
    for s in experience.get('skills', []):
        ind = s.get('indicators', {})
        fskills.append({
            'skillName': s.get('skillName', ''),
            'invocationCount': s.get('invocationCount', 0),
            'sessionCount': s.get('sessionCount', 0),
            'firstSeen': s.get('firstSeen', ''),
            'lastSeen': s.get('lastSeen', ''),
            'indicators': {k: v for k, v in ind.items() if k in keep_ind},
        })
    fitems = []
    for item in raw.get('items', []):
        fitems.append({
            'id': item.get('id', ''),
            'skillName': item.get('skillName', ''),
            'signalType': item.get('signalType', ''),
            'signalSubtype': item.get('signalSubtype', ''),
            'severity': item.get('severity', ''),
            'confidence': item.get('confidence', 0),
            'occurrences': item.get('occurrences', 0),
            'firstSeen': item.get('firstSeen', ''),
            'lastSeen': item.get('lastSeen', ''),
        })
    return {
        'kind': 'observe-inbox',
        'meta': {
            'generatedAt': meta.get('generatedAt', ''),
            'sessionCount': meta.get('sessionCount', 0),
            'sessionTimeRange': meta.get('sessionTimeRange', {}),
            'skillInvocationCounts': meta.get('skillInvocationCounts', {}),
            'skillSessionCounts': meta.get('skillSessionCounts', {}),
            'skillInvocationLastSeen': meta.get('skillInvocationLastSeen', {}),
        },
        'items': fitems,
        'experience': {'skills': fskills},
    }


def filter_report(raw):
    return {
        'doctor': filter_doctor,
        'evaluation': filter_evaluation,
        'observe-inbox': filter_observe_inbox,
    }.get(raw.get('kind', ''), lambda _: None)(raw)


def get_skill_name(raw):
    kind = raw.get('kind', '')
    if kind == 'doctor':
        skills = raw.get('skills', [])
        if skills:
            return skills[0].get('skillName', '')
    elif kind == 'evaluation':
        # skill 名 = 非 baseline/control 的 variant key(batch 报告 id 形如
        # batch-<ts>-NN-<skill>，rsplit 取不准；variant key 才是可靠来源)。
        for r in raw.get('results', []):
            if isinstance(r, dict):
                for vk in r.get('variants', {}):
                    if vk not in ('baseline', 'control'):
                        return vk
        # 兜底:老式单 skill 报告 id 形如 <skill>-<model>-<timestamp>
        rid = raw.get('id', '')
        parts = rid.rsplit('-', 2)
        if len(parts) >= 3:
            name = parts[0]
            return name[7:] if name.startswith('evolve-') else name
        return rid
    elif kind == 'observe-inbox':
        items = raw.get('items', [])
        if items:
            return items[0].get('skillName', '')
    return ''


def upload_report(kind, skill_name, data):
    payload = json.dumps({
        'token': TOKEN,
        'agent_name': AGENT,
        'repo_name': REPO,
        'reports': [{'kind': kind, 'skill_name': skill_name, 'data': data}],
    }, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(
        URL, data=payload,
        headers={'Content-Type': 'application/json'}, method='POST',
    )
    try:
        resp = urllib.request.urlopen(req, timeout=15)
        body = json.loads(resp.read().decode('utf-8'))
        return body.get('success', False)
    except Exception as e:
        print(f'  upload error: {e}', file=sys.stderr)
        return False


uploaded = failed = 0
for fp in FILES:
    try:
        raw = json.load(open(fp, encoding='utf-8', errors='replace'))
    except Exception:
        continue
    filtered = filter_report(raw)
    if filtered is None:
        continue
    kind = filtered.get('kind', '')
    skill_name = get_skill_name(filtered)
    if DRY_RUN:
        size = len(json.dumps(filtered, ensure_ascii=False))
        rid = filtered.get('id', filtered.get('meta', {}).get('generatedAt', '?'))
        print(f'  [dry-run] {kind}/{skill_name}: {rid} ({size} bytes) <- {os.path.basename(fp)}')
        uploaded += 1
        continue
    if upload_report(kind, skill_name, filtered):
        print(f'  上报成功 {kind}/{skill_name} <- {os.path.basename(fp)}')
        uploaded += 1
    else:
        print(f'  上报失败 {kind}/{skill_name} <- {os.path.basename(fp)}', file=sys.stderr)
        failed += 1

print(f'[omk-upload] {uploaded} uploaded, {failed} failed (total {len(FILES)} scanned)')
sys.exit(1 if failed else 0)
PY

log "完成。可在 AIMA Workspace 查看: https://aima-pre.alipay.com/workspace/agent"
