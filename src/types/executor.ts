export interface ToolCallInfo {
  tool: string;
  input: unknown;
  output: unknown;
  success: boolean;
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
  stopReason: string;
  numTurns: number;
  fullNumTurns?: number;
  numSubAgents?: number;
  error?: string;
  cached?: boolean;
  turns?: TurnInfo[];
  toolCalls?: ToolCallInfo[];
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
