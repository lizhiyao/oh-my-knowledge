import { createExecutor } from '../executors/index.js';
import { DEFAULT_GATE_THRESHOLD } from '../eval-core/verdict.js';
import type { Sample, SampleProvenance, ExecutorFn } from '../types/index.js';
import type { ObservationInboxItem } from '../types/observability.js';

/**
 * Generator 默认模型 'opus' (跟 eval 默认对齐)。
 * lean=true 路径会自动追加 `--effort low`,关掉 opus 默认的扩展思考,
 * 所以 opus + lean + effort-low 在 generator 场景下速度仍然可控(单 skill ~30-60s)。
 * 成本约 sonnet 的 5x,但 opus 在结构化指令遵循 / 长 prompt 一致性上更稳。
 * 用户想要省钱时显式 `--model sonnet` 即可。
 */
const GENERATOR_DEFAULT_MODEL = 'sonnet';

const SYSTEM_PROMPT = `你是一个评测用例生成器。你的任务是根据用户提供的 skill（系统提示词）内容，生成高质量的评测用例。

样本结构决策（必须先做）：先扫一遍 skill 内容判断它属于哪一类，按对应配比和数量生成。
- **工作流型** — skill 含"典型工作流"/"端到端"/明确多步流程章节，或描述"用户做一件事要按顺序调多个工具"的领域（端上自动化 / CI 部署 / API 编排 / 多步业务查询等）。
  → **建议 6-8 条**：约 70% 工作流样本 + 约 30% 诱错样本（tripwire，测反模式）。
- **原子型** — skill 主要是知识点 / 查询规则 / 单步动作合集，各能力间无明显先后依赖（代码评审 / SQL 优化 / 术语解释等）。
  → **建议 4-6 条**：全部用原子样本；若 skill 反模式 / 安全规则丰富（如强制白名单 / 红线检查），可拉到 6-8 条加诱错样本。
- **混合型** — 同时有多步流程章节 + 独立反模式 / 规则。
  → **建议 5-7 条**：约 60% 工作流 + 约 40% 原子样本（含诱错）。

数量决策的优先级：
1. 用户在 prompt 末尾若明确给定数量（"生成 N 个评测用例"），**优先按 N**，再按类型分配配比。
2. 用户若让你"自行判断合适数量"，按上述类型对应范围自定。
3. 数量 <= 4 时优先保证覆盖度而非配比，哪怕全用原子。

**工作流样本要点**：
- prompt 必须含编号步骤（"1. xxx  2. xxx  3. xxx"），不要写成"帮我做完整个流程"这种开放式任务
- 一条样本覆盖 4-7 个原子能力，assertion 以 **mock_hit**（每个关键步骤一条）为骨干，不要靠 contains 兜底——mock_hit 能在中间步骤失败时仍然精确告诉评测系统"挂在第几步"
- 工作流之间应彼此**正交**（各覆盖不同能力组合），不要重复测同一组

**诱错样本（tripwire）要点**：
- 短 prompt（1-2 句），prompt 故意藏与 skill 矛盾的诱导（"直接用 X 就行 / 不用检查 / 我已经知道是 Y..."），测 skill 文档里写明的反模式 / 边界 / "不要做 X"
- 必须含 **tools_not_called**（测"baseline 会犯的错"） + 1 条 tool_input_contains（测正确做法）
- 用于装不进工作流的反应式知识（如"不要用 CGEvent / 必须用 PTY 模式 / 架构兼容性提示"等）
- **必须在 sample 顶层加 \`"tripwire": true\`** — 让 omk 诊断知道"LLM fail 是预期",不要建议改 skill 文档

判断完后在内部规划好配比再开始生成。**不要**在输出 JSON 里说明判断过程或配比，直接按规划生成样本即可。

---

每个用例需包含以下字段：
- sample_id: 唯一标识，格式为 s001, s002, ...
- prompt: 用户会向使用此 skill 的 AI 提出的典型问题或指令
- context: 可选，附加上下文信息（如代码片段、文档段落等），仅在需要时提供
- rubric: **judge 评分的输入**，要写 3-5 个**可分辨好坏的判分维度**，不要写一句话总结。
  omk 的 judge pipeline 拿 rubric 让 judge LLM 看完整 trace（toolCalls + 最终输出 +
  关键中间产物）后按 rubric 每个维度逐项打 1-5 分,取均值作为该 sample 的 judge 综合分。
  rubric 写得越具体 / 越多维度,judge 给的分数区分度越高;写得空泛(如"应当正确完成
  任务")则 judge 倾向给所有 sample 都 3-4 分中位,verdict 失去信号。

  **rubric 应当涵盖的维度类型**(选 3-5 个相关的):
  1. **流程顺序**:"应先 X 再 Y"、"遇到 X 失败应当 fallback 到 Y"、"不应跳过 Z 步"
  2. **关键决策**:"识别请求属于 A 类还是 B 类"、"对边界情况(空输入 / 已存在文件)
     应当如何处理"、"用户诱导跳过 X 时应当坚持原流程"
  3. **输出结构**:"最终回答应当包含 [字段名 / 段落标题] 这几个组成部分"、"应当
     给用户明确的 next-step 指引而非含糊"
  4. **错误处理**:"工具失败时应当如实报告 + 给出降级方案,不应虚构成功"、"对
     不支持的请求应当拒绝并说明原因"
  5. **范围边界**:"应当严格遵守 skill 描述的职责边界,不主动越界做 Y 操作"

  示例:
    弱 rubric(❌): "应当正确生成评审报告"(judge 看不出"正确"是什么,只能给个中位分)
    强 rubric(✅): "应当:(1) 第一步识别当前评审属于需求阶段还是编码阶段并据此
      选 checks/ 下对应的检查清单文件,(2) 用户说'不用 git push'时仍按 SKILL.md
      默认规则把结果留档到知识库(因为'不 push'不在'temp 模式'触发词列表里),
      (3) 报告里不向用户透出红线检查的逐项细节,只给最终风险等级 + 留档链接"

  **禁忌(时间敏感数据)**: 不要在 rubric 里硬编码具体日期 / 时间戳 / 工号 / IP /
  临时 token 等会随评测时刻变化的具体值。
  - 错(❌): "应写入 temp/2026-05-07/technical/ 目录" — 跨日跑就过期
  - 对(✅): "应写入 temp/<today>/technical/ 目录(today=评测当天日期)" — 用占位
    描述,对应 assertion 用 regex 抓**模式**(如 \`temp/\\d{4}-\\d{2}-\\d{2}/technical/\`)
    而不是精确字符串。
  - 占位符约定: \`<today>\` / \`<now>\` / \`<current_user>\` / \`<random_id>\` 等用尖括号包,
    跟 judge 说"这是占位,实际值看 trace 即可"。
- assertions: **fact 层硬验证清单**,**总数 2-4 条 hard cap**(不许靠堆"测每一步参数"
  来涨数量)。omk 的评分体系是 layered scoring: **fact 层**(deterministic 字面/工具断言)
  + **behavior 层**(代价指标如 turn 数 / 工具失败率) + **judge 层**(主观语义评分,从
  sample.rubric 派生维度,judge LLM 看 trace 评 1-5)三层独立计分,verdict 是三层
  独立过 threshold(默认 ${DEFAULT_GATE_THRESHOLD})。**fact 层的本职是测 deterministic 端点,不是测轨迹**。

  **断言哲学(关键):fact 测结果+里程碑,过程质量交 judge**
  ─────────────────────────────────────────────────────────────
  fact 层断言**只测两类东西**:
    A. **结果断言**(最终产物)
       - 最终写入的文件路径/内容 → \`tool_input_contains "Write:11-knowledge-base/X.md"\`
       - 关键中间产物的字段 → \`tool_output_contains "Read:<expected-token-in-mock>"\`
       - 最终回答应当包含的不可替换字面 token(错误码 / SDK 名 / 路径片段)
       - JSON schema 命中(返回值结构正确) → \`json_schema\` 或 regex 抓固定模式
    B. **里程碑断言**(流程必经瓶颈)
       - **只有 SKILL.md 明文强约束**("必须 git push"、"必须先读 checks/X.md")
         的步骤算"里程碑",这种 sample 通常 0-2 条即够 → \`mock_hit "Tool:N"\`
         或 \`tools_called: ["Bash"]\`
       - 判别标准:你能在 SKILL.md 里 grep 到原话说"必须做 X"或"流程第 N 步要
         调 X 工具",才算里程碑。**你"觉得应该重要"** 的步骤不算 — 那是过程,
         归 judge 评。

  **fact 层不测的**(转给 sample.rubric → judge):
    - 中间步骤的具体命令/参数字面("git diff 用的是 --name-only 还是 --stat") —
      命令变体等价,字面匹配是 false-negative 噪音源
    - 工具调用顺序("应该先 stash 再 pull 还是先 pull 再 stash") — 顺序质量是
      judge 看完整 trace 才能判的语义判断
    - 错误处理路径("API 失败时应当 retry 几次" / "应当 fallback 到 X") — 同理,
      是行为质量,judge 拿 rubric 维度评分
    - "应当礼貌拒绝用户的诱导改代码请求" — 这是语义意图,rubric 维度,不是字面 token

  **典型分布**(单 sample):
    - 结果断言 1-2 条(最终产物 / 关键字段 / 错误码)
    - 里程碑断言 0-2 条(SKILL.md 明写的必经步)
    - tools_not_called 反模式断言 0-1 条(禁止接触某禁忌工具,如 tripwire sample)
    - rubric 3-5 个判分维度(细致写明 judge 该看什么),由 sample.rubric 字段承载

  *测量学背景:* 当前 omk verdict 三层独立 threshold(默认 ${DEFAULT_GATE_THRESHOLD}),fact 条目少之后单条
  权重大、单次评测方差大,**强烈建议** 评测时带 \`--repeat 2\` 或更大测稳定性(coefficient
  of variation),并参考 bootstrap CI 而非点估计。这是 fact 层稀疏化的代价,换来的是
  fact 信号干净(不被 trajectory 字面噪音污染)。

  各 fact 类型详解(下面这些都属于"结果"或"里程碑"范畴,不是"过程"):

  工具/流程类(强信号,首选):
  - { "type": "tool_input_contains", "value": "Bash:tag-list", "weight": 1 }
        ↑ 检查某 toolCall 的 input(JSON.stringify 后)包含子串。格式: "Tool:期望子串"。
        用于断言"LLM 调对了命令/参数"——这才是 skill 知识的真凭据。
        **子串选词原则**: 选**语义关键词**(命令名 / 关键工具名 / 关键参数 / SDK 函数名),
        不要选**完整命令字符串 / 精确路径 / flag 完整形态**。因为 LLM 写法常有等价变体,
        精确字符串会让正确行为也判挂。
        - 错(❌): \`tool_input_contains "Bash:grep '^temp/$' .gitignore"\` —
          LLM 用 \`grep -q\` 或加 \`~/\` 前缀就挂(全是等价写法)
        - 对(✅): \`tool_input_contains "Bash:grep"\` + \`tool_input_contains "Bash:.gitignore"\` —
          抓"用了 grep" + "操作的是 .gitignore" 这两件语义事
        - 错(❌): \`tool_input_contains "Bash:git push origin master"\` — 分支名 / remote 名都有变体
        - 对(✅): \`tool_input_contains "Bash:git push"\` — 只抓核心动作 "git push"
        路径类同理:用 \`temp/\` 而不是 \`/abs/path/to/temp/\`,用 \`.json\` 而不是完整文件名。
  - { "type": "tool_output_contains", "value": "Read:DevAPI", "weight": 0.5 }
        ↑ 检查某工具返回(被 mock 的内容)的子串,格式同上。验证"LLM 看到了关键中间产物"。
  - { "type": "tools_called", "values": ["Bash", "Read"], "weight": 0.5 }
        ↑ 必须调过这些工具。
  - { "type": "tools_not_called", "values": ["searchWorkItem"], "weight": 0.5 }
        ↑ 不得调用某工具(典型场景:不要走错的 MCP / 旧接口)。values 必须非空,
        否则 loader 直接拒;如果想表达"不要写到某路径",用 tool_input_not_contains。
  - { "type": "tool_input_not_contains", "value": "Write:/tmp/", "weight": 0.5 }
        ↑ **反向**版 tool_input_contains:某工具的输入参数**不应**包含某子串。
        典型场景:工作流不应踩到某路径 / 不该传某 flag / 临时文件不应进永久目录。
        和 not_contains 的区别 — 这条只看工具调用参数,**不看 LLM 最终文本**,
        所以 LLM 在总结里说"我没写到 X" 不会假阳性触发。
        **格式硬约束**: tool_input_contains / tool_input_not_contains / tool_output_contains /
        mock_hit 的 value **必须**是 "Tool:needle" 格式(冒号分隔,工具名 + 子串两侧均非空)。
        不要写成 \`"--force"\` / \`"lastTaskPatrol"\` 这种裸 needle — 没有工具上下文,
        loader 会直接拒。要表达"任何 Bash 调用都不该含 --force":写 \`"Bash:--force"\`。
  - { "type": "mock_hit", "value": "Bash:2", "weight": 1 }
        ↑ 校验"驱动流程": sample.mocks 数组里第 N 条(1-based)是否被命中至少一次。
        例: mocks=[A,B,C](A=PROJECT 空 / B=WORKSPACE 命中 / C=search),
        用 mock_hit "Bash:2" 强制 LLM 必须走到第 2 步(WORKSPACE 兜底),否则失分。
        threshold 字段可选,默认 >=1。
  文本类(**严格限定:只测不可替换字面量,不要测语义/论点**):

  ⛔ **绝对禁止**(产了这种就是错误,样本会被拒绝):
        contains / not_contains / contains_any / contains_all / regex 的 value/values
        **不允许**出现以下任一情况:
        (1) **含 CJK 中文字符**(留档 / 已修复 / 不阻塞 / 死循环 / 系分方案 等)
            理由:中文同义改写最厉害,"留档"/"归档"/"存档"/"记录",LLM 每次发挥都换说法。
        (2) **含空格的短语**("not safe" / "git push origin master" 等)
            理由:多 token 短语本质是自然语言片段,LLM 句式重排就挂。
            注意:测"LLM 是否调对命令" 用 tool_input_contains,**不**走 contains。
        (3) **含中文标点**(,。!?「」【】等)
            理由:含标点必是句子片段,不是 token。
        (4) **长度 > 30 字符**
            理由:超过 30 字符基本不是单 token,是句子片段了。

        ✅ **允许的 contains value 形态**(只有这一类):
        全 ASCII / 只含字母数字 + 下划线 / 连字符 / 点 / 斜杠,长度 3–30,看起来像代码 token:
        - 错误码:"ECONNREFUSED" / "EAI_AGAIN" / "E404"
        - SDK 函数名 / 类名:"skylark_doc_create" / "AsyncOperation"
        - HTTP header 名:"x-trace-id" / "Content-Type"
        - 命令 flag:"--force" / "-ff-only" / "--dry-run"
        - 路径片段:"tasks/" / "/api/v2/" / ".gitignore"

  📋 **每条 contains 系列断言自检清单**(产 sample 前必走):
        1. value 含任何中文字符? → 改用 sample.rubric 表达,**不要**写 contains
        2. value 含空格的短语? → 同上,或考虑 tool_input_contains
        3. 表达的是"LLM 应该提到 X 概念" 类语义判断? → **必须**走 rubric → judge,
           即使 value 看起来像 token 也不行
        4. 只有当 value 是机器可识别的 ASCII 代码 token / 错误码 / flag 时,
           contains 才合法

        生成 sample 时遇到诱惑想用 contains 测语义概念(如"应该说明不阻塞"、
        "应该提供建议"、"应该留档") → **强制改写**:把这点加到 sample.rubric,
        让 judge 多维度评分;不要试图用 contains_any 列同义词糊弄过去。

        以上禁令是**硬性规则**,违反的 sample 会被人工审查拒绝并要求重写。
  - { "type": "contains", "value": "code-token", "weight": 1 }
        ↑ **唯一**用法:抓代码 token / 错误码 / SDK 函数名 / 不可替换字面量(必须是
        ASCII + 长度 3–30 + 像 token 形态)。LLM 在这些字面上没有同义改写空间。
  - { "type": "contains_any", "values": ["x","y","z"], "weight": 0.5 }
        ↑ 多候选字面任一命中即过。仅在**少数有限的字面变体**场景用 — 如错误码组
        ["ECONNREFUSED","ETIMEDOUT","EHOSTUNREACH"]。**不要**用 contains_any 列同义词
        来"测概念覆盖" — 同义词永远列不全,LLM 第 N+1 次发挥总能想出第 N+1 个写法。
  - { "type": "contains_all", "values": ["X","Y"], "weight": 1 }
        ↑ 必须同时包含全部字面 token(如某 API 响应应同时含两个具体字段名)。
  - { "type": "not_contains", "value": "...", "weight": 0.5 }
        ↑ 只查 LLM **最终文本**不应出现某固定字面 token。**不要**用它表达"不应踩到 X" —
        LLM 在总结里复述"已避开 X" 会自触发假阳性。"工具调用层面不该走"→
        tool_input_not_contains 或 tools_not_called。
  - { "type": "regex", "pattern": "...", "weight": 1 }
        ↑ 同 contains 限制:只用在固定格式字面量(如 SHA / UUID / 路径模板)。
- environment: 可选,对象。**评测环境的"已就绪"声明**,LLM 看到后跳过环境探测直接进工作流。
  字段:
    - cli_available: string[],已在 PATH 上的 CLI(如 ["node", "git", "code-host"])
    - files_available: string[],已存在的文件/脚本(如 ["~/.req-tool-api.json", "$SKILL_DIR/scripts/x.js"])
    - notes: string,自由文本兜底(如"DevAPI 凭证有效,工号 testuser001")
  原则:
    凡是 skill 跑起来需要的环境(凭证文件 / 业务 CLI / 自带脚本 / API token 等),
    都写到这里,而不是在 mock 里 mock 它们的探测命令。这让 mock 只关注业务调用本身。
- mocksStrict: **必填且必须设为 true**(只要 sample 配了 mocks)。
  原因:mocksStrict=false 时,LLM 调到没匹配 mock 的命令会**透传到真 shell**,
  既可能真调外部接口产生副作用,也可能因二进制不存在(如 mcporter)报噪声错误污染评测信号。
  评测目的是在隔离环境下测 LLM 行为,不是测真接口可用性 — 总是 strict。
- mocks: 可选,数组。该 sample 跑评测时拦截工具调用 + 返回 stub。**避免真调外部接口/CLI/MCP/写状态**。
  生成原则:
    1. **mocks 覆盖范围 = 业务调用 + 工作流前置 / 校验步骤** —
       (a) 业务调用(submit / create / push / search ...) 必 mock
       (b) **工作流前置 / 校验步骤**(skill 强制要求的检查动作,如 \`ls -la\` 检查目录是否存在、
           \`grep -q\` 检查 .gitignore、\`git status\` 看是否干净等)**也必须 mock**,因为它们
           会被 mocks-strict 拦截 — 这是 obsidian / 知识库整理 / 部署类 skill 大量挂在
           "环境拦截"的根因。
           **关键**:这些前置步骤的 assertion 通常是 \`tools_called: ["Bash"]\` 或
           \`tool_input_contains "ls -la"\`,意味 LLM 必须真调这些命令。如果 mock 没盖,
           LLM 行为完全正确还是会因为 mocks-strict 拦截而挂。
           - 错(❌):rubric 要求"先 ls -la 检查目录",但 mocks 数组里没 \`{tool:"Bash",
             match:{command_glob:"ls *"},return:{...}}\`,LLM 调 ls 就被拦,工作流断在第 0 步
           - 对(✅):写一条宽 mock:\`{tool:"Bash", match:{command_glob:"ls *"},
             return:{stdout:"<模拟目录列表>", exit:0}}\` — \`command_glob\` 用 \`*\` 兜底各种
             ls 参数变体(\`ls\` / \`ls -la\` / \`ls -d\` / \`ls /xx\` 全命中)
       (c) 单纯"已就绪"声明(凭证文件 / 业务 CLI 是否安装)还是走 \`environment\` 字段,
           不需要 LLM 真调命令检查 — environment 字段就是告诉 LLM "这些不用检查"。
       (d) **intent-level mock(文件搜索/读取类操作)** — LLM 搜代码时会自由选择 Bash grep、
           Grep 工具、Glob+Read 组合、甚至 Agent 子代理,逐个枚举工具写 mock 不可持续。
           正确做法:用 \`tool: "*"\` + \`input_contains: "关键词"\` 按意图匹配:
           - 对(✅):\`{tool:"*", match:{input_contains:"FinTradeBuySpi"}, return:"<sofa:service unique-id=\\"finfundtrade-buy-spi\\">..."}\`
             — 不管 LLM 用什么工具搜,只要输入提到 FinTradeBuySpi 就命中
           - 错(❌):\`{tool:"Bash", match:{command_glob:"*grep*FinTradeBuySpi*"}, ...}\`
             — LLM 用 Grep 工具或 Read 就 miss,strict 模式下直接挂
           HTTP/curl 类调用模式可预测(必须用 Bash 跑 curl),继续用 \`tool:"Bash"\` + \`command_glob\`。
    2. **mock 数据要"驱动流程"而非"提前给答案"** — 这是关键:
       - 如果 skill 描述的工作流是多步的(A→B→C),mock 数据要**让最终答案只在最后一步出现**,
         前面的 mock 只能给出"推进到下一步必需的中间产物",不能直接揭示完整答案。
       - 反例(❌):第 1 步 mock 直接返回完整答案 → LLM 觉得"够了"跳过后续步骤,
         评测拿不到"是否走完合规流程"的信号。
       - 正例(✅):第 1 步 mock 返回空 / 局部 / 索引 ID → LLM 必须用这个中间产物去调下一步,
         一直走到最后一步才能拿到最终答案。
       - 例:req-tool 查标签工作流(PROJECT tag-list → WORKSPACE tag-list → tag-search):
         * 错的设计:PROJECT 直接返回 \`[{tagName:"Daily",count:99}]\` → LLM 跳过 WORKSPACE
         * 对的设计:PROJECT 返回 \`[]\`,WORKSPACE 返回 \`[{tagId:"W001",tagName:"Daily"}]\`,
           tag-search 用 \`W001\` 才返回最终工作项列表
    4. write 类调用(submit / create / push)mock 返回成功响应即可
    5. 不要 mock LLM 内部 think/text 行为,只 mock 外部副作用工具
  mock 项 schema:
    {
      "tool": "Bash" | "Read" | "Edit" | "Write" | "WebFetch" | "Grep" | "Glob" | "*",
      // "*" 通配任何工具名(intent-level mock):LLM 可能用 Bash grep、Grep 工具、
      // Glob+Read 组合、甚至 Agent 子代理做同一件事。用 "*" 配合 input_contains
      // 按意图匹配,不用逐个枚举工具。
      "match": {
        "file_path_endswith": "<相对路径后缀,如 tasks/foo/state.json>",  // 推荐用这条 (Read/Edit/Write)
        "file_path": "<完整路径,~ 或绝对>",            // 仅当能预测完整 path 时用,否则首选 _endswith
        "url": "<exact url>" or "url_glob": "<glob>",  // WebFetch
        "command_glob": "<glob>",                       // Bash 拦 mcporter / cli
        "input": { "<key>": "<value>" },               // generic deep-equal subset
        "input_contains": "<子串>"                       // 递归扫描 tool_input 所有 string 值,大小写不敏感;
                                                         // 配合 tool:"*" 做 intent-level mock
      },
      "return": "<string>" or { "stdout": "...", "exit": 0 },
      "return_seq": [<r1>, <r2>]   // optional 状态机:同 mock 多次命中按序返回
    }
  **file_path 匹配的关键陷阱**:
    - claude-cli / claude-sdk 的 PreToolUse hook 拿到的 file_path 是 LLM 原话 — LLM 经常把
      相对路径写成绝对(尤其当 environment.notes 给了 cwd 提示),mock 用 file_path 严格相等
      会 miss 整条 sample。**默认用 file_path_endswith 后缀匹配**(actual 等于 suffix
      或在路径分隔符后以 suffix 结尾即命中),无论 LLM 传相对、绝对、~ 起头都能命中。
    - 仅当 sample 明确给了 absolute path 且要测 LLM 用对完整路径(如 ~/.config/x.json)时才
      用 file_path 严格相等。
  command_glob 示例:
    - "mcporter call * --tool find_drm_value*"   (拦 MCP find_drm_value 调用)
    - "code-host pr show *"                         (拦 code-host CLI)
    - "git push *"                                (拦 git push)

要求：
1. 评测用例应覆盖 skill 的不同能力维度
2. prompt 要贴近真实用户的使用场景
3. rubric 要具体，不要泛泛而谈
4. assertions 要有区分度，能检测出有无 skill 的差异
5. assertions 的 value / pattern / values / reference 必须使用英文、数字或代码 token，不要使用中文关键词。
6. 断言应检测 skill 文档中的具体细节（如特定参数名、配置值、工作流步骤），而非通用知识。
   避免使用 baseline 凭常识或搜索文件也能答对的断言（如 not_contains 通用错误写法）。

   ⛔ **不许凭空具体化** — 这是 generator 的最大反模式之一:
   如果 SKILL.md 描述了某个步骤但**没明文指定该步用什么工具 / 什么命令 / 什么 API**
   （只说"留档到 X"、"通知 Y"、"调用第三方服务 Z"这种意图描述,不说具体 tool / endpoint），
   **fact 层断言不许猜测具体工具名**:
   - ❌ 错的做法:SKILL.md 说"留档到语雀",generator 自己脑补"语雀 = URL = WebFetch",
        产 \`tool_input_contains "WebFetch:语雀URL"\` + \`mock_hit "WebFetch:N"\` —
        这是在测 generator 自己的脑补,不是 SKILL 实际要求,LLM 一选别的工具就判挂
   - ❌ 错的做法:SKILL.md 说"通知钉钉",generator 假设走 Bash + 某个钉钉机器人 URL —
        SKILL.md 没说就别假设
   - ✅ 对的做法:把这个"应当完成的任务"写进 sample.rubric,让 judge 按 rubric 评分,
        工具选择交给 LLM 自由发挥,judge 看意图(任务完成与否)而不是字面(用了哪个工具)
   - ✅ 兜底做法:如果一定要测"必须调到某工具",也只在 SKILL.md 明文说过该工具时才用
        tool_input_contains;否则用 tools_called 列一组"可接受工具"也比单写一个稳
   判断标准:**写 sample 时,如果你需要去 SKILL.md 外的知识(推断"语雀对应什么工具"、
   "通知钉钉用什么 API")才能写出 fact 层断言,这条断言就不该存在,应该归到 rubric。**

   📌 **URL/路径出现在 SKILL.md 里 ≠ 知道用什么工具访问它**(高频陷阱):
   SKILL.md 文档里出现 \`https://wiki.example.com/xxx/yyy\` 这种 wiki 形态 URL,**不代表**
   该步骤就走 WebFetch。WebFetch / WebSearch 是 readonly GET 类工具,**只用于
   "读取 / 抓取 / 查询 / 搜索" 语义**。SKILL.md 描述是"留档 / 写入 / 创建 / 推送 /
   通知 / 上传"这类**写动作**,而又没明文说"用 X 工具调"时:
   - ❌ 不要产 \`tool_input_contains "WebFetch:irk5ik/kg7h1z"\` —— WebFetch 不写入,
        LLM 调它也是 GET,断言铁定挂
   - ❌ 不要假设 "URL 出现 = 该用 WebFetch" 的联想链,SKILL.md 给 URL 经常只是
        说明性指向(告诉读者"我们的知识库地址"),不是规定 LLM 必须 fetch 它
   - ✅ 把"应当留档到 X"写进 rubric,工具留给 LLM/judge 决定。如果作者真的知道
        写语雀用什么 CLI/MCP(比如 \`skylark-doc\`),要么 SKILL.md 明文写,要么
        sample.environment.cli_available 加上,fact 层断言才有依据
   - ✅ 自检:在产 \`tool_input_contains "T:needle"\` 之前,grep 一下 SKILL.md
        看有没有出现过工具名 T(WebFetch / Bash / Read / Edit / Write / Glob /
        Grep / 某 MCP 名),没出现就别用这个工具名 — 不许猜


   **断言类型选择口诀**(fact 层只测**结果 + 必经里程碑**,过程质量交给 judge 评 rubric):

   ✅ fact 应该测的(结果 / 里程碑):
   - 测"最终产物是否写对" → tool_input_contains 抓 Write 的目标路径片段 /
     tool_output_contains 抓 Read 命中的关键字段
   - 测"最终回答包含某不可替换字面"(错误码 / SDK 函数名 / 路径 token) → contains(单值,
     value 必须是 ASCII token 形态,见上方"绝对禁止"清单)
   - 测"必经的工具调用里程碑"(SKILL.md 明文强约束的步骤) → mock_hit "Tool:N" 或
     tools_called: ["Bash", "Read"]
   - 测"必须**没**调用某禁忌工具"(tripwire / 反模式) → tools_not_called(values 必须
     给具体工具名,不能空数组,见上方 loader 校验)
   - 测"工作流不应踩到某路径或 flag" → tool_input_not_contains "Tool:needle"(注意
     不要用 not_contains — 那是扫文本输出的,LLM 在总结里复述就自触发)

   ❌ fact **不应该**测的(都属于"过程/语义",归 rubric → judge 评):
   - "中间步骤的具体命令字面"("git diff 用了 --name-only 没") — 命令变体太多
   - "工具调用的顺序"("先 stash 再 pull" / "先识别阶段再读 checks") — 顺序质量是
     judge 看完整 trace 的活,不是 fact 层一条 assertion 能表达的
   - "错误处理路径"("API 失败时是否重试 / 是否 fallback") — 行为质量,rubric 维度
   - "LLM 是否礼貌拒绝用户的诱导请求" — 语义意图,rubric 维度,judge 看意图不看字面
   - "LLM 是否在解释中说明了 X 概念" — contains 字面挂"不阻塞"/"暂停"这种汉字 token
     在 7 道 prompt 演进 + hardcode sanitize 之后已经被 strip 干净了,不要再尝试

   **数量配额**(hard cap):**每个 sample 总共 2-4 条 fact 断言** — 不许靠堆"测每一步
   工具参数"涨数量,多出来的都是 trajectory 噪音。如果你觉得 2-4 条覆盖不完作者意图
   的细节,把那些细节写进 sample.rubric 让 judge 按维度评分 — judge 信号本来就比"某
   汉字是否出现在 trace"更接近"任务做没做对"。

   *跟测量学的关联:* fact 条目稀疏化后单条权重相对大、单次评测方差变大,跑评测时
   建议带 \`--repeat 2\`(或更大)测同 variant 内部 coefficient of variation,看 bootstrap
   CI 下限而非点估计。这是 fact 干净换稳定性的等价交换,omk eval CLI 在 N<20 且
   --repeat=1 时已有 stderr 警告提醒。
7. 如果 skill 涉及外部调用(MCP/CLI/HTTP/文件读),**必须**为本 sample 生成 mocks 数组,
   保证评测时 0 真调底层。query 类返回贴近真实 schema 的示例数据,write 类返回 success。

可选元数据字段如能判断顺便填，无法判断时省略整个字段即可）：
- capability: string[] — 该用例覆盖的能力维度。**值必须是中文短语**，描述这条 sample 在测什么能力，如 ["接口选择", "错误诊断", "PR 编号解析", "多步工作流"]。**不要用英文 slug 形式**(如 ❌ "api-selection" / "pr-iid-resolution")。专有名词(API / PR / SQL / SDK)可以保留英文,但短语主体用中文。
- difficulty: "easy" | "medium" | "hard" — 难度等级。**值保持英文 enum**(系统识别符,UI 会自动展示成"容易/中等/困难")。
- construct: string — 用例测的 construct 类型。**值用中文**,三选一:"必要性"(测知识必要性,LLM 没 skill 时该 fail)/"质量"(测 skill 写得好不好)/"能力"(测某具体能力)。
- **tripwire: true** — **此 sample 是诱错样本时必填**。诱错样本(tripwire)= 故意诱导 LLM 走错的样本(用户用错前提 / 跳步骤 / 用错参数类型),目的是测 skill 是否能让 LLM 识破并纠正,**LLM 失败是预期结果**。
  影响:omk 评测时,diagnostic 看到 tripwire:true 不会建议改 skill(因为 LLM 该 fail),避免误导 skill 作者。
  典型识别:prompt 含"直接用 X 就行了"/"不用检查"/"我已经知道是 Y"等用户错误前提诱导 + assertions 含 tools_not_called 或反模式断言 + construct 通常是 "necessity"。
  规则:诱错样本必填 tripwire:true。普通 capability sample 不要写 tripwire 字段。

**JSON 输出规范（必须遵守）**：
- 直接输出 JSON 数组，不要包含 markdown 代码块标记或其他文字
- 字符串字段（prompt / rubric / capability 等）内部如需引号，**必须用全角「」**而不是半角 \`""\`，避免漏转义破坏 JSON 解析
- 例：错 → \`"prompt": "查询"Daily"标签..."\`（内部 \`"\` 未转义，JSON 解析失败）
       对 → \`"prompt": "查询「Daily」标签..."\`（全角引号，无转义压力）`;

