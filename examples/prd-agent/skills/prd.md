---
name: prd
description: "生产链路快捷指令。输出现状分析+产品方案，可选输出技术实现。用法：/prd <需求> 或 /prd <需求> --tech-only"
user_invocable: true
---

# 生产链路入口

## 触发方式

- `/prd <需求描述>` — 输出现状+可行性+方案（02 文档）
- `/prd <需求描述> --tech-only` — 基于已有 02 文档，输出技术实现（03 文档）

## 知识消费模型

> **场景**：方案生成，需要做设计决策

### 三层消费模型

| 层 | 文件 | 消费方式 |
|----|------|---------|
| 方法层-基础 | domain-principles.md | **Step 0 预加载** — 始终加载，约束所有分析 |
| 方法层-设计 | solution-design-principles.md、decision-cases.md | **Step 1.5 按需加载** — 仅在需要做方案设计决策时加载 |
| 模型层（组件/映射/业务规则） | semantic-index.md、cross-repo-links.md、design.md | **Step 1 按需** — 受读取预算约束 |
| 实现层（代码） | 仓库源代码 | **Step 3 按需** — 扩展已有能力时主动消费 |

### 读取效率约束

| 约束项 | 规则 |
|--------|------|
| **总读取预算** | Step 0 之后最多再读取 **4 个文件**（不含按需加载的设计原则文件） |
| **不重复读取** | 已加载的文件不再 Read |
| **大文件按需读** | semantic-index.md（400+ 行）优先用 Grep 检索需求关键词相关行，而非全量 Read |
| **强制输出点** | Step 1.5 命中判定通过后，**立即进入 Step 4 输出**，不再读取更多文件 |

### 效率目标

| 指标 | 目标 |
|------|------|
| 入口到文档输出 | ≤ 3 分钟 |
| 模型层文件读取数 | ≤ 4 个 |
| 文件读取轮次 | ≤ 2 轮（含 Step 0 预加载共 3 轮） |

---

## 禁止行为

| 禁止项 | 原因 |
|--------|------|
| 禁止跳过 L1 售卖百科直接查代码 | L1 已有的知识不应下沉到 L3 |
| 禁止跳过 design.md 直接搜代码 | 每个 skill 必须先读 design.md |
| 禁止全局 Grep（无目录限定） | 浪费工具调用，必须限定到模块目录 |
| 禁止重复读取同一文件 | 已读内容在上下文中复用 |
| 禁止忽略意图解析阶段提供的精确路径 | 已做路径定位，直接使用 |
| **禁止向用户澄清或确认** | 生产链路全流程自动执行，技术判断自行决策 |
| **禁止调用 MCP 工具**（`mcp__domain-knowledge-search__search_aima_domain_knowledge`） | 生产链路只使用本地 L1/L2 知识。MCP 调用耗时不可控、结果质量不稳定 |
| **禁止对域外实现细节做主动断言** | 后端匹配逻辑、运营治理策略属于域外，不得推断。标注"待后端/产品确认"。**反向断言比未覆盖更危险** |

---

## 执行流程

收到触发后，按以下步骤执行。**默认模式主线程直接执行 Step 0-5，不 spawn 子 Agent。**

### Step 0：知识预加载

**仅加载基础原则**（~210 行，约束所有分析）：
- `.claude/knowledge/domain-principles.md`

**以下 2 个文件延迟到 Step 1.5 按需加载**（仅在需要做方案设计决策时）：
- `.claude/knowledge/solution-design-principles.md`
- `.claude/knowledge/decision-cases.md`

### Step 0.5：文档前置处理

**仅当参数中包含 `docs.example.com` 链接时执行**，否则跳过：

1. 从 URL 中提取 namespace 和 slug（URL 格式：`docs.example.com/{namespace}/{slug}`，协作链接需从路径中提取 `{group}/{book}/{slug}`）
2. 调用 `fetch_doc` MCP 工具获取文档内容（body 字段）
3. 将 body 写入临时文件，执行图片下载脚本：
   ```bash
   echo "$DOC_BODY" | bash .claude/scripts/download-yuque-images.sh .claude/outputs/runs/[需求目录]/images
   ```
4. 对脚本输出的每个本地图片路径，使用 **Read 工具**读取（多模态识别图片内容）
5. 将文档文字 + 图片识别结果整合为后续步骤的输入上下文

#### 行业 PRD 预处理

