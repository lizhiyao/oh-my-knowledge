import type { JudgeConfig } from './judge.js';

export interface Assertion {
  type: string;
  value?: string | number;
  values?: string[];
  pattern?: string;
  flags?: string;
  schema?: Record<string, unknown>;
  weight?: number;
  fn?: string;
  reference?: string;
  threshold?: number;
  /** When true, the assertion's pass/fail is inverted. Works with any type,
   *  including legacy `not_contains` (which becomes a redundant but still
   *  supported double-negation). */
  not?: boolean;
  /** Only used by type='assert-set'. 'any' = at least one child must pass;
   *  'all' = every child must pass. Children may be any assertion type,
   *  including nested assert-sets. */
  mode?: 'any' | 'all';
  children?: Assertion[];
  /** For rouge_n_min: which n-gram order (default 1). */
  n?: number;
}

/** sample provenance(数据来源)。`evolved` / `mixed` 留 follow-up
 *  跟 evolver 升级一起做。 */
export type SampleProvenance = 'human' | 'llm-generated' | 'production-trace';

/** sample 难度等级。简单分桶,跟 IRT 风格 fine-grained difficulty 不同。 */
export type SampleDifficulty = 'easy' | 'medium' | 'hard';

/** Sample 可选声明的 skill 结构锚点。用于 Skill Map / 诊断，不参与 grading / judge / verdict。 */
export type SampleCoverageTargetKind =
  | 'skill'
  | 'skill_file'
  | 'frontmatter'
  | 'reference'
  | 'script'
  | 'hard_rule'
  | 'workflow'
  | 'workflow_node';

export interface SampleCoverageTarget {
  /** 目标类型。避免裸 kind，保持 Artifact.kind 语义唯一。 */
  targetKind: SampleCoverageTargetKind;
  /** 稳定引用：路径或 ID。reference/script 用 skill 根相对路径，workflow_node 用 workflowId.nodeId。 */
  ref: string;
}

/** Sample 评测环境前置:声明性"已就绪"清单,LLM 看到后跳过环境探测,直接进入工作流。
 *  类比 unit test 的 fixture / setup —— 评测是测 skill 工作流,不是测环境探测能力。 */
export interface SampleEnvironment {
  /** 假定已在 PATH 上的 CLI,LLM 不再 which / find / type / command -v 探测。 */
  cli_available?: string[];
  /** 假定存在的文件/脚本(支持 ~ / $SKILL_DIR / 绝对路径),LLM 不再 Glob / Read / test -f 探测。 */
  files_available?: string[];
  /** 自由文本兜底,场景特殊说明(如"凭证已配""设备 SN xxx 已租"等)。 */
  notes?: string;
}

/** Mock 命中规则(所有字段 AND,字段未填即不限制)。 */
export interface MockMatch {
  /** 精确匹配 file_path(用于 Read / Edit / Write,支持 ~ 自动展开)。
   *  注意:claude-cli / claude-sdk 的 PreToolUse hook 拿到的 file_path 是 LLM 调
   *  Read/Edit/Write 时实际传入的字符串。LLM 经常把相对路径写成 cwd 绝对路径
   *  (尤其当 sample.environment.notes 里给了 cwd 提示),mock 用 `file_path` 精确
   *  匹配会 miss。**新 sample 推荐用 `file_path_endswith` 做后缀匹配**,匹配更稳。 */
  file_path?: string;
  /** 后缀匹配 file_path:actual.endsWith(suffix) 且边界为路径分隔符或完全相等。
   *  例如 suffix='tasks/foo/state.json' 命中 'tasks/foo/state.json' /
   *  '/abs/cwd/tasks/foo/state.json' / '~/proj/tasks/foo/state.json' 但不命中
   *  'bad-state.json'。`~` 自动展开。**绝对路径 cwd 不可预测时首选这个字段**。 */
  file_path_endswith?: string;
  /** 精确匹配 url(用于 WebFetch / WebSearch)。 */
  url?: string;
  /** glob 匹配 url(支持 *)。url 与 url_glob 二选一。 */
  url_glob?: string;
  /** glob 匹配 command(用于 Bash 拦 mcporter / cli;支持 *)。 */
  command_glob?: string;
  /** 通用匹配:对 tool_input 任意字段做 deep equal,优先级高于上面的 sugar 字段。 */
  input?: Record<string, unknown>;
  /** 递归扫描 tool_input 所有 string 值,任意一个含该子串即命中(大小写不敏感)。
   *  适合 intent-level mock:配合 `tool: "*"` 拦截"任何工具,只要输入提到关键词"。
   *  例: `input_contains: "FinTradeBuySpi"` 命中 Bash grep / Grep / Read 等任何包含该关键词的调用。 */
  input_contains?: string;
}