interface GenerateSamplesOptions {
  skillContent: string;
  count?: number;
  model?: string;
  executorName?: string;
  /**
   * 自然语言描述用户希望重点覆盖的场景。会作为额外约束追加到 prompt 末尾，
   * 优先于"自由发挥"的多样性。空串 / undefined 表示不施加额外约束。
   */
  focus?: string;
  /** 不生成 mocks/mocksStrict，eval 时真实执行所有工具调用。 */
  noMock?: boolean;
}

/**
 * 拼出送给 LLM 的 user prompt。抽出来便于单测验证 focus 是否真的注入了。
 *
 * count 语义:
 *   - number: 强制生成 N 条
 *   - undefined: 让 LLM 按系统提示里"样本结构决策"的类型对应范围自行判断数量
 */
export function buildSamplesPrompt({ skillContent, count, focus, noMock }: { skillContent: string; count?: number; focus?: string; noMock?: boolean }): string {
  const focusBlock = focus && focus.trim()
    ? `\n\n额外要求（用户指定的场景重点）：\n${focus.trim()}\n生成的用例必须优先覆盖以上场景，再在剩余配额内补充其它能力维度。`
    : '';
  const noMockBlock = noMock
    ? '\n\n⚠️ 不要生成 mocks 和 mocksStrict 字段。评测时所有工具调用将真实执行，不做拦截。'
    : '';
  const countLine = typeof count === 'number'
    ? `请根据这个 skill 生成 ${count} 个评测用例。`
    : `请根据这个 skill 自行判断合适的数量并生成评测用例（参考系统提示中"样本结构决策"对应类型的数量范围）。`;
  return `以下是需要评测的 skill 内容：

${skillContent}

${countLine}直接输出 JSON 数组。${focusBlock}${noMockBlock}`;
}

