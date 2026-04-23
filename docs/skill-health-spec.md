# OMK Skill 健康度规范

> 状态：v0.1 草案（2026-04-19 起草，v0.18 落地）
> 作用：定义 omk 如何从真实生产 trace 里识别 skill 使用、计算 skill 健康度指标、产出观察性分析报告。
> 与 [knowledge-gap-signal-spec.md](./knowledge-gap-signal-spec.md) 的关系：skill-health 的信号定义 / 聚合公式 / 水印要求**完全继承** gap signal spec，本文档只增补"生产环境 + 按 skill 归属"相关的特有规则。

---

## 一、立场与定位

skill 健康度**不是**评分，**不是**评测，**是观察性分析**。

生产环境中的 agent 调用没有标答（无 rubric）、没有对照组（每次 query 都不同）、没有同样本重复（用户不会把同一问题问两次）。这三个缺失意味着：**任何"skill 得 4 分、那个 skill 得 3 分"的结论都是无根之木**。omk 坚决不做这种输出。

omk 在生产 trace 上能做什么：

1. **观察** 一个 skill 在真实使用中访问了哪些 KB 文件（coverage）· 撞了多少墙（gap signals）· 具体撞在哪（gap inventory）
2. **追踪** 上述观察指标随时间的变化（趋势）
3. **驱动行动** 把观察结果转化为"该补什么 KB" / "该扩什么测评样本" 的具体 action

**能说什么 vs 不能说什么**：

能说"**skill X 在过去 7 天的 500 次调用中，gap signal 触发率 30%，主要集中在 repos/billing/ 域**"。

不能说"**skill X 比 skill Y 好**"（没对照组）/ "**skill X 质量 4 分**"（没标答）/ "**skill X 在生产好过 offline eval**"（测量系统不同）。

---

## 二、与 bench eval 的分工

| | `omk bench` | `omk analyze` |
|---|---|---|
| 输入 | 人写 samples.json + 被测 artifact | 真实生产 trace（cc session JSONL 等） |
| 对照组 | 有（control vs treatment） | 无 |
| 标答 | 有（assertion + rubric） | 无 |
| 评分 | 三层独立（fact/behavior/judge）| **不做** |
| Coverage | 有（§四 复用 knowledge-coverage） | 有（§四复用） |
| Gap signals | 有（复用 gap-signal §四） | 有（复用） |
| 使用时机 | 上线前的对照验证 + 回归门禁 | 上线后的持续观察 + 诊断清单 |
| 报告频率 | 每次 CI 都跑 | 按时间窗批量（默认 7 天 / 30 天） |
| 驱动 action | 发现 skill 不够好 → 改 skill | 发现 KB 有漏 → 补 KB / 扩测评样本 |

两者**互补不替代**。offline eval 是"上线前该不该放行"，production analyze 是"上线后实际表现如何 + 下一轮该改什么"。

---

## 三、cc session JSONL schema（v0.18 唯一支持的 trace 源）

cc session transcript 位置：`~/.claude/projects/<slug>/<session-uuid>.jsonl`。每行一条 record，JSON 格式。

### 关心的 record 类型

**`type: "assistant"`** — agent 输出。关键字段：

```typescript
{
  type: "assistant",
  uuid: string,
  parentUuid: string | null,
  sessionId: string,
  timestamp: string,         // ISO8601
  cwd: string,               // 推断 project root 用
  gitBranch: string,
  message: {
    role: "assistant",
    model: string,
    content: Array<
      | { type: "thinking", thinking: string }
      | { type: "text", text: string }
      | { type: "tool_use", id: string, name: string, input: object }
    >,
    stop_reason: string,
    usage: { input_tokens, output_tokens, cache_read_input_tokens, ... }
  }
}
```

**`type: "user"`** — user 输入 or tool result 反馈。关键字段：

```typescript
{
  type: "user",
  uuid: string,
  sessionId: string,
  timestamp: string,
  message: {
    role: "user",
    content: string | Array<
      | { type: "text", text: string }
      | {
          type: "tool_result",
          tool_use_id: string,   // 匹配 assistant.content[].tool_use.id
          content: string,
          is_error?: boolean     // 默认 false, true = tool 调用失败
        }
    >
  }
}
```

### 忽略的 record 类型

直接 skip，不参与分析：

- `type: "permission-mode"` — 会话权限配置元数据
- `type: "file-history-snapshot"` — cc 内部文件快照

### is_error 到 omk 的映射

`tool_result.is_error === true` → omk `ToolCallInfo.success = false`。这是 **failed_search 信号的硬证据**。无 `is_error` 字段视为 `false`（成功）。

---

## 四、Skill 归属规则

skill 归属是 skill-health 特有的问题（offline eval 里 skill = 被测 artifact，天然 1:1 对应 variant；生产 trace 里一个 session 可能跨多个 skill 或零 skill）。

### 三类硬信号

**信号 1：tool_use name="Skill"（最硬）**

```json
{"type":"tool_use","name":"Skill","input":{"skill":"wiki","args":"..."}}
```

cc 内置 tool。`input.skill` 字段直接给出 skill 名。这是零推断、零歧义的 skill invocation。

**信号 2：`<command-name>/X</command-name>` 注入（同等硬）**

user message content 中 cc 自动注入的标签：

```
<command-name>/audit</command-name>
<command-message>audit</command-message>
```

`/audit` / `/polish` / `/typeset` 等 Impeccable skill 全部通过这种方式触发。`/X` 去掉 `/` 前缀得到 skill 名。

**信号 3：Read `.claude/skills/<name>/SKILL.md`（辅助）**