/** Mock 返回值(三选一)。 */
export type MockReturn =
  | { stdout?: string; stderr?: string; exit?: number; [k: string]: unknown }
  | string;

/** 单条 Mock 规则。runtime 拦到匹配的 tool 调用即返回 mocked 结果,不放出去。 */
export interface Mock {
  /** 拦截的工具名,如 "Read" / "Bash" / "WebFetch" / "Edit" / "Write" / "Grep" / "Glob"。
   *  特殊值 `"*"`:通配,匹配任何工具名(配合 match.input_contains 做 intent-level mock)。 */
  tool: string;
  /** 命中规则。所有字段 AND,字段未填即不限制。 */
  match?: MockMatch;
  /** 返回内容(LLM 看到的 tool_result),与 return_file / return_seq 三选一。
   *  - string:直接当字符串返回
   *  - { stdout, stderr, exit }:模拟 Bash 工具结果(若 exit !=0 表示失败) */
  return?: MockReturn;
  /** 从外部 fixture 文件读返回内容(路径相对 sample 目录;大响应建议外置)。 */
  return_file?: string;
  /** 同 mock 多次命中按序返回(状态机场景:第 1 次 PENDING → 第 2 次 SUCCESS)。
   *  超出序列长度时回退到 return / return_file。 */
  return_seq?: MockReturn[];
}

export interface Sample {
  sample_id: string;
  prompt: string;
  context?: string;
  cwd?: string;
  rubric?: string;
  assertions?: Assertion[];
  dimensions?: Record<string, string>;
  allowedTools?: string[];
  expectedTools?: string[];
  /** 该 sample 测试的能力维度,可多维。free-form string,suggested
   *  values 见 docs/specs/sample-design-spec.md。aggregate 时大小写不敏感。
   *  纯文档 / 诊断用,不参与 grading / judge / verdict。 */
  capability?: string[];
  /** 难度分层,enum 防错。纯文档 / 诊断用。 */
  difficulty?: SampleDifficulty;
  /** 该 sample 测的 construct 类型。suggested:`'necessity'`(测必要性,
   *  baseline-vs-skill)/ `'quality'`(测 skill 写得好不好,skill-vs-skill-variant)/
   *  `'capability'`(测某具体能力维度)。free-form string,允许自定义。
   *  纯文档 / 诊断用,不参与 grading。 */
  construct?: string;
  /** 数据来源。`omk sample` 自动注入 `'llm-generated'`,人工
   *  curated 用 `'human'`,production trace 抽样用 `'production-trace'`。
   *  纯文档 / 诊断用。 */
  provenance?: SampleProvenance;
  /** 该 sample 可选声明的 skill 结构锚点。纯文档 / 图谱诊断用，不进入评分、评委或 verdict。 */
  covers?: SampleCoverageTarget[];
  /** 诱错样本(tripwire)标记。true = 此 sample 故意设计成 LLM 应该 fail 的诱导陷阱
   *  (如:用户用错误前提诱导 / 跳步骤 / 用错参数类型),用于测 skill 是否能让 LLM
   *  识破并纠正。Diagnostic 看到 tripwire:true 时会建议"无需改 skill"(rootCause:
   *  tripwire_intentional),避免误导 skill 作者改文档去"修"一个故意的失败。
   *  UI 用户可见文案统一中文叫"诱错样本",字段名保留 tripwire 不变(API 契约)。 */
  tripwire?: boolean;
  /** 评测时拦截的工具调用 + mock 返回值。runtime 在 executor 入口安装 PreToolUse hook。
   *  详见 docs/sample-mocks.md(命中规则、状态机、fixture 文件)。 */
  mocks?: Mock[];
  /** mocks 严格模式。
   *  - false / undefined(default):未命中的 tool 调用透传(继续真跑底层)
   *  - true:未命中即 deny(防意外真调外部接口/CLI/MCP/写状态)。
   *  全 mock 评测场景建议 true,部分 mock 探索场景留 false。 */
  mocksStrict?: boolean;
  /** 环境前置:声明性"已就绪"清单,LLM 跳过探测直接干活。详见 SampleEnvironment。 */
  environment?: SampleEnvironment;
  [key: string]: unknown;  // allow extra fields like mutated prompt/context from URL resolution
}