export async function generateSamples({ skillContent, count, model = GENERATOR_DEFAULT_MODEL, executorName = 'claude', focus, noMock }: GenerateSamplesOptions): Promise<{ samples: Sample[]; costUSD: number }> {
  const executor = createExecutor(executorName);

  const prompt = buildSamplesPrompt({ skillContent, count, focus, noMock });

  // 生成场景比单次 eval 调用更重(LLM 要思考结构 + 输出大段 JSON),
  // 默认 120s 对长 skill + count >= 8 经常不够,这里用 5 分钟兜底。
  // lean=true 关掉 agent 工具循环 / skill 发现 — 生成只需要纯文本,不需要 Bash / Read 等工具。
  // 重试机制:LLM 偶尔输出 JSON 内含未转义引号 / 截断 / 多余文字。最多 2 次额外尝试,
  // 第二次起在 prompt 末尾追加上一次的错误反馈,引导模型自纠。
  const MAX_ATTEMPTS = 3;
  let lastErr = '';
  let totalCost = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const attemptPrompt = attempt === 1
      ? prompt
      : `${prompt}\n\n上一次输出解析失败:${lastErr}\n请严格按 JSON 规范输出(字符串内部用「」全角引号),只输出数组,不要包含其他文字。`;
    const result = await executor({ model, system: SYSTEM_PROMPT, prompt: attemptPrompt, timeoutMs: 300_000, lean: true });
    totalCost += result.costUSD || 0;
    if (!result.ok) {
      lastErr = result.error || 'unknown error';
      if (attempt === MAX_ATTEMPTS) throw new Error(`generation failed after ${MAX_ATTEMPTS} attempts: ${lastErr}`);
      continue;
    }
    let jsonStr = result.output!.trim();
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1].trim();

    let samples: Sample[];
    try {
      samples = JSON.parse(jsonStr);
    } catch (e) {
      lastErr = `JSON 解析失败: ${(e as Error).message}`;
      if (attempt === MAX_ATTEMPTS) throw new Error(`generation failed after ${MAX_ATTEMPTS} attempts (JSON invalid): ${lastErr}`);
      process.stderr.write(`[omk improve samples] 第 ${attempt} 次输出 JSON 无效,重试中...\n`);
      continue;
    }
    if (!Array.isArray(samples) || samples.length === 0) {
      lastErr = '输出为空数组';
      if (attempt === MAX_ATTEMPTS) throw new Error(`generation failed after ${MAX_ATTEMPTS} attempts: ${lastErr}`);
      continue;
    }
    // 通过校验,跳出循环继续后续 sanitize
    return await finalizeSamples(samples, totalCost, skillContent);
  }
  // 不可达 (循环里所有出口都 throw 或 return),保留是为了 TS 类型推断
  throw new Error('unreachable');
}

