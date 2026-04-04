# OMK Agent 评测能力校准报告

> 2026-04-04 三组控制实验验收通过

## 一、为什么要先证明"尺子是准的"

OMK 的核心价值是用数据回答"知识改了，效果变好还是变坏"。但如果评测工具本身不可信——分数差异可能来自环境串扰、缓存污染、断言失灵——那跑出来的结论就没有说服力。

所以在用 OMK 测真实业务之前，我们需要先回答一个前置问题：

> 这把尺子量出来的差异，真的是被评测对象造成的吗？

本报告记录了三组控制实验的设计和结果，用来证明 OMK 的 agent 评测能力已经通过基本校准。

## 二、尺子是什么

OMK 的 agent 评测能力本质上是一个对照实验框架：

```
输入：一组样本 × 多个 variant（= artifact + runtime context）
执行：每个组合独立跑一次 agent（claude-sdk executor）
采集：工具调用轨迹（turns + toolCalls + timing）
评分：规则断言 + LLM judge + 行为指标
输出：可量化的对比报告
```

这把尺子要精准，必须满足三个条件：

1. **环境隔离**：不同 runtime context 之间不串扰
2. **artifact 约束可观测**：注入 artifact 后行为确实改变，且可从 trace 解释
3. **断言有区分度**：断言能把不同组拉开差异，而不是全过或全挂

## 三、三组控制实验

### 实验 A：环境隔离

**验证目标**：不同 `cwd` 是否真的代表不同 runtime context。

**实验设计**：

在两个目录下各放一个 `runtime-context-check.md` 文件，内容是不同的随机 token：

| 目录 | Runtime Token |
|------|--------------|
| `examples/code-review/` | `OMK_RUNTIME_CODE_REVIEW_7F3D` |
| `examples/prd-agent/` | `OMK_RUNTIME_PRD_AGENT_9Q2L` |

三组 variant：

```bash
baseline                              # 无 cwd
project-a-env@examples/code-review    # cwd = code-review
project-b-env@examples/prd-agent      # cwd = prd-agent
```

样本要求 agent 读取 `./skills/runtime-context-check.md` 的第一行。

**结果**：

| 样本 | baseline | project-a (code-review) | project-b (prd-agent) |
|------|----------|------------------------|----------------------|
| env-001 | `NO_FILE_IN_CWD` (3.67) | `OMK_RUNTIME_CODE_REVIEW_7F3D` (4.17) | `OMK_RUNTIME_PRD_AGENT_9Q2L` (4.17) |
| env-002 | `NO_FILE_IN_CWD` (3.33) | `RUNTIME:CODE_REVIEW_7F3D` (4.33) | `RUNTIME:PRD_AGENT_9Q2L` (4.50) |

**结论**：
- baseline 无 cwd，找不到文件 → 正确
- project-a 和 project-b 读到了各自目录下的不同 token → 正确
- runtime context 隔离 **通过** ✅

---

### 实验 B：Artifact 注入

**验证目标**：显式注入 artifact（system prompt）后，agent 行为是否可观测地改变。

**实验设计**：

创建一个 `strict-reader.md` artifact，要求严格的四步工具调用流程：

1. `Bash pwd` — 确认工作目录
2. `Read` — 读取指定文件
3. `Bash wc -l` — 统计行数
4. 输出固定格式 `RUNTIME:<token>|LINES:<行数>|ARTIFACT_OK|分析完成`

两组 variant：

```bash
baseline                                    # 无 artifact
strict-reader.md@examples/code-review       # 注入 artifact + cwd
```

**结果**：

| 样本 | baseline | artifact-injection |
|------|----------|--------------------|
| artifact-001 | **1.63** | **4.83** |
| artifact-002 | **2.57** | **4.33** |

baseline 得分均低于 3，artifact 组稳定 4.3+。分差超过 2 分。

