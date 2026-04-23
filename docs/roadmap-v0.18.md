# omk 能力迭代路线图 · v0.18 · 生产观察 / skill 健康度日报

> 起草：2026-04-19
> 基线：v0.17.0
> 主题：**从 offline eval 扩展到 production observability**
> 配套：[skill-health-spec.md](./skill-health-spec.md)（版本化）· [knowledge-gap-signal-spec.md](./knowledge-gap-signal-spec.md)（复用 §四 信号定义）

---

## 一、核心判断

omk 到 v0.17 为止做完三个 release 的"能力深化"——knowledge gap 形式化 / 三层独立评分 / experiment role / eval.yaml / severity weighting / hedging LLM 二次判定。科学可信度在内部工具里是"无懈可击防守"级别。**瓶颈早就不在能力侧，而在采用率**。

v0.18 的战略动作：**把 gap-analyzer / coverage 的能力从"bench 一次性跑"扩展到"生产环境持续产出"**。不是做新产品线，是给 omk 现有核心能力换一种 input 源。

---

## 二、不是什么（边界声明）

**不是** Langfuse / Braintrust / Datadog 那种通用 observability 平台——不做 request/response/latency/cost 追踪（那是它们的地盘）。

**不是** 在线评分 / 在线告警 / streaming——v0.18 只做 batch 离线分析。

**不是** skill 评分——生产环境没有对照组、没有标答、没有同样本重复，**做不出评分**。只做观察性分析（哪些 KB 被访问 / 哪些没被访问 / 撞了多少次墙 / 具体撞在哪）。

---

## 三、是什么（MVP 定义）

**一条命令**：`omk analyze <dir> [--kb <kb-dir>] [--last 7d | --from X --to Y]`

**输入**：cc session JSONL 目录（如 `~/.claude/projects/<slug>/`）。未来扩展 OpenAI / 自建格式走自动类型推断，v0.18 只做 cc。

**输出**：一份 HTML 格式的"skill 健康度日报"。存 `~/.oh-my-knowledge/analyses/<timestamp>-skill-health.html`。

**报告结构**：每个 skill 一张 card（复用 v0.17 A 的 coverage+gap 合并布局），展示：
- **skill 使用量**：本期被调用次数 / 总 tool calls / session 分布
- **knowledge coverage**：这个 skill 实际访问了哪些 KB 文件（top 20 + 从未访问清单）
- **gap signals**：gapRate + weightedGapRate + 四类信号分布 + gap inventory top 20（真实 Grep 失败 / hedging 上下文）

对比上一期（如果有历史报告）：gap rate 趋势 / 新增死代码 KB 文件 / 新增高频 Grep 失败词。

---

## 四、执行原则（继承 v0.16）

1. **0-1 窗口期直接 breaking**：api / schema 变更不做 deprecation warning，不留兼容别名。错过这个窗口以后迁移成本会显著增加。
2. **自动推断 > 显式 flag**：`omk analyze <dir>` 扁平接单参数，类型推断看入参 schema（cc JSONL / bench report JSON / markdown 集合），不走子命令。
3. **Dogfood 驱动阈值**：噪声过滤阈值 / 信号严重度分类 / skill 归属边界 case，全部用本仓库 `~/.claude/projects/-Users-lizhiyao-Documents-oh-my-knowledge/` 实际数据校准。不凭空猜。
4. **叙事和产品名对齐但分离**：命令叫 `omk analyze`（动作语义），产出叫"skill 健康度日报"（叙事语义），两者分离是特性不是 bug（类比 `git log` 产出 commit history）。
5. **CHANGELOG 每个工作项同步更新**，不攒到 release 时补。

---

## 五、v0.18 详细计划

### 工作项 A｜trace-adapter（1 周）

**核心**：`src/observability/trace-adapter.ts`。把 cc session JSONL 转成 omk 内部 `ResultEntry` 结构。

**Schema 已调研**（见本文档附录 A / skill-health-spec §三）：
- `type:"assistant"` 带 `content[]`（thinking / text / tool_use），有 cwd / gitBranch / timestamp / sessionId / usage
- `type:"user"` 带 `tool_result`（tool_use_id / content / is_error），is_error 映射 omk 的 `ToolCallInfo.success`
- 元数据 record（permission-mode / file-history-snapshot）直接 skip

**skill 归属三类硬信号**（详见 spec §四）：
- tool_use name="Skill" 的 input.skill 字段
- `<command-name>/X</command-name>` 注入 user message
- Read `.claude/skills/<name>/SKILL.md` 作为辅助信号

**段式归属**：skill 信号出现后，后续 tool calls 归属该 skill 直到下一个 skill 信号或 session 结束。没信号段归 `general`（不丢）。