export type ArtifactKind = 'baseline' | 'skill' | 'prompt' | 'agent' | 'workflow';

export interface Artifact {
  name: string;
  kind: ArtifactKind;
  source: 'baseline' | 'variant-name' | 'file-path' | 'git' | 'inline' | 'custom';
  content: string | null;
  // 整树内容指纹(hashArtifactSource:目录-skill 覆盖整棵可分发树、文件-skill 为单文件字节)。
  // 解析期算好挂在这里,供 report 的 artifactHashes 与 install 受管记录的 contentHash 落在同一空间
  // (证据随 artifact 走的前提)。与 `content`(executor 注入的 trim 文本)解耦——指纹不依赖正文文本。
  // baseline / 无 skill 留空。
  contentHash?: string;
  locator?: string;
  ref?: string;
  // 本地 git variant 物化时 `git rev-parse <ref>^{commit}` 出的实际 commit SHA(#234/#236 还原坐标)。
  // 内容是从 object DB 按 ref 物化的(非工作树),故这才是被测字节的精确坐标 —— 不是进程 cwd 的 HEAD。
  // 只对本地 git skill 填(远端源走 fetch-pin SHA、不经此;file 源无 git 坐标)。
  resolvedCommit?: string;
  cwd?: string;
  // SKILL.md 约定的 directory-skill **真源**根目录(doctor 校验、dependency-checker 解析、
  // 同名 variant 消歧都以此为准)。只对 directory-skill 填,file-skill 留空。
  skillRoot?: string;
  // directory-skill 的**隔离执行根**:eval 测量前 copy 出的内容寻址副本(materializeIsolatedCopy)。
  // executor 的 cwd / skillDir 锚到这里 —— 被测 agent 在隔离副本里跑、不碰真源,references/ 资产
  // 是真实运行时输入。与 skillRoot(真源)分离:doctor 等校验真源不受副本影响;execRoot 不序列化进
  // report(只 artifact.cwd 进 variantConfig),故副本路径不污染可比性。
  // task.cwd 优先级:用户显式 cwd(@/path) > execRoot > skillRoot > sample.cwd > null。
  execRoot?: string;
  // run-time 属性:variant 在当次实验中扮演的角色(由 CLI --control/--treatment 或 eval.yaml 注入)
  // 不是 artifact 文件的固有属性;同一 artifact 在不同 run 可以扮演不同角色
  experimentRole?: ExperimentRole;
  // Skill auto-discovery 隔离声明(per-variant)。
  //   undefined → 默认 SDK 行为(全发现 ~/.claude/skills/)
  //   []        → 完全禁用 skill 发现 + Skill 工具 disable(main session + subagent 同堵)
  //   [...]     → 拒绝(非空白名单不再支持:子代理 Skill 工具 + cwd 文件系统通道封不住)
  // baseline-kind 默认 [],由 --strict-baseline (default true) 注入;显式 eval.yaml 优先。
  allowedSkills?: string[];
  metadata?: Record<string, unknown>;
}