async function finalizeSamples(
  samples: Sample[],
  costUSD: number,
  skillContent: string,
): Promise<{ samples: Sample[]; costUSD: number }> {
  // Validate required fields + sanitize metadata enums *at generator boundary*
  // (see sanitizeGeneratedSamples). skillContent is passed so the function can
  // strip "脑补"-style fact assertions whose tool name has no literal mention
  // in SKILL.md — closes the prompt-can't-fully-suppress-this gap exposed by
  // the data-security-review v1-v5 regen series (generator kept producing
  // tool_input_contains "WebFetch:语雀URL" even after 7 prompt iterations,
  // because LLM's "URL → fetch" training prior overrides instructional text).
  const { stripped } = sanitizeGeneratedSamples(samples, { skillContent });
  if (stripped.length > 0) {
    process.stderr.write(
      `[omk sample] LLM-output 含 ${stripped.length} 个非法元数据/断言字段，已剥离避免污染：\n  - ${stripped.join('\n  - ')}\n`,
    );
  }

  return { samples, costUSD };
}

const TRACE_GEN_INSTRUCTIONS = `下面给出的不是 skill，而是从生产会话 trace 中观测到的失败 / 异常信号。请为这些信号生成评测用例（eval samples），使评测能复现并守住这些失败模式——把线上真实发生过的问题沉淀成回归用例。

要求：
- 按各信号标注的「占比」分配用例数：高频信号多生成、低频少生成，让用例集覆盖线上失败的真实频次分布（高占比信号 2-3 条，低占比 1 条即可）；信号若是噪声 / 证据不足 / 无法复现，跳过它，不要硬凑。
- prompt 要还原触发该信号的场景（自然语言任务），不要直接复述证据文本。
- 断言优先用 mock_hit / tools_called / tools_not_called / tool_input_contains 精确锚定失败步骤，再用 contains 兜底；按「原子型」配比处理（无需工作流编号步骤），除非证据明显是多步流程。
- 不要在输出里说明判断过程，直接输出 JSON 数组。`;

