# omk 竞品深度分析

> 2026-04-03 调研整理

## 一、竞品全景

当前 Agent 评测领域的玩家分为四类：

| 类型 | 代表 | 核心思路 |
|------|------|----------|
| 轨迹评测工具 | agentevals-dev, LangChain AgentEvals | 对已有的 agent 执行轨迹做评分 |
| 通用评测框架 | DeepEval | Python 代码驱动，LLM-as-Judge |
| 学术 Benchmark | AgentBench, AgentBoard | 标准化任务集，给模型排名 |
| 商业平台 | Braintrust, Langfuse | 可观测性 + 评测 + 团队协作 |

**没有一个做的事情和 omk 一样。**

---

## 二、逐个拆解

### 1. agentevals-dev/agentevals（Solo.io）

- **做什么**：基于 OTel traces 的 agent 行为回归检测
- **优势**：云原生友好，零代码接入（已有 OTel 的前提下），K8s Helm Chart 开箱用
- **致命前提**：你的 Agent 必须已经接入 OpenTelemetry，否则先做 instrumentation
- **指标**：主要是工具调用轨迹匹配（EXACT/IN_ORDER/ANY_ORDER），LLM-as-Judge
- **它不做**：不跑 Agent，不做 prompt 对比，不做成本分析，不管最终输出质量
- **现状**：2026.3 刚发布，113 stars，API 不稳定，社区空白

**和 omk 的关系**：互补。agentevals 做的是"Agent 上线后行为有没有退化"，omk 做的是"上线前 prompt 改了效果有没有变好"。

### 2. LangChain AgentEvals

- **做什么**：对 agent 轨迹做确定性匹配或 LLM 评判
- **优势**：轻量，OpenAI 消息格式通用，不强绑 LangChain
- **核心局限**：参考轨迹需要手写，维护成本高；只评过程不评结果
- **它不做**：不评最终输出质量，不测成本和延迟，不重新执行 Agent
- **现状**：536 stars，0.0.x 阶段，API 未稳定

**和 omk 的关系**：它只有过程评测，omk 有过程 + 结果 + 成本 + 效率的完整闭环。

### 3. DeepEval

- **做什么**：Python 代码驱动的 LLM 评测框架，"Pytest for LLM"
- **优势**：14.4k stars，30+ 指标，6 个 Agent 专属指标（ToolCorrectness、TaskCompletion 等），生态最成熟
- **核心局限**：纯代码驱动（非声明式），Agent 评测强依赖 `@observe()` 装饰器侵入代码，每个 case 都要跑 LLM-as-Judge（成本高）
- **它不做**：不做声明式配置评测，不做 prompt 版本 A/B 对比，不做一条命令出报告
- **现状**：活跃维护，商业化成熟（Confident AI 云平台）

**和 omk 的关系**：最接近的"竞品"，但工作流完全不同。DeepEval 要写 Python 测试代码 + 改业务代码加装饰器；omk 写 JSON/YAML 配置 + 一条命令跑完看报告。对"改了 prompt 看效果"这个场景，omk 的路径短得多。

### 4. AgentBench + AgentBoard（学术界）

- **做什么**：给 LLM 的 agent 能力排名
- **AgentBench**：8 个任务环境，3.3k stars，需要 Docker + 多服务，重点是模型间横向对比
- **AgentBoard**：9 个任务，子目标级 progress rate 指标（亮点），但已停更
- **它们不做**：不面向 prompt 迭代，不做版本管理，不做成本分析

**和 omk 的关系**：完全不同的赛道。它们是学术排行榜，omk 是工程工具。

### 5. Braintrust（商业平台）

- **做什么**：端到端评测 + 可观测性，Playground 迭代 prompt，CI/CD 集成
- **优势**：最完整的商业方案，Playground diff 视图，AI 自动生成 scorer，25+ 内置 scorer
- **核心局限**：平台不开源，Pro 版 $249/月，自部署仍依赖云端控制面
- **Prompt 迭代**：强项。Playground + Experiment + CI/CD 流程完整

