/**
 * 观测收件箱指标的标签与说明文案（宿主无关纯函数，#839 批次 4）。
 * 从 presentation/observation-inbox/metric-renderer 收敛到数据层，
 * HTML 渲染器与 React 页面共用；中文逐字保留，英文为新增。
 */

export type IndicatorHelpKey =
  | 'userCorrection' | 'userInterruption' | 'userFollowUp' | 'negativeFeedback' | 'positiveFeedback' | 'userGoalShift' | 'hardRule' | 'selfCorrection' | 'repeatedExecution'
  | 'toolCall' | 'toolFailure' | 'toolCancelled' | 'toolUnknown' | 'highObservation' | 'mediumObservation' | 'hedging' | 'explicitMarker'
  | 'bash' | 'read' | 'grep' | 'bashProbe' | 'notFound' | 'toolLimit'
  | 'skillRoleRouter' | 'skillRoleExecutor' | 'skillRoleMixed' | 'skillRoleUnknown'
  | 'llmSkillTypeRouter' | 'llmSkillTypeDelegation' | 'llmSkillTypeExecutor' | 'llmSkillTypeAdvisory' | 'llmSkillTypeWorkflowOwner' | 'llmSkillTypeUnknown';

const INDICATOR_LABELS_ZH: Record<IndicatorHelpKey, string> = {
  userCorrection: '用户纠正',
  userInterruption: '人工中断',
  userFollowUp: '追问/补充',
  negativeFeedback: '负向反馈',
  positiveFeedback: '正向反馈',
  userGoalShift: '用户切换目标',
  hardRule: '用户硬性要求',
  selfCorrection: '自我纠正',
  repeatedExecution: '重复执行',
  toolCall: '工具调用',
  toolFailure: '工具执行失败',
  toolCancelled: '工具调用取消',
  toolUnknown: '工具状态未知',
  highObservation: '高优先级过程发现',
  mediumObservation: '低风险/抽样过程发现',
  hedging: '不确定表达',
  explicitMarker: '显式缺口',
  bash: 'Bash 调用',
  read: 'Read 调用',
  grep: 'Grep 调用',
  bashProbe: 'Bash 试探',
  notFound: '路径不存在',
  toolLimit: '工具限制',
  skillRoleRouter: '路由（本 session 角色）',
  skillRoleExecutor: '执行（本 session 角色）',
  skillRoleMixed: '路由+执行（本 session 角色）',
  skillRoleUnknown: '未确定（本 session 角色）',
  llmSkillTypeRouter: '路由型（能力定位）',
  llmSkillTypeDelegation: '委派型（能力定位）',
  llmSkillTypeExecutor: '执行型（能力定位）',
  llmSkillTypeAdvisory: '咨询型（能力定位）',
  llmSkillTypeWorkflowOwner: '流程负责型（能力定位）',
  llmSkillTypeUnknown: '类型待确认（能力定位）',
};

const INDICATOR_LABELS_EN: Record<IndicatorHelpKey, string> = {
  userCorrection: 'User correction',
  userInterruption: 'User interruption',
  userFollowUp: 'Follow-up',
  negativeFeedback: 'Negative feedback',
  positiveFeedback: 'Positive feedback',
  userGoalShift: 'Goal switch',
  hardRule: 'Hard rule',
  selfCorrection: 'Self-correction',
  repeatedExecution: 'Repeated execution',
  toolCall: 'Tool calls',
  toolFailure: 'Tool failures',
  toolCancelled: 'Tool cancelled',
  toolUnknown: 'Tool status unknown',
  highObservation: 'High-priority finding',
  mediumObservation: 'Low-risk/sampled finding',
  hedging: 'Hedging',
  explicitMarker: 'Explicit gap',
  bash: 'Bash calls',
  read: 'Read calls',
  grep: 'Grep calls',
  bashProbe: 'Bash probes',
  notFound: 'Path missing',
  toolLimit: 'Tool limits',
  skillRoleRouter: 'Router (session role)',
  skillRoleExecutor: 'Executor (session role)',
  skillRoleMixed: 'Router+executor (session role)',
  skillRoleUnknown: 'Undetermined (session role)',
  llmSkillTypeRouter: 'Router (skill type)',
  llmSkillTypeDelegation: 'Delegation (skill type)',
  llmSkillTypeExecutor: 'Executor (skill type)',
  llmSkillTypeAdvisory: 'Advisory (skill type)',
  llmSkillTypeWorkflowOwner: 'Workflow owner (skill type)',
  llmSkillTypeUnknown: 'Type unknown (skill type)',
};