type TraceSignalItem = Pick<
  ObservationInboxItem,
  'skillName' | 'signalType' | 'signalSubtype' | 'severity' | 'evidence' | 'messageWindow' | 'occurrences'
>;

export interface StratifiedTraceSignal extends TraceSignalItem {
  /** Share of total occurrences across all signals (0-1) — drives proportional
   *  sample allocation in the prompt. */
  weight: number;
}

/**
 * Cluster byte-identical signals (same type / subtype / evidence), summing their
 * occurrences, then rank by frequency and annotate each with its share of the
 * total. Lets `omk sample --from-traces` allocate samples *proportional to how
 * often a failure actually happened* instead of a flat "1-2 per signal" — a
 * failure seen 100× deserves more regression coverage than one seen twice. The
 * observation inbox already dedups upstream, so the merge here is a defensive
 * no-op in the normal path; it only matters if a caller passes raw items.
 *
 * Does NOT fix the underlying selection bias (traces only capture *failures*),
 * which is why the `omk sample --from-traces` draft warning still stands — this
 * only makes the within-failure distribution representative of frequency.
 */
export function stratifyTraceSignals(items: TraceSignalItem[]): StratifiedTraceSignal[] {
  const merged = new Map<string, TraceSignalItem>();
  for (const it of items) {
    const key = `${it.signalType} ${it.signalSubtype} ${JSON.stringify(it.evidence ?? {})}`;
    const prev = merged.get(key);
    if (prev) {
      prev.occurrences += it.occurrences ?? 0;
    } else {
      merged.set(key, { ...it, occurrences: it.occurrences ?? 0 });
    }
  }
  const clustered = [...merged.values()];
  const total = clustered.reduce((sum, it) => sum + it.occurrences, 0) || 1;
  return clustered
    .map((it) => ({ ...it, weight: it.occurrences / total }))
    .sort((a, b) => b.occurrences - a.occurrences);
}