**和 omk 的关系**：如果 Braintrust 是 Figma，omk 就是一个精准解决"改 prompt 看数据"这个需求的命令行工具。Braintrust 功能全但重，omk 轻但聚焦。

### 6. Langfuse（开源平台）

- **做什么**：开源 LLM 可观测性 + 评测，MIT 协议
- **优势**：完全可自部署，Prompt A/B 测试，14.4k stars
- **核心局限**：评测是附加能力不是核心，将 trace 转评测数据集需要自建工程管道；自部署需要 PostgreSQL + ClickHouse + Redis + S3
- **运维成本**：自部署约 $3,000-4,000/月基础设施

**和 omk 的关系**：Langfuse 是基础设施级别的平台，omk 是一个 CLI 工具。用 Langfuse 做 prompt 迭代评测，你需要先部署一套平台再写工程管道；用 omk 你写个 JSON 跑条命令就行。

---

## 三、核心洞察

### 没有人在做 omk 做的事情

把所有竞品摊开看，会发现一个空白地带：

| 需求 | 谁能做？ |
|------|----------|
| 改了 prompt，一条命令看效果 | **只有 omk** |
| 声明式 JSON/YAML 定义评测 | Promptfoo（不做 agent）、**omk** |
| Agent 执行轨迹捕获 + 过程评分 | agentevals、AgentEvals、DeepEval、**omk（今天刚做完）** |
| Agent 过程 + 结果 + 成本 + 效率一站式 | **只有 omk** |
| 零侵入（不改业务代码） | agentevals（要 OTel）、**omk（只要 artifact 文件）** |
| 支持多 executor（Claude/GPT/Gemini） | **只有 omk** |
| Git 版本对比（`git:ref`） | **只有 omk** |

### omk 的真正定位

omk 不是"又一个 agent 评测框架"。它是：

**知识载体工程的质量基础设施。**

- 输入：一个 artifact（常见可以是 skill / prompt / agent 配置）+ 一组测试样本
- 输出：可量化的质量报告（分数、成本、效率、工具使用、趋势）
- 工作流：改 artifact → `omk bench run` → 看数据 → 再改

这个工作流在整个开源社区中是独一无二的。

### 竞品的软肋恰恰是 omk 的强项

| 竞品痛点 | omk 的做法 |
|----------|-----------|
| DeepEval 要写 Python 代码、加装饰器 | JSON 配置 + CLI 一条命令 |
| AgentEvals 参考轨迹要手写维护 | 断言 + rubric + LLM judge，声明式 |
| agentevals 要先接 OTel | 零前置依赖，直接跑 |
| Braintrust $249/月起 | 免费开源 |
| Langfuse 自部署要一套基础设施 | 单文件 CLI，npm 装完就用 |
| 学术 Benchmark 不面向迭代 | 天生为迭代设计（A/B、趋势、repeat） |

---

## 四、omk 的差异化壁垒

1. **场景深度**：深入知识载体工程迭代的日常，不是通用框架
2. **极低门槛**：写 JSON/YAML + 一条命令，不需要部署平台、不需要改代码、不需要 OTel
3. **多 executor**：同一套测试跑 Claude/GPT/Gemini，跨模型对比
4. **Git 原生**：`git:ref` 对比历史版本，和代码工作流无缝
5. **全维度**：质量 + 成本 + 效率 + 稳定性 + 工具使用，一份报告全覆盖
6. **内部场景**：内部真实知识载体工程经验沉淀，不是空想的抽象框架

---

## 五、还需要补的

诚实地说，omk 也有差距：

| 维度 | 现状 | 需要做的 |
|------|------|----------|
| Agent 过程评测 | 刚做完基础版（今天） | 更丰富的轨迹分析、错误模式识别 |
| CI/CD 集成 | 有 `omk bench ci` | 缺 GitHub Action、报告自动评论 PR |
| 团队协作 | 无 | 多人共享报告、评论、标注 |
| 文档和案例 | 薄弱 | 需要真实的迭代案例故事 |
| 社区 | 内部使用 | 需要开源推广 |