const INDICATOR_HELPS_ZH: Record<IndicatorHelpKey, string> = {
  userCorrection: '只统计人工用户消息里的明确纠偏表达。短词“不对 / 不是 / 错了”必须前后有空格、逗号、句号、问号等分隔；“不对称”“是不是”不会算纠正。',
  userInterruption: '统计 Claude trace 里的 “[Request interrupted by user]” 等用户主动中断事件，表示当前执行被人工叫停。',
  userFollowUp: '按当前报告的归因结果统计追问或补充。router / delegation 类型会把下游调用链路中的用户追问计入体验复盘；与当前 skill 无关的同窗口用户消息不计入。',
  negativeFeedback: '统计“没用 / 垃圾 / 菜 / 做错了 / 不行 / 失败 / 看不懂 / 有问题”等负向表达。这是规则命中，不是 LLM 情绪识别。',
  positiveFeedback: '统计“很好 / good job / 做得好 / 很棒 / 优秀 / 厉害 / 很有用 / 很有价值”等正向表达，用来保留用户认可证据。',
  userGoalShift: '统计“换个方向 / 先不 / 不用这个 / 另一个问题”等目标切换表达。它表示当前目标可能中止或切走，不直接等同于 skill 做错。',
  hardRule: '统计用户在对话里临时提出的硬性要求，例如“必须 / 不要 / 禁止 / 严格 / 一定要 / 只允许”。Skill 自身的强约束请看定义链路里的规则检测结果。',
  selfCorrection: '统计 agent 在没有用户介入的情况下，发现自己的执行路径、结果或工具策略有问题并主动修正。少量说明有恢复能力，高频说明流程不稳。',
  repeatedExecution: '统计同类步骤、工具或流程被重复执行的信号。高频出现通常对应绕路、工具策略不清晰或 workflow 缺少明确顺序。',
  toolCall: '统计该 skill 运行片段里的 tool_use 调用总数，包括 Bash、Read、Grep 等工具。',
  toolFailure: '统计该 skill 运行片段里失败的工具执行结果，例如 tool_result 标记 is_error=true。注意：工具执行失败不等于整个 skill 调用失败。',
  toolCancelled: '统计 runtime 明确标记为 cancelled 的工具调用。取消与工具执行失败分开统计，也不作为知识缺口证据。',
  toolUnknown: '统计 runtime 未提供可信终态的工具调用。状态未知不计入工具成功率或失败率分母。',
  highObservation: '统计 severity=high 的过程发现，通常表示可能需要优先复盘的执行问题。',
  mediumObservation: '统计 severity=medium/low 的过程发现，通常进入抽样复盘，不直接等同于必须改 skill。',
  hedging: '统计回答或过程发现里的“不确定 / 可能 / 需要确认”等低置信文本信号。',
  explicitMarker: '统计回答或过程发现里明确出现“未知 / 知识缺口 / 没覆盖”等显式标记。',
  bash: '统计该 skill 运行期间调用 Bash 工具的次数。',
  read: '统计该 skill 运行期间调用 Read 工具的次数。',
  grep: '统计该 skill 运行期间调用 Grep 工具的次数。',
  bashProbe: '统计过程发现中被判断为 Bash 试探的次数，例如命令看起来是在试目录、试路径或探测环境。',
  notFound: '统计过程发现中路径或文件不存在的次数。',
  toolLimit: '统计文件太长、token 上限、超时等工具限制导致的问题。',
  skillRoleRouter: '本 session 内 skill 主要在调用 Skill 工具触发下游能力，自己不直接产出。判定来自 trace 行为，看到 Skill tool_use 调用占主导。常见于调度型 skill。',
  skillRoleExecutor: '本 session 内 skill 主要在调用具体工具（Bash / Read / Write / Edit）直接产出 artifact。判定来自 trace 行为。常见于编码 / 文档生成 / 数据处理类 skill。',
  skillRoleMixed: '本 session 内 skill 既调用 Skill 工具触发下游，又自己调用执行工具直接产出。trace 行为同时看到两种特征。常见于负责调度但保留兜底执行的 skill。',
  skillRoleUnknown: '本 session 内 trace 行为没显示明显的路由或执行特征。可能是 advisory / 对话型 skill，或样本太少没足够证据。',
  llmSkillTypeRouter: 'LLM 综合 SKILL.md 描述和 trace 行为判定为路由型：定位是把请求分发到下游，自身不直接产出。和"路由（本 session 角色）"区别：这个是 skill 本质定位，不只是单次 session 表现。',
  llmSkillTypeDelegation: 'LLM 判定为委派型：把任务交给 child session / 子 agent 执行，自己只负责拆任务、监督生命周期和回收结果。区别于路由型在于：路由型主要做转发，委派型还要管 child 跑偏 / 启动 / 终止全生命周期。',
  llmSkillTypeExecutor: 'LLM 判定为执行型：定位是自己直接干活产出 artifact。和"执行（本 session 角色）"区别：这个是 skill 本质定位，不只是单次 session 表现。',
  llmSkillTypeAdvisory: 'LLM 判定为咨询型：定位是回答问题 + 给证据，不一定产出 artifact。常见于审计 / 分析 / 解释类 skill。本 session 角色一般会显示"未确定"，因为 advisory 没有明显工具使用特征。',
  llmSkillTypeWorkflowOwner: 'LLM 判定为流程负责型：定位是管理一条多阶段 workflow 的闭环状态。它可以委派其他 skill 执行阶段动作，但要负责阶段矩阵、产物、异常和用户反馈闭环。',
  llmSkillTypeUnknown: 'LLM 没能从 SKILL.md 和 trace 中得到足够证据判定 skill 类型。可能是 SKILL.md 描述不清，或 trace 样本不足。建议 skill owner 补充 SKILL.md 顶部声明，或多观察几个 session。',
};