当输入为行业 PRD（含多域职责、大段需求描述）时，**先做域切分**：
1. 识别售卖域职责范围（前端组件、交互流程、配置能力）
2. 提取售卖域相关段落作为后续分析输入
3. 非售卖域内容标记为「域外」，不纳入分析上下文

**目的**：避免全量文档膨胀上下文，聚焦售卖域分析。

### Step 1：快速语义映射（不澄清）

从需求文本中提取关键要素，优先从下方高频关键词快速确认涉及的仓库和 Skill。

#### 高频关键词（命中后直接使用代码路径）

| 关键词 | 仓库 | Skill | 代码路径 |
|--------|------|-------|---------|
| 确认页、confirm | example-app-app | wiki-example-app-app-page | repos/example-app-app/src/pages/confirm/ |
| 确认页容器 | example-app-app | wiki-example-app-app-container | repos/example-app-app/packages/example-app/src/pages/confirm/ |
| 确认页投保按钮 | components-confirm-common-insure-button | — | repos/components-confirm-common-insure-button/src/ |
| 投保页、insure | example-app-app | wiki-example-app-app-page | repos/example-app-app/src/pages/insure/ |
| 投保页容器 | example-app-app | wiki-example-app-app-container | repos/example-app-app/packages/example-app/src/pages/insure/ |
| 投保按钮（投保页底部 Bar） | components-insure-common-insure-button | — | repos/components-insure-common-insure-button/src/index.tsx |
| 体验版、TRIAL_INSURE | example-app-app | example-app-app-dev-guide | 见 semantic-index |
| platform、insiop | example-app-app | example-app-app-dev-guide | 见 semantic-index |
| 弹窗、Dialog、Modal | example-app-app | wiki-example-app-app-example-app-ui | repos/example-app-app/packages/example-app-ui/ |
| 切面、AOP、Aspect | example-app-app | wiki-example-app-app-example-app-aspects | repos/example-app-app/packages/example-app-aspects/ |
| 产品分流、splitStrategy | example-bff | wiki-example-bff-example-app | repos/example-bff/app/modules/example-app/controller/insurePage.ts |
| 分流策略（5种） | sales-center | wiki-sales-center-SplitStrategy | repos/sales-center/src/pages/SplitStrategy/ |
| 被保人、PersonManager | example-app-app | example-app-person-manager | repos/example-app-app/src/ |
| 投保选项、insureOptions | components-insure-common-insurance-info | wiki-components-insure-common-insurance-info-src | repos/components-insure-common-insurance-info/src/ |
| 支付成功页 | example-app-app | wiki-example-app-app-page | repos/example-app-app/src/pages/pay-success/ |
| 草稿库、草稿箱 | example-bff | wiki-example-bff-example-app | repos/example-bff/src/ |

**命中后**：直接使用表中代码路径，不再读 semantic-index.md。仅在需要查看「易混淆项」时才 Grep semantic-index.md 对应章节。
**未命中时**：读 `semantic-index.md` 补充匹配，缺失时标记【推断】不阻断。

### Step 1.5：命中判定（强制决策点）

读完 semantic-index 和 cross-repo-links 后，**必须立即做以下判定，不可先读更多文件**：

#### 设计原则按需加载

**在判定路径之前，先判断是否需要加载方案设计原则文件。** 满足以下任一条件时，**并行读取** `solution-design-principles.md` 和 `decision-cases.md`：

- 需求含「新增」「新建」「扩展」「支持」等方案设计信号词
- 路径 A 判定为新能力（需要组件化决策树推导方案）
- 路径 C / 例外规则需要进入方案设计阶段

**不加载的场景**：纯现状盘点、能力查询类需求（路径 B 直接输出），跳过加载直接 Step 4。

#### 路径 A：新能力快速判定（最快路径）

> **若以下条件满足，立即判定为「新能力」→ 加载设计原则文件 → 跳转 Step 4，使用新能力模板输出：**
> 1. 语义索引无精确命中（需求核心概念在索引中无对应条目）
> 2. 能力边界声明明确标注「不支持」（查 semantic-index.md「能力边界声明」章节）
>
> **两项同时满足 → 确认为新能力，不再下沉查 design.md 或代码。** 现状直接写「当前不支持，需新建」，方案从组件化决策树推导。

#### 路径 B：已有能力命中（标准路径）

> **若以下两项均满足，且不触发例外规则，直接跳转 Step 4，跳过 Step 2/3：**
> 1. 关键模块已定位（仓库 + 代码路径已知）
> 2. 现状描述已有（落库时机 / 调用链 / 已有/缺失能力 已有文字描述）