从 trace 可以看到：
- baseline：只调了 1 次 Read，没有 pwd 和 wc -l
- artifact 组：严格按 pwd → Read → wc -l 顺序执行，输出包含 `ARTIFACT_OK`

**结论**：
- artifact 注入后行为显著改变 → 正确
- 改变可从 trace 中解释（工具调用路径不同）→ 正确
- artifact 约束 **通过** ✅

---

### 实验 C：断言区分度

**验证目标**：断言能否真正区分三组 variant 的行为差异。

**实验设计**：

三组 variant 代表三种实验角色：

```bash
baseline                                    # 裸模型
project-env@examples/code-review            # 空 artifact + 项目 runtime context
strict-reader.md@examples/code-review       # 显式 artifact + 项目 runtime context
```

断言覆盖：
- `tools_called: [Read]` — 三组都应该调 Read
- `tool_output_contains: Read:OMK_RUNTIME_CODE_REVIEW_7F3D` — 只有进了正确 cwd 的组能通过
- `tool_input_contains: Bash:wc -l` — 只有 artifact 组会执行 wc -l
- `turns_min` / `turns_max` — 效率约束

**结果**：

| | baseline | project-env | artifact-injection |
|---|----------|-------------|-------------------|
| **avgScore** | 2.83 | 3.72 | **4.50** |
| **avgToolCalls** | 1 | 1.5 | 3 |
| **toolSuccessRate** | 0% | 25% | **100%** |

assertion-002 三组完美分层：1.50 → 3.61 → 4.83

OMK 分析器自动检测到 **63% 的 agent 断言具有区分度**（阈值 30%），判定为"区分度达标"。

**关键断言表现**：

| 断言 | baseline | project-env | artifact |
|------|----------|-------------|----------|
| `tools_called: Read` | ✅ | ✅ | ✅ |
| `tool_output_contains: Read:OMK_RUNTIME` | ❌ | ✅ | ✅ |
| `tool_input_contains: Bash:wc -l` | ❌ | ❌ | ✅ |

可以看到断言逐级收紧，精确地把三组拉开。

**结论**：
- 63% 断言有区分度，超过 30% 阈值 → 正确
- 三组分数递增，可从断言通过情况解释 → 正确
- 断言区分度 **通过** ✅

---

## 四、校准结论

| 维度 | 验证方式 | 结果 | 状态 |
|------|----------|------|------|
| 环境隔离 | 不同 cwd 输出不同 runtime token | baseline=NO_FILE, A=7F3D, B=9Q2L | ✅ 通过 |
| Artifact 约束 | 注入 artifact 后行为改变 | 分差 >2 分，trace 可解释 | ✅ 通过 |
| 断言区分度 | 断言能区分三组 | 63% 区分度，三组递增 | ✅ 通过 |
| 缓存隔离 | 不同 cwd 不命中同一缓存 | 三组输出不同，无串扰 | ✅ 通过 |

**总结**：OMK 的 agent 评测能力通过基本校准。可以回答以下问题：

> 实验中的结果差异，确实是由 artifact 和 runtime context 造成的，而不是工具本身的偏差。

## 五、已知局限

校准通过不代表万事大吉。以下问题仍然存在：

1. **LLM judge 噪音**：同一输出多次评分可能有 0.5 分浮动，`--repeat` 可以缓解但不能消除
2. **断言覆盖面**：当前断言主要测工具路径，对输出内容质量的断言能力偏弱
3. **样本规模**：每组只有 2 条样本，统计显著性不强。真实业务试点建议 5+ 条
4. **单模型验证**：只在 Claude Sonnet 上跑过，其他模型（GPT、Gemini）未验证

## 六、下一步

这把尺子已经够用了。接下来：

1. 进入真实业务试点（PRD skill、领域知识 agent）
2. 启动知识覆盖率（Phase 1）—— 在可信的 trace 数据上构建覆盖率报告
3. 持续积累样本，提升统计显著性