/**
 * Build the generation prompt for `omk sample --from-traces`. Renders each
 * observation-inbox signal (evidence + message window) into a section and asks
 * the generator to synthesize regression samples that reproduce the observed
 * production failures. The trace text feeds the *generator* only — never the
 * judge prompt — so judge-prompt isolation is unaffected.
 */
export function buildSamplesFromTracesPrompt(items: TraceSignalItem[], count?: number): string {
  // 先按频次分层(合并重复 + 算占比 + 降序),让模型按「占比」分配配额,而非每信号一刀切。
  const stratified = stratifyTraceSignals(items);
  const sections = stratified.map((it, i) => {
    const ev = it.evidence ?? {};
    const evLines = [
      ev.tool && `工具: ${ev.tool}`,
      ev.query && `查询/输入: ${ev.query}`,
      ev.path && `路径: ${ev.path}`,
      ev.outputSnippet && `输出片段: ${ev.outputSnippet}`,
      ev.assistantSnippet && `助手片段: ${ev.assistantSnippet}`,
      ev.markerToken && `标记: ${ev.markerToken}`,
    ].filter(Boolean).join('\n') || '(无结构化证据)';
    const win = it.messageWindow
      ? '\n上下文消息:\n' + [...it.messageWindow.before, ...it.messageWindow.event, ...it.messageWindow.after]
        .map((m) => `  [${m.role}] ${m.snippet}`).join('\n')
      : '';
    const pct = (it.weight * 100).toFixed(0);
    return `### 信号 ${i + 1}：${it.signalType} / ${it.signalSubtype}（严重度 ${it.severity}，出现 ${it.occurrences} 次 · 占比 ${pct}%，skill: ${it.skillName}）\n${evLines}${win}`;
  }).join('\n\n---\n\n');

  const countLine = typeof count === 'number'
    ? `共生成约 ${count} 条评测用例,按各信号的「占比」分配配额(高频多、低频少),覆盖整体失败分布。`
    : '按各信号「占比」分配:高频信号多生成、低频少生成,覆盖整体失败分布。';

  return `${TRACE_GEN_INSTRUCTIONS}

## 观测到的失败信号（共 ${stratified.length} 个，已按出现频次降序）

${sections}

${countLine}直接输出 JSON 数组。`;
}

/** Build a sanitize context string from trace evidence so finalizeSamples keeps
 *  tool-name assertions that reference tools actually seen in the traces (an empty
 *  context would strip every tool-name fact assertion). */
function traceSanitizeContext(items: TraceSignalItem[]): string {
  return items.map((it) => {
    const ev = it.evidence ?? {};
    return [ev.tool, ev.query, ev.path, ev.outputSnippet, ev.assistantSnippet, ev.markerToken]
      .filter(Boolean).join(' ');
  }).join('\n');
}

export interface GenerateSamplesFromTracesOptions {
  items: TraceSignalItem[];
  count?: number;
  model?: string;
  executorName?: string;
  /** Injectable executor (tests). Defaults to createExecutor(executorName). */
  executor?: ExecutorFn;
}

/**
 * Generate draft eval samples from production-trace observation signals. Mirrors
 * generateSamples' executor / retry / finalize path but feeds the trace prompt and
 * stamps `provenance: 'production-trace'`. Output is meant to land in a review draft,
 * not the live dataset (the CLI enforces that).
 */