export type ExperimentType = 'baseline' | 'runtime-context-only' | 'artifact-injection';

export type ExperimentRole = 'control' | 'treatment';

export type ExecutionStrategyKind =
  | 'baseline'
  | 'system-prompt'
  | 'user-prompt'
  | 'agent-session'
  | 'workflow-session';

export interface VariantConfig {
  variant: string;
  artifactKind: ArtifactKind;
  artifactSource: Artifact['source'];
  executionStrategy: ExecutionStrategyKind;
  experimentType: ExperimentType;
  experimentRole: ExperimentRole;
  hasArtifactContent: boolean;
  cwd: string | null;
  locator?: string;
  ref?: string;
  // 本地 git variant 解析出的实际 commit SHA(还原坐标,#234/#236):从 Artifact.resolvedCommit 透传,
  // evidence.ts 按 variant 匹配后写入证据。raw `ref`(可能是 branch/tag/HEAD)会漂,这个是物化当刻的定点。
  resolvedCommit?: string;
  // 隔离声明。undefined = SDK 默认全发现,[] = 完全隔离;非空白名单已移除(无法真正隔离)。
  // 来源:Artifact.allowedSkills(由 strict-baseline 默认 + eval.yaml 显式合并而成)。
  allowedSkills?: string[];
}

/** 远端 git 源的结构化引用 —— url/ref/spec 分字段,永不拼成单串再 split(避开 parseGitInput 的 `:`
 *  与 parseVariantCwd 的 `@`)。eval 经 eval.yaml 结构化携带,install 经 --git-url/--git-ref。 */
export interface RemoteGitRef {
  url: string;
  ref?: string;   // 默认 HEAD
  spec: string;   // 仓库相对 skill 路径
}

export interface VariantSpec {
  name: string;           // variant 显示名,从 expr 提取
  role: ExperimentRole;
  expr: string;           // artifact 身份表达式(git: 前缀等),不再编码 @cwd
  // 远端 git 源(结构化);present 时取代 expr 的本地解析,走 resolveRemoteGitSource。
  git?: RemoteGitRef;
  // runtime context cwd,在 CLI/config 边界解析一次后随 spec 结构化携带,内部不再传播 name@cwd 串。
  cwd?: string;
  // 显式 skill 隔离声明(来自 eval.yaml variant.allowedSkills)。随 spec 一起走,
  // 避免再按 variant 名建一张并行 map 与 artifact 名互查(那是 allowedSkills 漏绑的源头)。
  allowedSkills?: string[];
}

export interface EvalConfigVariant {
  name: string;
  role: ExperimentRole;
  // artifact(本地路径 / 裸名 / git:<ref>:<spec>)与 git(远端结构化)二选一。
  artifact?: string;
  git?: RemoteGitRef;
  cwd?: string;
  // 显式 skill 隔离声明。优先级高于 --strict-baseline default。
  //   写 [] 完全禁用 skill 发现;非空白名单已移除(validateEvalConfig reject);不写 = 默认行为。
  // 注:YAML `allowedSkills:` 不写值会被 parse 成 null,validateEvalConfig 会显式 reject;
  //     要写就显式写 `[]`。
  allowedSkills?: string[];
}