const INDICATOR_HELPS_EN: Record<IndicatorHelpKey, string> = {
  userCorrection: 'Counts explicit corrections in genuine user messages. Short words like "wrong / not right" must be delimited by spaces or punctuation; words like "asymmetric" do not count.',
  userInterruption: 'Counts user-initiated interruptions such as "[Request interrupted by user]" in Claude traces, meaning the execution was stopped manually.',
  userFollowUp: 'Counts follow-ups attributed by the current report. Router/delegation types fold downstream follow-ups into the review; unrelated same-window user messages are excluded.',
  negativeFeedback: 'Counts negative expressions such as "useless / wrong / failed". Rule-based detection, not LLM sentiment.',
  positiveFeedback: 'Counts positive expressions such as "great / well done / useful", preserved as approval evidence.',
  userGoalShift: 'Counts goal-switch expressions such as "change direction / not now / another topic". It signals the goal may have moved; it does not imply the skill erred.',
  hardRule: 'Counts ad-hoc hard requirements from the user, such as "must / do not / strictly / only". For a skill\'s own constraints, see rule findings in its definition chain.',
  selfCorrection: 'Counts cases where the agent fixed its own path, result, or tool strategy without user input. A little shows resilience; a lot signals instability.',
  repeatedExecution: 'Counts repeated execution of the same step, tool, or flow. High frequency usually means detours or an unclear workflow order.',
  toolCall: 'Counts total tool_use calls in the skill segment, including Bash, Read, Grep, etc.',
  toolFailure: 'Counts failed tool results in the skill segment, e.g. tool_result with is_error=true. A tool failure is not a whole-skill failure.',
  toolCancelled: 'Counts tool calls the runtime marked as cancelled. Cancellations are tracked separately from failures and are not gap evidence.',
  toolUnknown: 'Counts tool calls without a trustworthy terminal state from the runtime. Unknown states are excluded from success/failure denominators.',
  highObservation: 'Counts severity=high findings, usually execution issues worth reviewing first.',
  mediumObservation: 'Counts severity=medium/low findings, usually for sample review; does not imply the skill must change.',
  hedging: 'Counts low-confidence text signals such as "uncertain / maybe / needs confirmation" in answers or findings.',
  explicitMarker: 'Counts explicit markers such as "unknown / knowledge gap / not covered" in answers or findings.',
  bash: 'Counts Bash tool calls during the skill run.',
  read: 'Counts Read tool calls during the skill run.',
  grep: 'Counts Grep tool calls during the skill run.',
  bashProbe: 'Counts findings classified as Bash probing, e.g. commands that look like directory or environment probing.',
  notFound: 'Counts findings where a path or file did not exist.',
  toolLimit: 'Counts issues caused by tool limits such as file length, token cap, or timeouts.',
  skillRoleRouter: 'In this session the skill mainly triggered downstream capabilities via the Skill tool and did not produce directly. Inferred from trace behavior dominated by Skill tool_use. Common for dispatcher skills.',
  skillRoleExecutor: 'In this session the skill mainly called concrete tools (Bash / Read / Write / Edit) to produce artifacts directly. Inferred from trace behavior. Common for coding / doc / data skills.',
  skillRoleMixed: 'In this session the skill both triggered downstream work and produced directly. Trace shows both traits. Common for dispatchers that keep a fallback execution path.',
  skillRoleUnknown: 'Trace behavior shows no clear router or executor trait in this session. Possibly an advisory / conversational skill, or too little evidence.',
  llmSkillTypeRouter: 'LLM-classified router from SKILL.md plus trace behavior: it dispatches requests downstream and does not produce directly. Unlike "Router (session role)", this is the skill\'s inherent positioning, not a single session.',
  llmSkillTypeDelegation: 'LLM-classified delegation: the skill hands work to child sessions / sub-agents and manages their lifecycle. Unlike routers, delegators also own drift detection, startup, and termination.',
  llmSkillTypeExecutor: 'LLM-classified executor: the skill produces artifacts itself. Unlike "Executor (session role)", this is the skill\'s inherent positioning, not a single session.',
  llmSkillTypeAdvisory: 'LLM-classified advisory: it answers with evidence and may not produce artifacts. Common for audit / analysis skills. The session role usually shows "undetermined" because advisory work has no strong tool signature.',
  llmSkillTypeWorkflowOwner: 'LLM-classified workflow owner: it owns the closed loop of a multi-stage workflow. It may delegate stage actions but remains responsible for the stage matrix, artifacts, exceptions, and user feedback loop.',
  llmSkillTypeUnknown: 'The LLM could not determine the skill type from SKILL.md and trace evidence. The SKILL.md may be unclear or the trace sample too small; ask the skill owner to declare the type near the top of SKILL.md, or observe more sessions.',
};

