import { createExecutor } from '../executors/index.js';
import type { Sample } from '../types/index.js';

/**
 * Generator 默认模型 'opus' (跟 eval 默认对齐)。
 * lean=true 路径会自动追加 `--effort low`,关掉 opus 默认的扩展思考,
 * 所以 opus + lean + effort-low 在 generator 场景下速度仍然可控(单 skill ~30-60s)。
 * 成本约 sonnet 的 5x,但 opus 在结构化指令遵循 / 长 prompt 一致性上更稳。
 * 用户想要省钱时显式 `--model sonnet` 即可。
 */
const GENERATOR_DEFAULT_MODEL = 'opus';

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
- rubric: 评分标准，描述一个好的回答应该具备什么特征（1-2 句话）。
  **禁忌(时间敏感数据)**: 不要在 rubric 里硬编码具体日期 / 时间戳 / 工号 / IP / 临时 token 等
  会随评测时刻变化的具体值 — 跑评测时这些值会跟当时实际值不符,assertion 必挂。
  - 错(❌): "应写入 temp/2026-05-07/technical/ 目录" — 2026-05-08 跑就过期
  - 对(✅): "应写入 temp/<today>/technical/ 目录(today=评测当天日期)" — 用占位描述,
    对应 assertion 也用 regex / tool_input_contains 抓**模式**(如 \`temp/\\d{4}-\\d{2}-\\d{2}/technical/\`)
    而不是精确字符串。
  - 占位符约定: \`<today>\` / \`<now>\` / \`<current_user>\` / \`<random_id>\` 等用尖括号包,
    跟 LLM 说"这是占位,跑时用当时实际值替换"。
- assertions: 3-5 个断言检查。**优先选能直接验证工具调用/流程的类型,把"LLM 文本输出"当兜底**:
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
      "tool": "Bash" | "Read" | "Edit" | "Write" | "WebFetch" | "Grep" | "Glob",
      "match": {
        "file_path_endswith": "<相对路径后缀,如 tasks/foo/state.json>",  // 推荐用这条 (Read/Edit/Write)
        "file_path": "<完整路径,~ 或绝对>",            // 仅当能预测完整 path 时用,否则首选 _endswith
        "url": "<exact url>" or "url_glob": "<glob>",  // WebFetch
        "command_glob": "<glob>",                       // Bash 拦 mcporter / cli
        "input": { "<key>": "<value>" }                // generic deep-equal subset
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
   SKILL.md 文档里出现 \`https://yuque.antfin.com/xxx/yyy\` 这种 URL,**不代表**
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


   **断言类型选择口诀**(fact 层只测 deterministic 事实,语义/论点交给 judge 评 rubric):
   - 测"LLM 调了哪个工具/什么命令" → 用 tool_input_contains 或 tools_called(不要用 contains)
   - 测"LLM 走完了流程的某一步" → 用 mock_hit(配合 sample.mocks 的"驱动流程"设计,见下文)
   - 测"LLM 没用错误的工具" → 用 tools_not_called(values 必须给具体工具名,不能空数组)
   - 测"LLM 工作流不应踩到某路径 / 不该传某 flag" → 用 tool_input_not_contains
        (注意:**不要**用 not_contains 表达这件事 — not_contains 扫的是 LLM 最终文本,
         LLM 在总结里写"已排除 X" 会自触发假阳性,这是 obsidian / 知识库类 sample 的高频坑)
   - 测"LLM 最终回答包含代码 token / 错误码 / 不可替换字面量" → 用 contains(单值)
   - 测"LLM 最终回答提到某概念/做出某判断/给了某类建议" → **完全不要用 contains/_any** →
        把这条"应该做到 X" 写进 sample.rubric,让 judge 评分。judge 看意图不看字面,
        天然稳定;judge 自身有方差但 omk 支持 ensemble / --repeat 降方差,是测量学
        认可的语义评估方式。**这是 fact 层和 judge 层的分工**:fact 测 deterministic
        机器可验证的事(工具/路径/代码 token),judge 测 deterministic 不可表达的
        语义意图。把语义塞 fact 层用 contains/_any 是反模式 — 每次跑结果飘。
   优先组合:典型 sample 通常 2 条 tool_input_contains + 1 条 tools_not_called +
   1-2 条 mock_hit。**contains 系列出现 0-1 次最好**,只用于代码 token 这种唯一字面量。
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
}

/**
 * 拼出送给 LLM 的 user prompt。抽出来便于单测验证 focus 是否真的注入了。
 *
 * count 语义:
 *   - number: 强制生成 N 条
 *   - undefined: 让 LLM 按系统提示里"样本结构决策"的类型对应范围自行判断数量
 */
export function buildSamplesPrompt({ skillContent, count, focus }: { skillContent: string; count?: number; focus?: string }): string {
  const focusBlock = focus && focus.trim()
    ? `\n\n额外要求（用户指定的场景重点）：\n${focus.trim()}\n生成的用例必须优先覆盖以上场景，再在剩余配额内补充其它能力维度。`
    : '';
  const countLine = typeof count === 'number'
    ? `请根据这个 skill 生成 ${count} 个评测用例。`
    : `请根据这个 skill 自行判断合适的数量并生成评测用例（参考系统提示中"样本结构决策"对应类型的数量范围）。`;
  return `以下是需要评测的 skill 内容：

${skillContent}

${countLine}直接输出 JSON 数组。${focusBlock}`;
}

export async function generateSamples({ skillContent, count, model = GENERATOR_DEFAULT_MODEL, executorName = 'claude', focus }: GenerateSamplesOptions): Promise<{ samples: Sample[]; costUSD: number }> {
  const executor = createExecutor(executorName);

  const prompt = buildSamplesPrompt({ skillContent, count, focus });

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
