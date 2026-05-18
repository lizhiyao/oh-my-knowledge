# omk 命令参考

<!-- omk:cli:start -->
<!-- 此段由 scripts/build-docs.ts 从 src/cli/commands/ 自动生成。
     改 CLI 后跑 `yarn build:docs` 同步,CI `yarn build:docs:check` 会拦截 drift。-->

## omk doctor

体检 omk 工作目录，检查 skill 配置 / 依赖 / executor 连通性。

**用法:**

```bash
omk doctor [target] [flags]
```

**参数:**

- `target`(可选):要体检的 skill 路径或目录。可选，默认扫当前 cwd 下的 skills/。

**Flags:**

- `--effort` `option`:LLM 推理 effort：low / medium / high / xhigh / max。
- `--executor` `option`:执行器名，默认 claude。指定为测试 fixture 路径可在测试里跑（同 omk doctor）。
- `--fix` `boolean`:交互式修复：根据 doctor 报告问题，用 LLM agent 修复 skill。
- `--gate` `boolean`:静默模式，只在 fail 时输出 stderr 摘要，exit code 标识结果。
- `--html` `option`:HTML 报告输出路径。可跟 --json / --gate 共存。
- `--json` `boolean`:JSON 输出到 stdout，适合 CI / 外部脚本消费。
- `--lang` `option` (默认 `zh`):输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
- `--model` `option`:LLM model 名，默认 sonnet。
- `--samples` `option`:样本文件路径（.json/.yaml）。不传则按 target / cwd 顺序自动发现。
- `--static-only` `boolean`:离线静态模式，只跑 4 条静态 rule(skill_readable / skill_metadata / dependencies_present / samples_contract_aligned），不调 LLM。
- `--timeout` `option`:单次 LLM 会话超时秒数，默认 600(10 分钟）。

**示例:**

> 默认模式跑 LLM 健康度审计(7 内置维度）。

```bash
omk doctor
```

> 离线静态模式，只跑 4 条静态 rule，不调 LLM,CI 无 LLM 凭证时用。

```bash
omk doctor --static-only
```

> JSON 输出 + 写 HTML 报告，给 CI 抓 exit code 同时人看。

```bash
omk doctor --json --html doctor.html
```

## omk eval gold

管理 human-gold 标注集（init / validate / compare 三个子命令）。

**用法:**

```bash
omk eval gold [flags]
```

**Flags:**

- `--lang` `option` (默认 `zh`):输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。

## omk eval gold compare

把一份 evaluation report 跟 gold dataset 对比，计算 bootstrap CI 后的 agreement。

**用法:**

```bash
omk eval gold compare <reportId> [flags]
```

**参数:**

- `reportId`(必填):report ID。

**Flags:**

- `--bootstrap-samples` `option`:bootstrap 重采样次数，默认 1000
- `--gold-dir` `option`:gold dataset 目录，必填
- `--lang` `option` (默认 `zh`):输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
- `--reports-dir` `option`:报告目录，默认 ~/.oh-my-knowledge/reports
- `--seed` `option`:bootstrap seed，可复现
- `--variant` `option`:只比对指定 variant，默认全比

## omk eval gold init

初始化 gold dataset 目录（human-gold 标注集脚手架）。

**用法:**

```bash
omk eval gold init [flags]
```

**Flags:**

- `--annotator` `option`:标注者名，写入 metadata.yaml
- `--lang` `option` (默认 `zh`):输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
- `--out` `option` (默认 `./gold-dataset`):输出目录，默认 ./gold-dataset

## omk eval gold validate

校验 gold dataset 目录格式（annotations.yaml schema）。

**用法:**

```bash
omk eval gold validate <dir> [flags]
```

**参数:**

- `dir`(必填):gold dataset 目录。

**Flags:**

- `--lang` `option` (默认 `zh`):输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。

## omk evolve

自动迭代改进 skill:多轮 eval + skill 重写，直到达到 --target 或耗尽 --rounds。

**用法:**

```bash
omk evolve <skillPath> [flags]
```

**参数:**

- `skillPath`(必填):skill 文件或 SKILL.md 路径。

**Flags:**

- `--auto-fix-samples` `boolean`:每轮先修 skill，再修 sample，随后一起评估候选结果
- `--concurrency` `option` (默认 `1`):评测并发数，默认 1
- `--effort` `option`:reasoning effort: low/medium/high/xhigh/max
- `--executor` `option` (默认 `claude`):执行器名，默认 claude
- `--improve-mode` `agent|rewrite` (默认 `agent`):改写策略（默认：agent）
- `--improve-model` `option` (默认 `sonnet`):负责重写 skill 的 LLM，默认 sonnet
- `--judge-models` `option` (默认 `claude:haiku`):评委 model（单评委约束），格式 executor:model。默认 claude:haiku
- `--lang` `option` (默认 `zh`):输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
- `--model` `option` (默认 `sonnet`):被评测的 LLM，默认 sonnet
- `--no-diagnostic` `boolean`:关 LLM diagnostic 调用
- `--reuse-latest-eval` `boolean`:复用可比的最新 eval 报告作为 round-0
- `--rounds` `option` (默认 `5`):最大迭代轮数，默认 5
- `--sample-fix-max-attempts` `option` (默认 `2`):每条 sample 自动修复最多尝试次数（默认：2）
- `--samples` `option` (默认 `eval-samples.json`):样本文件路径，默认 eval-samples.json
- `--skip-connectivity` `boolean`:跳过 LLM 连通性预检
- `--skip-doctor` `boolean`:跳过 doctor 门禁（escape hatch，自负 garbage-in 风险）
- `--stop-on-assertions-pass` `boolean`:普通样本断言全过时提前停止
- `--target` `option`:目标 composite 分数，达到即停。不传则跑满 rounds
- `--timeout` `option` (默认 `120`):单样本超时秒，默认 120

**示例:**

> 默认 5 轮迭代

```bash
omk evolve skills/my-skill/SKILL.md
```

> 指定目标分 + 自定义模型

```bash
omk evolve skills/my-skill/SKILL.md --target 4.5 --model opus --improve-model opus
```

## omk init

初始化 omk 项目脚手架（skills/ + eval-samples.json 模板）。

**用法:**

```bash
omk init [targetDir] [flags]
```

**参数:**

- `targetDir`(可选):初始化目标目录，默认当前目录（.）

**Flags:**

- `--lang` `option` (默认 `zh`):输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。

**示例:**

> 在当前目录初始化

```bash
omk init
```

> 在指定目录初始化

```bash
omk init my-project
```

## omk observe inbox

查询 observation inbox(skill 调用洞察）。

**用法:**

```bash
omk observe inbox [flags]
```

**Flags:**

- `--by-skill` `boolean`:按 skill 聚合输出
- `--explore` `option`:抽样 N 条 medium/low 长尾（replaces limit）
- `--include-noise` `boolean`:explore 时也包含 noise 桶
- `--input-dir` `option`:inbox 数据目录，默认 .omk/observations（项目级，相对于 cwd）；目录不存在时兜底读 ~/.oh-my-knowledge/observations。
- `--json` `boolean`:JSON 格式输出
- `--lang` `option` (默认 `zh`):输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
- `--limit` `option`:限制条数，默认 20
- `--skill` `option`:只看指定 skill

## omk observe ingest

把 trace 目录 ingest 成 observation inbox 报告。

**用法:**

```bash
omk observe ingest <traceDir> [flags]
```

**参数:**

- `traceDir`(必填):trace 目录路径。

**Flags:**

- `--lang` `option` (默认 `zh`):输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
- `--output-dir` `option`:输出目录，默认 .omk/observations（项目级，相对于 cwd）。

## omk observe show

展开 observation inbox 中某条 item 的详情。

**用法:**

```bash
omk observe show <inboxId> [flags]
```

**参数:**

- `inboxId`(必填):inbox item ID。

**Flags:**

- `--input-dir` `option`:inbox 数据目录
- `--lang` `option` (默认 `zh`):输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。

## omk sample

为指定 skill 生成评测用例（eval-samples），支持 batch / single / fix 三种模式。

**用法:**

```bash
omk sample [skillPath] [flags]
```

**参数:**

- `skillPath`(可选):skill 文件路径或 SKILL.md 路径。batch 模式不需要；single / fix 模式必填。

**Flags:**

- `--batch` `boolean`:批量模式：扫 --skill-dir 下所有缺 samples 的 skill，逐个生成。
- `--count` `option`:生成样本条数。不传由 LLM 按 skill 类型自动决定。
- `--fix` `boolean`:fix 模式：基于最近评测报告自动修复 sample_design 类型失败。
- `--focus` `option`:生成焦点（自然语言提示）。控制 LLM 偏向哪类用例。
- `--lang` `option` (默认 `zh`):输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
- `--model` `option` (默认 `opus`):生成 LLM model 名，默认 opus。
- `--no-mock` `boolean`:不生成 mocks，eval 时所有工具调用真实执行。
- `--reports-dir` `option`:报告目录（fix 模式用），默认 ~/.oh-my-knowledge/reports。
- `--skill-dir` `option` (默认 `skills`):skill 根目录，默认 skills。batch 模式扫此目录。
- `--treatment` `option`:指定 treatment 名（fix 模式用），默认推断自 skill 路径。

**示例:**

> 为单个 skill 生成默认数量的样本

```bash
omk sample skills/my-skill/SKILL.md
```

> 批量为 skill 目录下所有缺 samples 的 skill 生成

```bash
omk sample --batch --skill-dir skills
```

> 根据最近评测报告自动修复 sample_design 类型失败

```bash
omk sample skills/my-skill/SKILL.md --fix
```

## omk studio

启动 omk Studio 报告服务（skill-centric 仪表盘 + 浏览器自动打开）。

**用法:**

```bash
omk studio [flags]
```

**Flags:**

- `--analyses-dir` `option`:分析数据目录（可选）
- `--dev` `boolean`:dev 模式：子进程启动 + 热更新
- `--host` `option`:监听 host，默认 localhost。改为 0.0.0.0 暴露给局域网
- `--lang` `option` (默认 `zh`):输出语言 zh|en，优先级 CLI > OMK_LANG env > zh。
- `--no-open` `boolean`:不自动打开浏览器
- `--observations-dir` `option`:观测数据目录（可选）
- `--port` `option` (默认 `7799`):监听端口，默认 7799。传 0 让 OS 分配
- `--reports-dir` `option`:报告目录，默认 ~/.oh-my-knowledge/reports

**示例:**

> 默认端口 7799

```bash
omk studio
```

> 指定端口，不打开浏览器

```bash
omk studio --port 8080 --no-open
```
<!-- omk:cli:end -->

## eval-samples 字段参考

| 字段 | 必填 | 说明 |
|------|------|------|
| `sample_id` | 是 | 唯一标识 |
| `prompt` | 是 | 用户提示词 |
| `context` | 否 | 附加上下文（代码片段等） |
| `cwd` | 否 | executor 工作目录，用于指定目标仓库路径 |
| `rubric` | 否 | LLM 评分标准 |
| `assertions` | 否 | 断言数组（含 `mock_hit` 等新 v0.30 类型） |
| `dimensions` | 否 | 多维度评分 `{ 维度名: 评分标准 }` |
| `capability` | 否 | 能力标签（HF Dataset Cards 风） |
| `difficulty` | 否 | 难度等级 |
| `construct` | 否 | 测的是什么构念 |
| `provenance` | 否 | 用例来源（`omk sample` 自动打） |
| `mocks` | 否 | 工具调用 mock 返回（sandbox 评测） |
| `environment` | 否 | 评测环境前置「已就绪」声明 |
| `tripwire` | 否 | 标记为「故意诱错」样本，failed 时 diagnostic 不建议改 skill |

完整 schema 见 [docs/sample-design-spec.md](../../../docs/sample-design-spec.md)。