export function indicatorLabel(key: IndicatorHelpKey, lang: 'zh' | 'en' = 'zh'): string {
  return (lang === 'en' ? INDICATOR_LABELS_EN : INDICATOR_LABELS_ZH)[key];
}

export function indicatorHelp(key: IndicatorHelpKey, lang: 'zh' | 'en' = 'zh'): string {
  return (lang === 'en' ? INDICATOR_HELPS_EN : INDICATOR_HELPS_ZH)[key];
}

export const INDICATOR_KEYS: readonly IndicatorHelpKey[] = [
  'userCorrection', 'userInterruption', 'userFollowUp', 'negativeFeedback', 'positiveFeedback', 'userGoalShift', 'hardRule', 'selfCorrection', 'repeatedExecution',
  'toolCall', 'toolFailure', 'toolCancelled', 'toolUnknown', 'highObservation', 'mediumObservation', 'hedging', 'explicitMarker',
  'bash', 'read', 'grep', 'bashProbe', 'notFound', 'toolLimit',
  'skillRoleRouter', 'skillRoleExecutor', 'skillRoleMixed', 'skillRoleUnknown',
  'llmSkillTypeRouter', 'llmSkillTypeDelegation', 'llmSkillTypeExecutor', 'llmSkillTypeAdvisory', 'llmSkillTypeWorkflowOwner', 'llmSkillTypeUnknown',
];