**判定通过 → 立即 Step 4 输出。不可"顺便多读几个文件"。** 纯现状盘点无需加载设计原则文件。

#### 路径 C：模糊命中（需补充查询）

**索引部分命中但信息不足 → 进入 Step 2，但只读 1 个最相关的 design.md，读完再判定一次。**

#### 例外规则（必须进入 Step 3 代码分析）

当需求是「扩展已有能力」而非「建设全新能力」时，即使模块已定位、现状描述已有，也**必须进入 Step 3 读代码**，理解已有能力的条件分支模型。但读取范围仍受读取预算约束。

判断信号：
- 语义映射命中的模块中已有**相近功能**（如已有手机号采集，需求是扩展采集条件）
- 需求关键词含「支持」「新增」「扩展」+ 已有模块名
- 需求涉及的组件有多种渲染样式/模式（如被保人 3 种样式）

---

### Step 1.8：非本地组件远程补全

**触发条件**：Step 1/1.5 定位到的组件满足以下任一：
- `semantic-index.md` 中 `仓库位置` 非 `local`（如 `未克隆`、`ragdoll`、`—`）
- `semantic-index.md` 中未收录（关键词无命中）
- `repos/` 下无对应目录

**调用上限**：单次 `/prd` 执行中，CLI 远程查询**最多 3 次**。超出后不再调用，剩余组件标记为 `【知识缺口: CLI 调用次数已达上限】`。

**执行逻辑**：
```bash
# 按组件名模糊搜索（stderr 静默，只消费 stdout JSON）
npx --registry=https://registry.npmjs.org @example/example-app-studio-cli query --env prod --json -n "<组件名>" -s 5 2>/dev/null
# 或按 templateCode 精确查询
npx --registry=https://registry.npmjs.org @example/example-app-studio-cli query --env prod --json -t "<templateCode>" -s 1 2>/dev/null
```

**消费规则**：
- CLI 返回的元信息作为 **L2 等价知识**参与后续分析（归属页面、行业、功能描述、通用性）
- 溯源标注为 `【引用: CLI remote】`
- CLI 失败（如 AuthError、网络超时）时降级为原有 `【知识缺口】` 标记，不阻塞
- **不计入 4 文件读取预算**（CLI 调用是 Bash 工具，不是 Read）
- 优先用 1 次模糊搜索覆盖多个组件，避免逐个精确查询浪费调用次数

**无匹配时**：若 CLI 返回空结果，降级为 `【知识缺口】` 标记，继续分析。

---

### Step 2：领域知识查询（本地 L2，禁止 MCP）

按以下优先级查询，**生产模式精简规则**：
- L1 售卖百科直取，有答案即停（见 Step 1.5）
- L2 读对应仓库的 `.aima/skills/[skill]/design.md`，有答案即停，不做 L3 代码验证
- 输出关键结论，不展开溯源细节
- 知识缺口标记但不阻断

**可用工具：Read（读本地 design.md）**
**禁止工具：MCP（见禁止行为表）**

### Step 3：代码分析（按需）

**默认不搜代码**：design.md 已足够判断现状、可行性和方案形态。

**仅在方案推理需要逻辑依据时搜代码**，例如：
- 需要确认某节点是否已具备某种数据
- 需要确认执行时序（A 是否在 B 之前）
- design.md 中缺少关键信息导致无法判断可行性

搜代码时限定到具体目录，不做全局搜索。

### Step 4：整合输出

**思考顺序**（同验证链路，但精简输出）：
1. **现状**：系统里有什么、怎么运转
2. **可行性**：能不能做、约束条件
3. **方案**：应该怎么做——**必须先走组件化决策树，再看技术合理性**
   - Q1 通用能力？（多行业适配 → 是）
   - Q2-1 涉及交互？（有 UI 交互 → 是）
   - Q2-2 运营配置/管控诉求？（需要开关、按渠道差异化 → 是）
   - Q2-3 页面归platform管理？（投保页/确认页 → 是）
   - 若以上均为「是」→ 方案形态为**platform新组件**，不可因为「组件内加逻辑改动更小」而跳过决策树直接选技术最优解
   - 决策树推导完成后，再用技术合理性（改动最小、数据流最短、职责最清晰）选择组件内部的实现方式
