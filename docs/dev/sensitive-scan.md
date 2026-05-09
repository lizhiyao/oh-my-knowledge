# 敏感信息扫描

omk 是公开 OSS 项目,合并 / 发版 / push 远端前要确保仓库不含工号、花名、内部域名、token / key、内部品牌代号等敏感信息。

之前已通过 `git filter-branch` 清洗过历史 commit 把内部代号替换成中性词,本扫描用于:

- **回归确认**:确认没有新增提交把这些字眼带回来
- **新词发现**:新写的文案 / 注释 / sample 数据是否引入了未被规则覆盖的新内部信息
- **在 push 上游 / 切 release 前作为安全门**

## 扫描类别

| 类别 | 说明 | 处理方式 |
|---|---|---|
| 内部品牌 | 公司 / 内部产品代号(中英文) | 替换为通用名(`code-host` / `req-tool` 等) |
| 内网域名 | `*.alipay.com` / `*.alibaba-inc.com` / `*.antgroup.com` / `aone` 等 | 删除或换占位 `internal.example.com` |
| Token / key | OpenAI / AWS / GitHub PAT / JWT / 通用 secret 赋值 | 立即删除 + revoke,不只清 commit |
| 工号 / 花名 | 6-7 位工号、中文 2-3 字花名标签 | 替换为 `<author>` 或匿名 |
| 个人路径 | `/Users/<name>/...` / `/home/<name>/...` | 改成相对路径或脱敏 |

## 一键扫描

复制下面整段 bash 块到 omk 仓库根目录执行:

```bash
#!/usr/bin/env bash
# 敏感信息扫描 — 在 omk 仓库根执行
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

# ── 排除规则:扫不到的文件 ─────────────────────────────────
EXCLUDE_GLOBS=(
  ':!yarn.lock' ':!package-lock.json'
  ':!test/__snapshots__/**'
  ':!docs/dev/sensitive-scan.md'   # 本文档自身有规则关键字
  ':!**/*.png' ':!**/*.jpg' ':!**/*.jpeg' ':!**/*.gif' ':!**/*.svg'
)

# ── 模式 ─────────────────────────────────────────────────
# 内部品牌(中文 + 英文,大小写不敏感)
PAT_BRAND='(?i)\b(alipay|alibaba|antgroup|antfin|antfinancial|taobao|tmall|cainiao|koubei|antcode|aima|dima|linke|bahamut|yufu|mtee|aone|buc|cmop|xiaoling|liunuo)\b|蚂蚁集团|蚂蚁金服|阿里巴巴|支付宝|网商|菜鸟|口碑|小灵'

# 内网域名
PAT_DOMAIN='(?i)\.(alipay|alibaba-inc|antgroup|antfin|antfinancial|taobao|tmall)\.com|aone\.alibaba|mtee\.alipay|alibaba-inc\.com'

# 各家 token / key(强匹配)
PAT_TOKEN='sk-[a-zA-Z0-9]{32,}|AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{20,}|xoxb-[0-9]+-[0-9]+-[a-zA-Z0-9]+|gho_[a-zA-Z0-9]{36}'

# 通用 secret 赋值(password/secret/api_key/token/access_key 后面跟 = 或 :,长度 >= 8)
PAT_SECRET='(?i)\b(password|passwd|secret|api_?key|access_?key|auth_?token|bearer)\b\s*[:=]\s*["'\''][^"'\'' ]{8,}["'\'']'

# JWT(简化:eyJ 开头 + 两个点)
PAT_JWT='eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{6,}'

# 工号 / 花名标签
PAT_EMPLOYEE='(?i)(工号|花名|employee_?id)\b|\b[A-Z]{2,4}[0-9]{4,7}\b'

# 个人路径(macOS / Linux home dir)
PAT_HOMEPATH='(/Users/[a-zA-Z][a-zA-Z0-9._-]+|/home/[a-zA-Z][a-zA-Z0-9._-]+)'

# ── 跑扫描 ───────────────────────────────────────────────
section() { printf '\n========== %s ==========\n' "$1"; }
run() {
  local label="$1" pat="$2"
  section "$label"
  git grep -n -E "$pat" -- "${EXCLUDE_GLOBS[@]}" | head -50 || true
}

run "内部品牌"          "$PAT_BRAND"
run "内网域名"          "$PAT_DOMAIN"
run "Token / API key"   "$PAT_TOKEN"
run "通用 secret 赋值"  "$PAT_SECRET"
run "JWT"               "$PAT_JWT"
run "工号 / 花名标签"   "$PAT_EMPLOYEE"
run "个人路径"          "$PAT_HOMEPATH"

# ── commit message 历史(只看最近 100)──────────────────
section "commit message(最近 100)"
git log -100 --pretty=format:'%h %s' | grep -i -E "alipay|alibaba|antgroup|antfin|antcode|aima|dima|linke|bahamut|蚂蚁|阿里|支付宝" || echo "(clean)"

echo
echo "扫描完成。命中行需逐条审视:误报(变量名 / 第三方包名)可加白名单,真敏感词替换/删除后重提交。"
```

## 解读结果

- **彻底干净**:每节都是 "(clean)" 或空 — 可以 push / 发版
- **少量命中**:逐条看是否真敏感(比如 `linkedin` 包含 `linke` 子串属误报);真敏感的话:
  1. 改源文件,替换为中性词
  2. 重新 commit
  3. 已 push 到远端的话,需要 `git filter-branch` 清历史(参考 `CONTRIBUTING.md`)
- **token / key 命中**:**立即** revoke 凭据,删除 + 重提历史,不要只删工作树

## 加新模式

在 omk 维护期发现新的内部代号,追加到对应的 `PAT_*` 变量即可。
本文档自身被加到 `EXCLUDE_GLOBS`(因为列出关键字会被自己匹配),新增模式时记得保留这个排除。

## 维护

本扫描不替代 secret 管理工具(如 `git-secrets` / `gitleaks` / `trufflehog`)。条件允许的话,
在 CI 加一个 gitleaks 步骤兜底,本文档作为 PR 自查清单。