export interface EvalConfig {
  samples: string;
  executor?: string;
  model?: string;
  /** Reasoning effort for the executor LLM. low/medium/high/xhigh/max。
   *  Default 'low'(parseRunConfig 兜底)。跨 effort 报告不可严格比较。 */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** 关闭 diagnostic LLM call。Default false。跟 noJudge 独立 — judge 答打分,
   *  diagnostic 答怎么改 skill。 */
  noDiagnostic?: boolean;
  /** 跳过 doctor 健康检查门禁。Default false。 评测环境用 mock/stub 提供依赖时,
   *  doctor 物理路径检查会误报中断 eval — 加这个 escape hatch。判分管道、verdict、
   *  judge prompt hash 不动,跨报告可比性不变。 */
  skipDoctor?: boolean;
  /** Judge configuration. 1 entry = single judge (no ensemble); ≥ 2 entries = ensemble
   *  with inter-judge agreement. Replaces v0.1 split `judgeModel` + `judgeExecutor` —
   *  unified as a single first-class concept (single judge is the degenerate case of
   *  an ensemble of size 1). When unset, defaults to `[{executor, model: 'haiku'}]` where
   *  executor follows the top-level `executor`. */
  judgeModels?: JudgeConfig[];
  concurrency?: number;
  timeoutMs?: number;
  noCache?: boolean;
  noJudge?: boolean;
  mcpConfig?: string;
  variants: EvalConfigVariant[];
  /** hard budget caps. When any limit is hit during a run, remaining
   *  tasks are aborted and the partial report is persisted. CLI flags
   *  `--budget-usd` / `--budget-per-sample-usd` / `--budget-per-sample-ms`
   *  override the config values. */
  budget?: EvalBudget;
  // ----- v0.2: experiment-design fields (CLI flag → eval.yaml parity) -----
  /** --repeat N. Multi-run variance analysis. */
  repeat?: number;
  /** --holdout-ratio R (0 < R < 1). Hold out a deterministic sample slice and
   *  report train vs holdout composite as a generalization / overfitting signal. */
  holdoutRatio?: number;
  /** --judge-repeat N. Each (sample × dimension) judged N times for self-consistency stddev. */
  judgeRepeat?: number;
  /** --bootstrap. Distribution-free CI per variant + pairwise diff. */
  bootstrap?: boolean;
  /** --bootstrap-samples. Default 1000. */
  bootstrapSamples?: number;
  /** --gold-dir. After-run automatic comparison against a human-anchor dataset. */
  goldDir?: string;
  /** --no-debias-length flips this to false. Default true (length-debias instruction on). */
  lengthDebias?: boolean;
  /** --no-strict-baseline flips this to false. Default true (baseline-kind allowedSkills=[]). */
  strictBaseline?: boolean;
}

export interface EvalBudget {
  /** Stop the run if cumulative (exec + judge) cost exceeds this many USD. */
  totalUSD?: number;
  /** Per-sample cost ceiling. Tasks exceeding this fail individually but the run continues. */
  perSampleUSD?: number;
  /** Per-sample wall-clock latency ceiling in milliseconds. */
  perSampleMs?: number;
}