**验收**：单元测试覆盖 schema 解析 / skill 归属切分 / tool_use-tool_result 配对 / is_error 映射。

### 工作项 B｜单组分析路径（0.5 周）

`src/observability/production-analyzer.ts`。接 trace-adapter 输出 → 复用现有 `gap-analyzer` + `knowledge-coverage`，跳过对照组逻辑，按 skill 维度聚合。

**技术红利**：gap-analyzer / coverage 本来就是 trace-driven 的，不关心对照组。99% 代码无需改动。

**新增**：
- `computeSkillHealthReport(traces, kbRoot, opts)` 顶层入口
- 按 skill 分桶聚合 coverage 和 gap
- 可选对接 hedging classifier（复用 v0.17 B）——建议 v0.18 暂关，避免 dogfood 阶段 API cost 意外爆炸

**验收**：相同 trace 跑出相同 report（确定性）· skill 归属正确 · gap rate 不受对照组缺失影响。

### 工作项 C｜CLI + HTML 模板（1.5 周）

**CLI**：`omk analyze <dir> [options]` subcommand。
- `<dir>`：支持文件 / 目录 / cc project slug 路径
- `--kb <kb-dir>`：可选，默认从 trace 的 cwd 字段推断（如果 trace 都在同一 project）
- `--last 7d` 或 `--from/--to`：时间窗过滤
- `--skills <name1,name2>`：限定分析指定 skill（可选）

**HTML 模板**：`src/renderer/skill-health-renderer.ts`。复用 layout.ts 基础设施 + v0.17 A 的 coverage+gap card 结构。每 skill 一张 card（`.ki-card` 已有的 class 直接用）。

**不同于 bench 报告的部分**：
- 无对照组 diff 列
- 无三层评分（fact/behavior/judge 不存在于生产 trace）
- 加一个顶部摘要 card：本期 session 数 / 总 tool calls / overall gap rate / 健康度色带（绿/黄/红）
- 加一个"死代码 KB"section：从未被任何 skill 访问的 KB 文件清单

**验收**：端到端跑通本地 dogfood 数据 · 报告可读 · 文件大小 <2MB（30k+ message 量级）。

### 工作项 D｜dogfood 验证 + 发布（1 周）

1. 跑真实数据（`~/.claude/projects/-Users-lizhiyao-Documents-oh-my-knowledge/` 438 session）
2. 校准噪声阈值（生产 explore 行为的 failed_search 假阳率可能高于 offline）
3. 补充 spec 里的边界 case（根据真实数据发现）
4. CHANGELOG 归档 [0.18.0] - 2026-05-xx
5. merge → bump → tag → publish

**dogfood 验收标准**（至少达标才 release）：
- `/audit` / `/typeset` / `/polish` 等 Impeccable skill 能正确识别和分组
- `wiki` Skill tool 调用能正确识别
- skill coverage 数字符合人直觉（人工抽 5 个 session 核对）
- 至少一条"这个 skill 该补什么 KB"的真实 action 线索（否则报告没价值）

---

## 六、时间线

4 周：

- **Week 1**（2026-04-20 ~ 04-26）：T4 trace-adapter
- **Week 2**（04-27 ~ 05-03）：T5 单组分析 + T6 CLI 骨架
- **Week 3**（05-04 ~ 05-10）：T6 HTML 模板 + 自己跑一次内部 review
- **Week 4**（05-11 ~ 05-17）：T7 dogfood + 噪声调参 + release v0.18.0

---

## 七、v0.19 候选（v0.18 之后）

v0.18 release 后根据 dogfood 反馈挑选：

- **业务指标挂接**：如果 cc trace 中能提取"用户是否重试 / 人工接管 / 问题是否解决"这类反馈字段，把 gap rate 和业务指标做相关性分析。最硬的"知识缺口真的有业务伤害"证据
- **competency questions / probe**（v0.17 原 C 工作项推迟到这里）：从 KB 反向生成探测问题补"测评集没问过"的盲点。与 `omk analyze` 互补：后者看"真实用户撞到什么"，probe 看"真实用户没问但 KB 里写了什么会答不出"
- **streaming / dashboard**：把 analyze 从"每周 batch"升级到"持续观察 + 异动告警"。工程量陡然变大（要持久化存储 + 长期服务），谨慎评估

---

## 附录 A：cc session JSONL schema 调研结果

本机 `~/.claude/projects/-Users-lizhiyao-Documents-oh-my-knowledge/`：438 个 session · ~30k message · tool error rate ~5% · 主要 slash commands 分布 `/audit × 15` · `/typeset × 10` · `/polish × 5` · `/overdrive × 2`。

schema 详见 `docs/skill-health-spec.md` §三。
