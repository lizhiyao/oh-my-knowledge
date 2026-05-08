export interface ToolCallInfo {
  tool: string;
  input: unknown;
  output: unknown;
  success: boolean;
  messageIndex?: number;
  messageUuid?: string;
  toolUseId?: string;
  timestamp?: string;
}

export interface TurnInfo {
  role: 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCallInfo[];
  durationMs?: number;
}

export interface ExecResult {
  ok: boolean;
  output: string | null;
  durationMs: number;
  durationApiMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUSD: number;
  /** Whether the underlying executor binary/SDK reported a USD cost figure.
   *  - undefined / true : `costUSD` is authoritative (default — Anthropic SDK / OpenAI API / etc 都报)
   *  - false            : executor 不报 cost,`costUSD` 是占位 0,renderer 应显示「未报告」/「—」。
   *  目前只有 codex-cli executor 设 false (codex 0.125 binary 不输出 cost)。 */
  costReportedByExecutor?: boolean;
  stopReason: string;
  numTurns: number;
  fullNumTurns?: number;
  numSubAgents?: number;
  error?: string;
  cached?: boolean;
  turns?: TurnInfo[];
  toolCalls?: ToolCallInfo[];
  /** Sample.mocks 命中统计。仅当 input.mocks 非空时有值。
   *  perMock 的 key 格式:`<tool>:<mock-index>`(与 mocks 数组下标对应) */
  mockStats?: {
    hits: number;
    misses: number;
    perMock: Record<string, number>;
  };
}

export interface ExecutorInput {
  model: string;
  system?: string | null;
  prompt: string;
  cwd?: string | null;
  skillDir?: string | null;
  timeoutMs?: number;
  verbose?: boolean;
  // Skill 隔离白名单(per-task)。来源:Artifact.allowedSkills。
  //   undefined → executor 不传 SDK skills option(默认全发现)
  //   []        → SDK skills:[] + disallowedTools:['Skill'](main session + subagent 双堵)
  //   [...]     → SDK skills:[...](白名单)
  allowedSkills?: string[];
  /** 评测时拦截的工具调用 + mock 返回值。来源:Sample.mocks。
   *  - claude-sdk:转 in-process HookCallback 装到 SDK options.hooks.PreToolUse
   *  - claude-cli:物化为临时 CLAUDE_CONFIG_DIR + on-disk hook 脚本,跑完清理
   *  - 其他 executor:暂不支持(WARN 后透传) */
  mocks?: import('./eval.js').Mock[];
  /** 解析 mock.return_file 的相对路径锚点(默认 sample 文件所在目录)。 */
  mocksBaseDir?: string;
  /** strict 模式:未命中 mock 的 tool 调用直接 deny。来源:Sample.mocksStrict。 */
  mocksStrict?: boolean;
  /**
   * Lean 模式:不需要 agent 工具循环的纯文本生成路径(如 sample 生成 / skill 改写),
   * executor 会跳过 skill 发现 / 工具加载等 agent 启动开销。
   * 实现细节:
   *   - claude-cli: 追加 `--tools "" --disable-slash-commands`
   *   - claude-sdk: 设 `disallowedTools: ['*']`,`skills: []`
   *   - 其他 executor: 透传忽略
   * 评测调用(eval / judge)绝不能开 lean,否则 LLM 调不了工具。
   */
  lean?: boolean;
  /**
   * Reasoning effort:控制扩展思考(extended thinking)的预算。
   *   - 'low': 几乎不思考,直接出答案。最快最便宜,适合结构化任务 / 生成场景。
   *   - 'medium': 中等思考预算。
   *   - 'high': 默认 sonnet 行为,大量思考。质量最高但慢/贵。
   *   - 'xhigh' / 'max': 更深(opus 系列)。
   * 实现:
   *   - claude-cli: 追加 `--effort <level>`
   *   - claude-sdk: 设对应 SDK option(@anthropic-ai/claude-agent-sdk 暂不公开,跳过)
   *   - 其他 executor: 透传忽略
   * lean=true 时 effort 一定 = 'low'(lean 路径强制省思考),即使外面传了 high 也以 lean 为准。
   */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export type ExecutorFn = (input: ExecutorInput) => Promise<ExecResult>;

export interface ExecutorCache {
  get(key: string): ExecResult | null;
  set(key: string, value: ExecResult): void;
  save(): void;
  size(): number;
}

export interface McpFetchTool {
  name: string;
  urlParam?: string;
  urlTransform?: { regex: string; params: Record<string, string> };
  contentExtract?: string;
}

export interface McpServerDef {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  urlPatterns: string[];
  fetchTool: McpFetchTool;
}

export type McpServers = Record<string, McpServerDef>;

// ─────────────────────────────────────────────────────────────────────────────
// Executor runtime fingerprint — describes which binary / SDK actually ran the
// executor at run time, plus capability flags. Persisted on Report.meta and
// Report.meta.judgeModels[i].runtime so cross-version reports can audit binary
// / SDK parity. Lives here (not in report.ts) because it is fundamentally an
// executor concept, and keeping it here breaks the judge.ts ↔ report.ts type
// import cycle.
// ─────────────────────────────────────────────────────────────────────────────

export type ExecutorRuntimeKind = 'agent-cli' | 'agent-sdk' | 'api' | 'script' | 'unknown';

export type ExecutorSystemPromptMode = 'native' | 'prepended' | 'none' | 'unknown';

export type ExecutorCostMode = 'reported' | 'not-reported' | 'unknown';

export type ExecutorTraceMode = 'native' | 'best-effort' | 'none' | 'unknown';

export type ExecutorSkillIsolationMode = 'full' | 'full-no-partial' | 'cwd-only' | 'none' | 'unknown';

export interface ExecutorRuntimeCapabilities {
  systemPrompt: ExecutorSystemPromptMode;
  costUSD: ExecutorCostMode;
  trace: ExecutorTraceMode;
  skillIsolation: ExecutorSkillIsolationMode;
}

export interface ExecutorRuntimePackage {
  name: string;
  version?: string;
  error?: string;
}

export interface ExecutorRuntimeBinary {
  name: string;
  source: 'path' | 'bundled' | 'none' | 'unknown';
  version?: string;
  path?: string;
  package?: ExecutorRuntimePackage;
  error?: string;
}

export interface ExecutorRuntimeFingerprint {
  executor: string;
  model: string;
  kind: ExecutorRuntimeKind;
  fingerprint: string;
  binary?: ExecutorRuntimeBinary;
  sdk?: ExecutorRuntimePackage;
  capabilities: ExecutorRuntimeCapabilities;
}