export async function generateSamplesFromTraces({
  items,
  count,
  model = GENERATOR_DEFAULT_MODEL,
  executorName = 'claude',
  executor: injectedExecutor,
}: GenerateSamplesFromTracesOptions): Promise<{ samples: Sample[]; costUSD: number }> {
  if (items.length === 0) return { samples: [], costUSD: 0 };
  const executor = injectedExecutor ?? createExecutor(executorName);
  const prompt = buildSamplesFromTracesPrompt(items, count);
  const sanitizeContext = traceSanitizeContext(items);
  const PROVENANCE: SampleProvenance = 'production-trace';

  const MAX_ATTEMPTS = 3;
  let lastErr = '';
  let totalCost = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const attemptPrompt = attempt === 1
      ? prompt
      : `${prompt}\n\n上一次输出解析失败:${lastErr}\n请严格按 JSON 规范输出(字符串内部用「」全角引号),只输出数组,不要包含其他文字。`;
    const result = await executor({ model, system: SYSTEM_PROMPT, prompt: attemptPrompt, timeoutMs: 300_000, lean: true });
    totalCost += result.costUSD || 0;
    if (!result.ok) {
      lastErr = result.error || 'unknown error';
      if (attempt === MAX_ATTEMPTS) throw new Error(`trace generation failed after ${MAX_ATTEMPTS} attempts: ${lastErr}`);
      continue;
    }
    let jsonStr = result.output!.trim();
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1].trim();
    let samples: Sample[];
    try {
      samples = JSON.parse(jsonStr);
    } catch (e) {
      lastErr = `JSON 解析失败: ${(e as Error).message}`;
      if (attempt === MAX_ATTEMPTS) throw new Error(`trace generation failed after ${MAX_ATTEMPTS} attempts (JSON invalid): ${lastErr}`);
      process.stderr.write(`[omk sample --from-traces] 第 ${attempt} 次输出 JSON 无效,重试中...\n`);
      continue;
    }
    if (!Array.isArray(samples)) {
      lastErr = '输出不是 JSON 数组';
      if (attempt === MAX_ATTEMPTS) throw new Error(`trace generation failed after ${MAX_ATTEMPTS} attempts: ${lastErr}`);
      continue;
    }
    // Empty array = the model conservatively skipped every signal (the trace prompt
    // explicitly permits this when signals are noise / unreproducible). That's a valid
    // 0-result, not a failure — return it so the CLI can no-op instead of erroring.
    if (samples.length === 0) return { samples: [], costUSD: totalCost };
    // Stamp provenance before sanitize so it survives (it's a valid enum value).
    for (const s of samples) s.provenance = PROVENANCE;
    return await finalizeSamples(samples, totalCost, sanitizeContext);
  }
  throw new Error('unreachable');
}

/**
 * Validate + sanitize LLM-generated samples at generator boundary.
 *
 * Why this exists:
 *   LLM-output garbage (`capability: 'string'` / `difficulty: 'Easy'` /
 *   `provenance: 'invalid'`) shouldn't get persisted to disk and trip
 *   `loadSamples` on the NEXT run/diagnose. We strip invalid metadata fields
 *   with a stderr warn (don't throw — valid required fields should still
 *   produce usable samples).
 *
 * Assertion-level sanitize (hard rules complementing SYSTEM_PROMPT soft guidance —
 * prompt-only path was proven insufficient: data-security-review v1-v5 regens kept
 * producing the same WebFetch-on-URL hallucination across 7 prompt revisions):
 *
 *   A. Text-class assertion value (contains / not_contains / contains_any /
 *      contains_all / regex.pattern) must not contain CJK characters,
 *      fullwidth punctuation, internal ASCII whitespace, or be out of
 *      length range [2, 40]. LLM's natural text matches are unstable under
 *      synonym rewriting, so a literal Chinese-phrase contains is guaranteed
 *      noise — it either misses on every alternative phrasing the LLM picks
 *      next run, or triggers on the LLM's own summary mentioning the
 *      forbidden word.
 *
 *   B. Positive tool-bound assertion (tool_input_contains / tool_output_contains /
 *      mock_hit) must have a tool name (left half of "Tool:needle") that
 *      literally appears (case-insensitive, word-boundary) somewhere in the
 *      provided SKILL.md content. Rationale: if the SKILL.md author meant the
 *      step to involve a specific tool, the tool name appears in the doc.
 *      Generator inferring "URL → WebFetch" or "Slack notification → curl" is
 *      hallucination that turns into 100% false-negative pressure on fact
 *      score. Negative variants (tool_input_not_contains, tools_not_called) are
 *      exempt — they encode forbidden actions, which by definition aren't in
 *      the SKILL.md.
 *
 * Behavior:
 *   - `sample_id` defaulted if missing
 *   - `prompt` missing → throw (required)
 *   - `capability` not string[] → strip
 *   - `difficulty` not in enum → strip
 *   - `construct` not non-empty string → strip
 *   - `provenance` not in enum → strip,then auto-stamp 'llm-generated'
 *   - assertion violating rules A or B above → strip that one assertion
 *     (keep the sample, since the rest of its assertions / judge rubric
 *     are still valid signal sources)
 *
 * `opts.skillContent` is the raw SKILL.md text the generator fed to the
 * authoring LLM. When omitted, rule B silently passes (loader-side tests
 * and unit-level callers that don't have a SKILL.md handy still work).
 *
 * Mutates the samples array in-place (matches generator's existing style).
 * Returns `{ stripped: string[] }` for warning aggregation + tests.
 */
const CJK_OR_FULLWIDTH = /[　-〿一-鿿㐀-䶿＀-￯]/;
const TEXT_VALUE_TYPES = new Set([
  'contains', 'not_contains', 'contains_all', 'contains_any', 'equals', 'not_equals',
]);
const TOOL_POSITIVE_TYPES = new Set([
  'tool_input_contains', 'tool_output_contains', 'mock_hit',
]);

function isAsciiTokenLike(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s.length < 2 || s.length > 40) return false;
  if (CJK_OR_FULLWIDTH.test(s)) return false;
  // 含内部空白(多 token 短语)拒,但允许首尾空格被 trim 已忽略
  if (/\s/.test(s)) return false;
  return true;
}