当 agent 读取 skill 文件时，作为辅助归属信号。用于 fallback：信号 1/2 都没有，但 SKILL.md 被 Read → 这个 skill 可能在被"预加载"。v0.18 MVP 里**暂不使用信号 3**（避免引入歧义），留作 v0.19 边界 case 补充。

### 段式归属规则（v0.18 锁定）

- 一个 session 按时序扫描
- 信号 1 或信号 2 出现时，开启新的 skill 段
- 该段内所有 `tool_use` + `tool_result` 归属于这个 skill
- 段持续到下一个 skill 信号或 session 结束
- 没有任何 skill 信号的部分归属 `general`（裸 cc 对话也是一种使用模式，不丢弃）

### 边界 case

**单 session 多 skill**：同一 session 里先 `/audit` 后 `/polish`，两个信号切分成两个独立段，coverage / gap 分别聚合到 audit 和 polish。

**Skill tool 嵌套调用**：agent 在一个 skill 段内又调用 Skill tool 触发另一个 skill（spec §九可能出现的情况）。v0.18 按扁平处理——新 skill 信号出现即切段，不保留嵌套层级。v0.19 视需要支持。

**无 skill session**：整个 session 都是裸对话。归属 `general`，参与总体统计但在报告里单独标注为"unassigned"。

**跨 session 聚合**：同一 skill 在不同 session 的段全部合并，作为该 skill 整体健康度的输入。

---

## 五、聚合公式

### per-skill coverage

```
skill_coverage[k] = |accessed_kb_files[k]| / |total_kb_files|
accessed_kb_files[k] = ⋃ (files Read/Grepped in skill k's segments across all sessions)
```

注意：分母是 **KB 文件总数**（全局），分子是 **该 skill 实际访问过的子集**。不同 skill 的 coverage 可以差异很大——符合预期（`/audit` 不会访问所有 KB，它只 care 相关子集）。

### per-skill gap rate

完全复用 `knowledge-gap-signal-spec.md` §五：

```
skill_gap_rate[k] = (含缺口信号的 "skill segment" 数) / (skill k 的 segment 总数)
skill_weighted_gap_rate[k] = Σ max_signal_weight[seg] / (skill k 的 segment 总数)
```

"skill segment" 在 skill-health 语境下替代原 spec 的"样本"概念——一个 skill 段就是一次"skill 使用单元"。

### overall 健康度色带

主要用来帮读者快速辨识"要不要现在关注"：

- 绿：overall weighted_gap_rate < 10%
- 黄：10% ≤ weighted_gap_rate < 30%
- 红：weighted_gap_rate ≥ 30%

阈值和 bench ci `--max-gap-rate` 对齐（经验值，v0.18 dogfood 后视需要调）。

---

## 六、强制水印（继承 gap-signal §七.1）

每份 skill 健康度日报**必须**展示：

- trace 源路径（如 `~/.claude/projects/<slug>/`）
- 分析时间窗（from / to）
- session 总数 · message 总数 · tool call 总数
- KB 路径 + 文件数（如果 `--kb` 传了 or 自动推断）
- 一句明文警告：**"本报告仅反映指定时间窗内观察到的 skill 使用情况,不代表 skill 的绝对质量,也不能替代 offline eval 的对照验证"**

没水印的数字在 omk 生产观察出口视为无效。

---

## 七、数据立场

**采样**：v0.18 MVP 处理 100% trace（你机器上 ~30k message 量级完全 handle 得了）。更大规模（>1M message / 每天）需要采样策略，v0.19 视需要加。

**噪声阈值**：生产环境的 `failed_search` 假阳率可能高于 offline——agent 在生产里做"探索性搜索"（试各种关键词）很常见。v0.18 dogfood 阶段记录真实假阳率，给 v0.19 阈值调参提供数据。

**隐私**：dogfood 阶段处理自己的 trace，无敏感问题。未来给他人使用时需要补脱敏层（user query 可能含敏感信息）。v0.18 不做。

**版本对齐**：生产可能同时跑多个 skill 版本。v0.18 MVP 不区分版本（全部归到 skill 名下）。如果需要区分，trace 需要带 skill version 标签（cc 目前不带，需要在 cc 或 skill 层注入），v0.19 视需要做。

---

## 八、v0.1 明确推迟的事

- **业务指标挂接**：把 gap rate 和"用户是否重试 / 人工接管 / 标注有用无用"关联分析。最硬的"知识缺口真的有业务伤害"证据，但需要 cc trace 里带这类字段，v0.18 不做。
- **streaming + 告警**：持续观察 + 异动告警，要持久化存储 + 长期服务，工程量是 batch 的 5-10 倍。v0.18 只做 batch。
- **多 trace 源**：OpenAI function calls / 自建格式等。v0.18 只做 cc。
- **Skill tool 嵌套**：v0.18 扁平处理，v0.19 视需要。
- **信号 3 辅助归属**：v0.18 只用信号 1/2，信号 3 留作 v0.19 边界 case。

---

## 附录：cc 实际数据分布（本仓库 dogfood 样本）

`~/.claude/projects/-Users-lizhiyao-Documents-oh-my-knowledge/` 实测（2026-04-19）：

- 438 session · ~30k message · tool error rate ~5%
- Slash commands top：`/audit × 15` · `/typeset × 10` · `/polish × 5` · `/overdrive × 2` · `/stats × 1`
- Skill tool 调用：至少 `wiki × 3`
- 覆盖的 Impeccable skill：audit / polish / typeset / overdrive / clarify / distill / onboard / animate / critique 等约 25 个

这个样本量已经完全够 MVP dogfood。
