<!--
title: 综合分（composite）—— 怎么算的、能/不能用来回答什么
description: omk 综合分的完整推导：五层评分管道架构、ratioToScore 公式、缺失维度处理、三个 ad hoc 局限直白说、与多层独立 gate 的关系。诚实交代构造效度边界，避免被当成 absolute psychometric measure 误用。
-->

# 综合分（composite）

omk 报告里出现的「综合分 4.28 / 1.71」是这份文档的主角。它在 omk 内部承担「跨 run 排序 / bootstrap CI / verdict 比较信号」三个角色，是 omk 测量学叙事的 **核心标量**。这份文档讲清楚两件事：

1. **怎么算的** —— 五层评分管道、ratioToScore 公式、缺失维度处理
2. **能/不能用来回答什么** —— 它适合做 A/B 比较，不适合做 absolute psychometric measure

---

## 1. 核心公式

```
composite = mean({fact, behavior, judge})   // 等权算术平均
```

**fact / behavior**：断言（assertion）通过率经线性映射到 1-5 制：

```
factScore = 1 + (passed_weight / total_weight) × 4
behaviorScore = 1 + (passed_weight / total_weight) × 4
```

通过率 0% → 1 分，100% → 5 分。带权重的断言（`weight: 2` 比 `weight: 1` 重要）按权重和算，不是计数。

**judge**：LLM 评委按 rubric 直接给 1-5 分。omk 不做后处理（不归一化、不去 anchor 偏移），原始读数直接进 composite。

**缺失维度**：

```ts
const scores = [factScore, behaviorScore, judgeScore].filter(non-null);
const composite = scores.reduce(+) / scores.length;
```

任一层缺失（没配 assertion / 没配 judge / 评分失败）→ composite 在剩余层上取均值。

实现位置：`src/grading/layered-scores.ts`。被 `test/grading/judge-hash-frozen.test.ts` 冻结，公式漂移会触发可比性 break。

---

## 2. 五层评分管道架构

omk 的评分实际上是个分层管道：

```
原始观测 (LLM 输出 / 工具调用 / 成本 / 耗时)
   ↓
[Layer 1] assertion       —— 规则断言通过率（contains / regex / json_schema / tool_called / ...）
   ↓
[Layer 2] llm (raw judge) —— LLM 评委原始 1-5 分
   ↓
[Layer 3] judge (rubric)  —— rubric 锚定的语义分（默认就是 llm，omk 0.x 阶段两者重合）
   ↓
[Layer 4] dimension       —— capability-aligned 维度分（capability 评分体系，0.x 后期接入）
   ↓
[Layer 5] composite       —— fact / behavior / judge 等权均值
```

**当前（v0.x）实际进 composite 的只有三层**：fact + behavior + judge。dimension 层在 capability spec 完整落地前不参与 composite。assertion 在表里被拆成 fact（语义类断言）和 behavior（执行过程类断言）两类，分类规则见 `src/grading/layered-scores.ts` 顶部的 `FACTUAL_ASSERTION_TYPES` / `BEHAVIORAL_ASSERTION_TYPES`。

---

## 3. 局限：直白说

### ① 等权聚合是 ad hoc

三层（fact / behavior / judge）各 1/3 权重，**不是从 stakeholder 需求 derive 的**。「三层同等重要」是断言而非论证。psychometric 教科书会要求显式 weighting 论证（专家共识 / PCA / 因子分析），omk 当前没做。

**实际后果**：fact 大幅提升 + judge 略下降，composite 可能持平，掩盖结构性变化。omk 用「多层独立 gate」（见 §4）削弱这个风险，但风险没消除。

### ② 量尺不一致直接相加

- **fact / behavior**：binary（pass/fail）→ 通过率 → `1 + ratio × 4` stretch 到 1-5
- **judge**：真序数评分（LLM 给 1/2/3/4/5）

binary 数据 stretch 到 5 桶 + 真序数评分 **直接相加再均值**，违反 measurement scale homogeneity 原则。严格做法是先 standardize（z-score 或 rank），再加权聚合。omk 当前没做。

**实际后果**：fact 通过率 80% → factScore 4.2；judge 给 4 分 → judgeScore 4.0。两个 4.x 数字数量级近似，但 fact 的「4.2」和 judge 的「4.0」承载的信息密度不同（前者是 5 个 binary 检查中通过 4 个，后者是评委对整体输出的语义判断）。

### ③ 缺失维度自动降维 → 不可比

```
A skill: composite = mean(fact=4.5, behavior=4.0, judge=4.5) = 4.33
B skill: composite = mean(judge=4.33) = 4.33
```