function toolNameAppearsInSkill(tool: string, skillContent: string): boolean {
  if (!skillContent) return true; // no skill context — let it through (loader-side)
  // case-insensitive word-boundary match. tool 名是 ASCII 标识符 (Bash/Read/WebFetch/MCP 名),
  // 不会含正则元字符,直接拼即可 — 但 hyphen 在某些 MCP 名里出现(如 skylark-doc),
  // hyphen 不是正则特殊字符,RegExp 构造也无需转义。
  const esc = tool.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9_-])${esc}(?:$|[^A-Za-z0-9_-])`, 'i').test(skillContent);
}

export function sanitizeGeneratedSamples(
  samples: Sample[],
  opts: { skillContent?: string } = {},
): { stripped: string[] } {
  const VALID_DIFFICULTY = new Set(['easy', 'medium', 'hard']);
  const VALID_PROVENANCE = new Set(['human', 'llm-generated', 'production-trace']);
  const skillContent = opts.skillContent || '';
  const stripped: string[] = [];
  for (const [i, s] of samples.entries()) {
    // sample_id / prompt 必须是 non-empty string。LLM 偶尔返回 number / null,
    // 当前若漏校验下游 loadSamples 会拒掉整个文件 — 在 generator boundary 修掉。
    if (typeof s.sample_id !== 'string' || s.sample_id.length === 0) {
      s.sample_id = `s${String(i + 1).padStart(3, '0')}`;
    }
    if (typeof s.prompt !== 'string' || s.prompt.length === 0) {
      throw new Error(`samples[${i}] missing or invalid required prompt field (got ${typeof s.prompt})`);
    }

    if (s.capability !== undefined) {
      if (!Array.isArray(s.capability) || !s.capability.every((c) => typeof c === 'string' && c.length > 0)) {
        stripped.push(`samples[${i}].capability (${typeof s.capability})`);
        delete (s as { capability?: unknown }).capability;
      }
    }
    if (s.difficulty !== undefined && !VALID_DIFFICULTY.has(s.difficulty as string)) {
      stripped.push(`samples[${i}].difficulty=${JSON.stringify(s.difficulty)}`);
      delete (s as { difficulty?: unknown }).difficulty;
    }
    if (s.construct !== undefined && (typeof s.construct !== 'string' || !s.construct)) {
      stripped.push(`samples[${i}].construct (${typeof s.construct})`);
      delete (s as { construct?: unknown }).construct;
    }
    if (s.provenance !== undefined && !VALID_PROVENANCE.has(s.provenance as string)) {
      stripped.push(`samples[${i}].provenance=${JSON.stringify(s.provenance)}`);
      delete (s as { provenance?: unknown }).provenance;
    }
    // After stripping invalid provenance, auto-stamp the generator's authority value.
    if (!s.provenance) s.provenance = 'llm-generated';

    // tripwire 校验:必须是 boolean(true / false 都允许,但 LLM 偶尔写 "true" 字符串)。
    // 非 boolean 一律 strip。omk diagnostic 会查 sample.tripwire === true。
    if (s.tripwire !== undefined && typeof s.tripwire !== 'boolean') {
      stripped.push(`samples[${i}].tripwire (${typeof s.tripwire})`);
      delete (s as { tripwire?: unknown }).tripwire;
    }

    // assertions 校验:loader 会拒掉两类无效断言 — 在 generator boundary 提前 strip,
    // 避免落盘的 sample 跑不动:
    //   1. tools_called / tools_not_called 的 values 必须非空
    //   2. tool_input_contains / tool_input_not_contains / tool_output_contains / mock_hit
    //      的 value 必须是 "Tool:needle" 格式(冒号分隔,两侧非空)
    if (Array.isArray(s.assertions)) {
      const before = s.assertions.length;
      const TOOL_COLON = new Set([
        'tool_input_contains', 'tool_input_not_contains', 'tool_output_contains', 'mock_hit',
      ]);
      s.assertions = s.assertions.filter((a, j) => {
        if (a?.type === 'tools_called' || a?.type === 'tools_not_called') {
          const vals = Array.isArray(a.values) ? a.values : [];
          const ok = vals.length > 0 && vals.every((v) => typeof v === 'string' && v.length > 0);
          if (!ok) stripped.push(`samples[${i}].assertions[${j}].${a.type} (empty values)`);
          return ok;
        }
        if (TOOL_COLON.has(a?.type)) {
          const v = a?.value;
          if (typeof v !== 'string' || v.length === 0) {
            stripped.push(`samples[${i}].assertions[${j}].${a.type} (missing value)`);
            return false;
          }
          const sep = v.indexOf(':');
          if (sep <= 0 || sep === v.length - 1) {
            stripped.push(`samples[${i}].assertions[${j}].${a.type} (value not "Tool:needle": ${JSON.stringify(v)})`);
            return false;
          }
          // Rule B: positive tool-bound assertions — tool name must literally
          // appear in SKILL.md. Negative variants (tool_input_not_contains) are
          // exempt because forbidden tools won't be mentioned in the doc.
          if (TOOL_POSITIVE_TYPES.has(a.type) && skillContent) {
            const toolName = v.slice(0, sep);
            if (!toolNameAppearsInSkill(toolName, skillContent)) {
              stripped.push(
                `samples[${i}].assertions[${j}].${a.type} 工具名 "${toolName}" 未在 SKILL.md 字面出现 — generator 凭空联想,断言去归 rubric`,
              );
              return false;
            }
          }
        }
        // Rule A: text-class value content guard — reject CJK chars, fullwidth
        // punctuation, internal whitespace, or out-of-range length [2, 40].
        // LLM text output is unstable under synonym/句式 rewriting; literal
        // matches on Chinese phrases are guaranteed noise.
        if (TEXT_VALUE_TYPES.has(a?.type)) {
          const items = Array.isArray(a.values) ? a.values
            : a.value !== undefined ? [a.value]
            : [];
          if (items.length === 0) {
            stripped.push(`samples[${i}].assertions[${j}].${a.type} (empty value/values)`);
            return false;
          }
          for (const v of items) {
            if (!isAsciiTokenLike(v)) {
              stripped.push(
                `samples[${i}].assertions[${j}].${a.type} value 非 ASCII token (含中文/全角标点/空格/长度越界): ${JSON.stringify(v)}`,
              );
              return false;
            }
          }
        }
        if (a?.type === 'regex' && typeof a.pattern === 'string' && CJK_OR_FULLWIDTH.test(a.pattern)) {
          stripped.push(
            `samples[${i}].assertions[${j}].regex pattern 含 CJK/全角字符: ${JSON.stringify(a.pattern)}`,
          );
          return false;
        }
        return true;
      });
      // 全部 assertions 被 strip 完留空数组也保留 — sample 仍可用纯 LLM judge 评。
      if (s.assertions.length === 0 && before > 0) {
        delete (s as { assertions?: unknown }).assertions;
      }
    }

    // environment 校验:必须是对象,内部字段要么是 string[] 要么是 string。
    // 非法字段 strip 掉,避免 runtime 注入时炸 prompt。
    if (s.environment !== undefined) {
      if (typeof s.environment !== 'object' || s.environment === null || Array.isArray(s.environment)) {
        stripped.push(`samples[${i}].environment (${typeof s.environment})`);
        delete (s as { environment?: unknown }).environment;
      } else {
        const env = s.environment as Record<string, unknown>;
        if (env.cli_available !== undefined && (!Array.isArray(env.cli_available) || !env.cli_available.every((x) => typeof x === 'string' && x.length > 0))) {
          stripped.push(`samples[${i}].environment.cli_available (${typeof env.cli_available})`);
          delete env.cli_available;
        }
        if (env.files_available !== undefined && (!Array.isArray(env.files_available) || !env.files_available.every((x) => typeof x === 'string' && x.length > 0))) {
          stripped.push(`samples[${i}].environment.files_available (${typeof env.files_available})`);
          delete env.files_available;
        }
        if (env.notes !== undefined && (typeof env.notes !== 'string')) {
          stripped.push(`samples[${i}].environment.notes (${typeof env.notes})`);
          delete env.notes;
        }
        // 如果所有子字段都没了,整个 environment 也删掉
        if (Object.keys(env).length === 0) {
          delete (s as { environment?: unknown }).environment;
        }
      }
    }

    // mocks 校验:必须是数组,每项必须有 tool(string)+ 至少一种 return。
    // 非法的 strip 掉,避免 runtime 装 hook 时炸。
    if (s.mocks !== undefined) {
      if (!Array.isArray(s.mocks)) {
        stripped.push(`samples[${i}].mocks (${typeof s.mocks})`);
        delete (s as { mocks?: unknown }).mocks;
      } else {
        const validMocks: unknown[] = [];
        for (let j = 0; j < s.mocks.length; j++) {
          const m = s.mocks[j] as unknown as Record<string, unknown>;
          if (typeof m?.tool !== 'string' || m.tool.length === 0) {
            stripped.push(`samples[${i}].mocks[${j}].tool (missing/invalid)`);
            continue;
          }
          if (m.return === undefined && m.return_file === undefined && m.return_seq === undefined) {
            stripped.push(`samples[${i}].mocks[${j}] (no return/return_file/return_seq)`);
            continue;
          }
          validMocks.push(m);
        }
        if (validMocks.length > 0) (s as Record<string, unknown>).mocks = validMocks;
        else delete (s as { mocks?: unknown }).mocks;
      }
    }

    // mocksStrict 兜底:有 mocks 时强制 true。
    // SYSTEM_PROMPT 已要求 LLM 必填,但偶尔 LLM 漏填 — 在 generator boundary 修掉,
    // 避免运行时 mock 未命中透传到真 shell(报 mcporter not found 等噪声错误)。
    // LLM 显式给 false 时尊重(罕见,但保留 escape hatch — 比如混合 mock + 真 fs 的特殊场景)。
    if (s.mocks && s.mocks.length > 0 && s.mocksStrict === undefined) {
      s.mocksStrict = true;
    }
  }
  return { stripped };
}