export interface EvaluationRequest {
  samplesPath: string;
  skillDir: string;
  artifacts: Artifact[];
  project?: string;
  owner?: string;
  tags?: string[];
  model: string;
  executor: string;
  noJudge: boolean;
  concurrency: number;
  timeoutMs?: number;
  noCache: boolean;
  dryRun: boolean;
  /** --repeat N; 1 表示单次跑,> 1 走 runMultiple 做 variance 分析 */
  repeat?: number;
  /** --holdout-ratio R; 0 / 缺省表示不切分(默认)。> 0 时 report-finalize 在结果上
   *  post-hoc 切出 train / holdout 子集算综合分(`report.analysis.holdout`),供 verdict
   *  的过拟合门控读取。see src/eval-core/holdout.ts */
  holdoutRatio?: number;
  /** --batch; default absent/false. True means skill-batch mode. */
  batch?: boolean;
  /** --judge-repeat N; 每条 sample × dimension 用 LLM judge 跑 N 次, 输出 stddev. 默认 1 (单次). */
  judgeRepeat?: number;
  /** Unified judge config — always non-empty.
   *  - length === 1: single judge (degenerate ensemble of size 1).
   *  - length >= 2: multi-judge ensemble. Each (sample × dimension) is scored by every judge,
   *    inter-judge agreement (Pearson + mean absolute difference) reported as a rebuttal to
   *    "judge same-model bias" — but only when judges span vendors; a single-vendor ensemble's
   *    high agreement reflects shared bias, not independence (flagged by `single_vendor_ensemble`).
   *  When `noJudge: true` the entry is preserved for audit but no judge call actually runs. */
  judgeModels: JudgeConfig[];
  /** --bootstrap; true 时 aggregateReport 加跑 bootstrap mean/diff CI, 写入 VariantSummary.
   *  与原 t-interval 共存 (ReportMeta.evaluationFramework='both'), renderer 优先 bootstrap. */
  bootstrap?: boolean;
  /** --bootstrap-samples N; bootstrap 重采样次数, 默认 1000. > 10000 时 stderr 警告. */
  bootstrapSamples?: number;
  /** length-debias toggle. Default true — judge prompt carries the length-debias
   *  instruction. CLI flag --no-debias-length flips to false (drops that instruction,
   *  the debias-off prompt variant). The active value is reflected in
   *  ReportMeta.judgePromptHash and ReportMeta.debiasMode. */
  lengthDebias?: boolean;
  /** hard budget caps. See EvalBudget. */
  budget?: EvalBudget;
  /** Skill isolation default (CLI `--strict-baseline` default true).
   *  true = baseline-kind variants 没显式 allowedSkills 时自动设为 [];
   *  false = 全部 variants 没显式 allowedSkills 时保持 undefined(旧行为)。
   *  显式 eval.yaml `allowedSkills` 总是优先于此默认。 */
  strictBaseline?: boolean;
  /** Reasoning effort for executor LLM。透传到 ExecutorInput.effort。 */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** 每个执行任务失败后的最大重试次数。缺省 / 0 表示不重试。 */
  retry?: number;
  /** true 时关闭 assertion 失败后的诊断 LLM 调用。缺省等价于 false。 */
  noDiagnostic?: boolean;
}

export type EvaluationJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type EvaluationErrorCategory = 'user' | 'executor' | 'judge' | 'system';

export interface EvaluationRun {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  status: Extract<EvaluationJobStatus, 'running' | 'succeeded' | 'failed' | 'cancelled'>;
}

export interface EvaluationJob {
  jobId: string;
  status: EvaluationJobStatus;
  createdAt: string;
  updatedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  request: EvaluationRequest;
  runId?: string;
  resultReportId?: string;
  error?: string;
  errorCategory?: EvaluationErrorCategory;
}

export interface ProgressStart {
  phase: 'start';
  completed: number;
  total: number;
  sample_id: string;
  variant: string;
}

export interface ProgressExecDone {
  phase: 'exec_done';
  strategy: string;
  completed: number;
  total: number;
  sample_id: string;
  variant: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  outputPreview: string | null;
}

export interface ProgressGrading {
  phase: 'grading';
  strategy: string;
  completed: number;
  total: number;
  sample_id: string;
  variant: string;
}

export interface ProgressDone {
  phase: 'done';
  strategy?: string;
  completed: number;
  total: number;
  sample_id: string;
  variant: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUSD?: number;
  score?: number;
  ok?: boolean;
  error?: string;
  skipped?: boolean;
}

export interface ProgressRetry {
  phase: 'retry';
  completed: number;
  total: number;
  sample_id: string;
  variant: string;
  attempt: number;
  maxAttempts: number;
}

export interface ProgressError {
  phase: 'error';
  completed: number;
  total: number;
  sample_id: string;
  variant: string;
  error: string;
}

export interface ProgressPreflight {
  phase: 'preflight';
  jobId?: string;
}

export type ProgressInfo = ProgressStart | ProgressExecDone | ProgressGrading | ProgressDone | ProgressRetry | ProgressError | ProgressPreflight;
export type ProgressCallback = (info: ProgressInfo) => void;

export interface Task {
  sample_id: string;
  variant: string;
  artifact: Artifact;
  prompt: string;
  rubric: string | null;
  assertions: Assertion[] | null;
  dimensions: Record<string, string> | null;
  artifactContent: string | null;
  cwd: string | null;
  _sample: Sample;
}
