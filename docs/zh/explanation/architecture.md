# 工作原理

核心思路：**固定模型 + 固定样本，只变 artifact 和 runtime context**，通过交错调度消除时间漂移，用断言 + LLM 评委双通道评分，再叠加知识缺口信号量化风险敞口。

```mermaid
flowchart TD
    subgraph Input["① 输入"]
        S["eval-samples<br/>(JSON / YAML)"]
        A["artifacts<br/>skills/*.md · SKILL.md<br/>baseline · git:name"]
    end

    subgraph Prep["② 预处理(解析与抓取)"]
        V["变体解析<br/>variant → artifact + runtime context<br/>(cwd / 项目级 CLAUDE.md / 本地 skills)"]
        U["URL 抓取<br/>prompt / context 中的 URL<br/>MCP Server(私有文档) → HTTP"]
    end

    subgraph Schedule["③ 交错调度 + 并发"]
        Q["s1-v1 → s1-v2 → s2-v1 → s2-v2 …<br/>--concurrency N · --repeat N"]
    end

    subgraph Exec["④ 执行器(固定模型)"]
        E["claude / claude-sdk / codex / openai / gemini<br/>anthropic-api / openai-api / 自定义命令"]
        T["claude-sdk 抽取<br/>turns / toolCalls trace"]
        E -.-> T
    end

    subgraph Score["⑤ 双通道评分"]
        AS["断言(18 种)<br/>内容 / 结构 / 成本 / 延迟<br/>agent: tools_called · turns_min …"]
        LS["LLM 评委<br/>rubric · dimensions(多维独立打分)"]
        CS["综合分数<br/>断言 & LLM 有则均值"]
        AS --> CS
        LS --> CS
    end

    subgraph Analyze["⑥ 自动分析 + 知识缺口"]
        D["低区分度断言 / 均匀分 / 全通过全失败<br/>高成本样本 · 方差 · t 检验"]
        G["知识缺口信号<br/>(风险敞口量化, 不证明完备)"]
    end

    subgraph Report["⑦ 报告"]
        R["六维: 事实 / 行为 / LLM 评价 / 成本 / 效率 / 稳定性<br/>JSON + HTML · 顶部 verdict pill · 盲测揭晓<br/>CLI/Node/版本指纹可追溯"]
    end

    S --> U
    A --> V
    V --> Q
    U --> Q
    Q --> E
    T --> AS
    E --> AS
    E --> LS
    CS --> D
    CS --> G
    D --> R
    G --> R
```

**关键设计：**

- **交错调度**消除时间漂移：同一样本的不同 variant 交替发出，而非 v1 全跑完再跑 v2，避免模型负载/网络波动被错误归因给 artifact。
- **variant = artifact + runtime context**：`cwd`（用 `--control-cwd`/`--treatment-cwd` 或 eval.yaml 的 `cwd:` 字段声明，与 artifact 表达式分开）让对照组可以显式声明「项目目录」这个隐性输入，把「项目级沉淀」和「显式 artifact 注入」拆开测。
- **双通道评分互补**：断言抓确定性缺陷（必须调用某工具/必须包含某字段），LLM 评委抓主观质量（可读性/完整性），两者都存在时取均值。
- **知识缺口信号**不是评分的一部分，而是一个独立追踪项：它告诉你「这次评测覆盖了多少风险敞口」，用于追踪收敛，而非断言知识「完备」。

## 六维评估指标

评测报告从六个维度独立展示结果。其中评分三层（事实 / 行为 / LLM 评价）分开展示，让你看到**是哪一层拉胯**，而不是只看到一个合成分：

| 维度 | 指标 | 说明 |
|------|------|------|
| 📋 **事实** | 事实类断言通过率 | `contains` / `json_schema` / `fact_check` 等规则可验证断言的 1-5 分映射 |
| 🛠️ **行为** | 行为类断言通过率 | `tools_called` / `tool_output_contains` / `turns_max` 等执行合规类断言 |
| 💬 **LLM 评价** | rubric 评分 | 由评委模型按预先写好的评分规则（rubric）打的 1-5 分，主观但能抓规则断言之外的「整体好不好」 |
| 💰 **成本** | 总成本、输入/输出 Token 数 | 基于 Token 消耗和模型定价的 API 费用 |
| ⚡ **效率** | 平均延迟 (ms) | 从发送请求到收到完整响应的端到端耗时 |
| 🛡️ **稳定性** | CV（变异系数） | 跨重复运行（`--repeat ≥ 2`）分数一致性；单轮评测显示 `—`，**诚实交代测不到什么** |