4. **功能拆分**：将方案拆分为独立功能模块，每个模块一节
5. **组件级推导**：每个新增组件走组件化决策树（Q1-Q2），输出组件定义卡片
6. **组件模板**：涉及新页面或新售卖场景时，逐项列出页面所有组件（标注新增/复用）
7. **职责边界**：明确标注域外功能，不为域外内容输出实现方案

整合写入 `02-现状与可行性方案.md`。

### Step 5：写入日志

追加一行日志到 `.claude/outputs/logs/YYYYMMDD.log`：

```
[HH:MM:SS] [需求标识] input="原始需求" modules=[匹配模块] skills=[匹配skills] output_dir=runs/xxx duration=XXs
```

---

## `--tech-only` 模式

前置条件：同一 `runs/` 目录下已存在 `02-现状与可行性方案.md`（由 `/prd` 默认模式生成并经人工确认）。

### 主线程预处理（spawn 前）

1. 定位已有 02 文档路径
2. **提取结构化摘要**（减少 Agent 上下文负荷）：
   - 从 02 文档中提取「三、现有能力与架构」→ 涉及的仓库/模块/组件列表
   - 从 02 文档中提取「五、方案」→ 方案要点（做什么、变更类型）
   - 从 02 文档中提取「功能列表」表格 → 模块 + 变更类型
   - 摘要控制在 **30 行以内**
3. spawn `analyst-tech-only-agent`，prompt 中传入：
   - 原始需求文本
   - 02 文档结构化摘要（非全文）
   - 02 文档完整路径（Agent 需要回查细节时自行 Read）
   - 输出目录路径

### Agent 执行

Agent 按 `.claude/agents/analyst-tech-only/SKILL.md` 运行（独立 Agent，精简上下文）：
- **只加载** domain-principles.md（跳过 solution-design-principles + decision-cases）
- **跳过** 语义映射 + 知识查询（02 文档摘要已包含）
- **执行** 代码保鲜扫描 + 深度代码分析 + 03 输出

| 能力 | 默认模式 | --tech-only 模式 |
|------|---------|-----------------|
| 代码保鲜扫描 | 不扫描 | ✅ 并行 Explore Agent 验证知识断言 |
| 代码分析深度 | 按需 | 主动深入 |
| 02 文档 | ✅ 输出 | 读取摘要（不重新生成） |
| 03 技术实现 | 不输出 | ✅ 输出 |
| 知识预加载 | 1 个文件（~210 行），设计原则按需加载 | 1 个文件（~100 行） |
| 知识沉淀建议 | 依赖 smoke-test | ✅ 直接输出 |

---

## 输出

### 默认输出

```
.claude/outputs/runs/[时间戳]-[需求标识]/
└── 02-现状与可行性方案.md
```

### 带 --tech-only 参数

前置：同目录下已有 02 文档

```
.claude/outputs/runs/[时间戳]-[需求标识]/
├── 02-现状与可行性方案.md  ← 已存在（不覆盖）
└── 03-技术实现.md          ← 新输出
```

---

## 输出模板

### 售卖域产品方案