两个 4.33 数字相同，**construct 完全不同**。跨 variant / 跨 skill 机械比较综合分会得到误判。

**实际后果**：报告里两个 variant 一个配了 assertion 一个没配时，综合分比较是 apples-to-oranges。omk 当前 UI 没有显式标注「这次 composite 由几层算」，是已知 gap。

---

## 4. 多层独立 gate 与综合分的关系

omk 的 verdict 系统（`src/eval-core/verdict.ts`）**不只看 composite**。它对 fact / behavior / judge 三层各跑独立显著性检验：

```
verdict 算法（精简版）：
  对每对 (control, treatment) 跑 bootstrap CI on (treatment - control) for each layer
  - 任一层 layer-gate FAIL（threshold 默认 3.5）  → REGRESS / CAUTIOUS
  - 全部层 CI 不显著                            → NOISE
  - composite 显著 + 全层 gate PASS              → PROGRESS · SHIP
  - composite 显著但某层 gate FAIL              → CAUTIOUS · INVESTIGATE
```

**意义**：composite 单分 +2.78 不能让 omk 给出 SHIP 判定，必须 **三层都 pass**。这削弱（不是消除）composite ad hoc 聚合的误导风险。

「方法学审计」section 里的 4 个 badge（评委一致 / 差异显著 / 已饱和 / 人工对齐）就是把这套独立检验的结论可视化，让用户在 review 时能 spot 到「composite 看上去不错但某层有问题」的情况。

---

## 5. 推荐用法

| 场景 | 用 composite？ |
|---|---|
| 同一份 eval-samples 上跑 A/B 比较，看分差 + bootstrap CI + 多层 gate | ✓ 站得住 |
| 跨 run 排序「哪次跑分最高」，挑某次报告深读 | ✓ 站得住（list / trends 页用法） |
| 给 verdict 算法吃，判 SHIP / NO-SHIP | ✓ 站得住（受多层 gate 校验） |
| 报告里说「这个 skill 4.28/5 分」当作绝对评价指标 | ✗ 等权 + 量尺不一致 + 缺失降维三重 ad hoc |
| 跨 skill 比综合分（A skill 4.5 比 B skill 3.8 强） | ✗ A/B 用的 eval-samples / 配置层数不同时不可比 |
| 跨版本声明「skill v2 的绝对水平是 4.28」 | ✗ 同上 |

**口诀**：composite 是「**比较信号**」，不是「**绝对水平**」。前者由 bootstrap CI + 多层 gate 撑住，后者撑不住。

---

## 6. 测量学不变量与未来路径

`CLAUDE.md` 里登记的不变量包含：

- Report JSON schema 字段语义
- 五层评分管道语义（assertion / llm / judge / dimension / composite）
- `judge-hash-frozen.test.ts` 冻结的 judge prompt hash
- Bootstrap CI 公式
- Length-debias toggle 语义

**改 composite 算法 = `BREAKING-COMPARABILITY`**：所有历史 report 失效，跨版本比分功能失能。这是 omk 长期信任的红线。

未来要做更严谨的聚合，路径是 **v1.0 milestone**：

1. **显式权重**：让 SKILL.md / config 声明 `weights: {fact: w1, behavior: w2, judge: w3}`，权重需论证
2. **standardize 后聚合**：各维度先 z-score 或 rank 化，再加权
3. **multivariate verdict**：把当前的「composite + 多层独立 gate 联合」升级为 multivariate hypothesis testing（Hotelling T² 或类似）
4. **scoring whitepaper**：把这套方案沉淀成可被外部审计的方法论文档

这是季度级架构变更，不是 patch 改动，也是 omk 下一步可能的 differentiator（「omk 是测量学认真的 AI eval 工具」）。

---

## 7. 引用与代码指针

- 公式实现：`src/grading/layered-scores.ts` （`computeLayeredScores` 函数）
- verdict 算法：`src/eval-core/verdict.ts` （`computeVerdict` 函数 + `verdictForPair` 多层 gate 逻辑）
- bootstrap CI：`src/eval-core/bootstrap.ts` （pairwise diff CI 实现）
- 不变量冻结测试：`test/grading/judge-hash-frozen.test.ts`
- 报告 UI：`src/renderer/summary.ts` （`renderSummaryCards` 渲染综合分列 + scoring modal）

姊妹文档：

- [统计严谨性](../explanation/statistical-rigor.md) —— Bootstrap CI / Krippendorff α / 长度去偏 / 饱和曲线
- [omk vs 同类工具](../reference/comparison.md)
- [Roadmap](../roadmap.md)