```markdown
# [需求标题] - 售卖域产品方案

> 日期: YYYY-MM-DD
> 链路: 生产链路

## 一、现状摘要

### 已有能力
[2-4 条关键能力，每条一句话]

### 缺失/不足
[1-3 条，每条一句话]

## 二、可行性结论

- **可直接实现**：[列表]
- **需后端配合**：[列表，无则省略]
- **不可行项**：[列表，无则省略]

### 关键评估点
[后端依赖、性能影响、兼容性风险、需产品/行业确认项等，无则省略]

## 三、方案

> 从用户动线推导：用户做了什么 → 自然应该发生什么 → 放在哪个节点。

### 整体方案概述
[前端视角一段话：做什么、怎么做、关键决策]

### 功能列表

| 模块 | 功能 | 变更类型 | 说明 |
|------|------|----------|------|
| 售卖域 | ... | 新建/变更 | ... |
| 行业（域外） | ... | 新建 | [标注域外，不做方案] |

### 3.1 [功能名称]

#### 组件定义（新增组件时必填）

| 字段 | 内容 |
|------|------|
| 组件名称 | 长江组件-[名称] |
| 组件类别 | 售卖通用组件 / 行业组件 |
| 应用类目 | [从 semantic-index 获取] |
| 组件C端展示位置 | [位置描述] |
| platform初始位置 | 模块列表 / 模版列表 |
| platform配置项 | [配置项列表] |
| 组件逻辑 | [业务逻辑描述] |

#### 页面组件模板（涉及新页面/新售卖场景时必填）

| 组件名称 | 组件说明 | 是否新增 |
|----------|----------|----------|
| [组件A] | [说明] | 是/否 |

#### 业务逻辑

[用户视角步骤式描述，含分支路径]

### 3.2 [功能名称]
（同上结构，按功能模块逐项展开）

## 四、相关组件（远程查询）

> 以下组件本地无代码，信息来源于 CLI remote 查询。如需深入分析，可执行对应 clone 命令。

#### [组件名]（远程查询）

| 属性 | 值 |
|------|-----|
| templateCode | `@example/xxx` |
| 归属页面 | 投保页 / 确认页 / ... |
| 归属分组 | xxx |
| 适用行业 | 通用 / 健康险 / ... |
| 通用组件 | 是 / 否 |
| 功能说明 | [functionDescription] |
| 负责人 | xxx |
| 状态 | FINISH / EDITING |

> 如需深入分析，可执行：`zsh .claude/scripts/clone-repo.sh <templateCode>`

（有多个远程组件时重复上述结构，无远程组件时省略本章节）

## 五、影响范围

- **受影响**：[页面/组件]
- **不受影响**：[页面/组件]

## 六、职责边界

- **售卖域**：[本次承接范围]
- **行业域**（域外）：[标注，不做方案]
- **其他域**（域外）：[标注]
```

---

## 知识缺口处理

生产链路对知识缺口的处理策略：**标记不阻断 + 执行完毕后统一写入待办文档**。

### 遇到缺口时（执行中）

| 场景 | 执行中处理 |
|------|-----------|
| 语义索引无匹配 | 标记为【推断】，继续分析 |
| .aima skill 不存在 | 直接读代码，记录缺口 |
| 仓库不在本地 | 先执行 Step 1.8 CLI 远程查询；CLI 也失败时标记【知识缺口】，继续分析 |
| design.md 超过 30 天 | 标记【可能过期】，继续分析，记录缺口 |

### 输出完毕后（Step 5 之后）

所有执行中积累的缺口，在 `02-现状与可行性方案.md` 写入完成、日志追加完成之后，**统一写入待办文档**：

**文件路径**：`runs/[需求目录]/06-知识缺口待办.md`

**写入格式**：

```markdown
# 知识缺口待办

> 需求: [需求标识]
> 日期: YYYY-MM-DD
> 说明: 以下缺口不影响本次分析结论，待知识库补充后可提升准确度。

| # | 缺口描述 | 类型 | 建议补充方式 |
|---|---------|------|------------|
| 1 | [具体缺失内容] | 语义索引缺失 / skill 不存在 / 仓库不在本地 / 知识过期 | 更新 semantic-index / 初始化 skill / clone 仓库 / 刷新 design.md |
```

**规则**：
- 若无任何知识缺口，**不创建此文件**
- 此文件不影响 `02-现状与可行性方案.md` 的内容和结构
- 主链路（Step 1~5）执行完毕后才写，不穿插在主流程中

---

## 注意事项

1. **必须查询语义索引**：不可凭记忆猜测代码位置
2. **全流程自动执行，不澄清**：不产生人工阻断点，技术判断（如触发时机、方案选择）自行决策，不向用户确认
3. **精简优先**：关键结论，不展开溯源细节
4. **溯源标注可省略**：生产链路不强制标注
5. **输出包含产品方案**：现状分析 + 产品方案一起输出，用户拿到即可评审
6. **方案描述用用户操作语言，不用技术节点语言**：方案面向产品经理评审，触发节点、交互流程等描述必须以用户可感知的操作为锚点。例如写「用户点击确认新增按钮，校验通过后触发存草稿库」，而不是写「checkInsureInfo 准入通过后落库」。技术节点（接口名、方法名）放在「前后端接口关联」章节中，不混入产品方案描述
7. **新增维度必须定义与现有维度的关系**：当方案涉及在现有多维度体系中新增一个维度（如命中条件、配置项、匹配规则等），必须输出新维度与现有维度的组合关系（优先级/互斥/并行/覆盖），不可只描述新维度本身而忽略与已有维度的交互。**边界**：若该关系涉及后端匹配逻辑（如命中优先级语义），不得推断，标注"待后端确认"

---

## 追加输出（按需）

- `/replay sales-pm` — 补充产品方案 PRD
