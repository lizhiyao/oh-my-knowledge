import type { ExecResult } from './result.js';
import type { ExecutorRuntimeFingerprint } from './runtime.js';
import type { Mock } from './mock.js';

export interface ExecutorInput {
  model: string;
  system?: string | null;
  prompt: string;
  cwd?: string | null;
  skillDir?: string | null;
  timeoutMs?: number;
  verbose?: boolean;
  // Skill 隔离声明(per-task)。来源:Artifact.allowedSkills。
  //   undefined → executor 不传 SDK skills option(默认全发现)
  //   []        → SDK skills:[] + disallowedTools:['Skill'](main session + subagent 双堵)
  //   [...]     → reject(非空白名单不再支持:无法真正隔离,executor throw)
  allowedSkills?: string[];
  /** 评测时拦截的工具调用 + mock 返回值。来源:Sample.mocks。
   *  - script(自定义脚本):物化 manifest 与可选 MCP 配置,通过 env(OMK_MOCK_MCP_CONFIG_FILE / OMK_MOCKS_FILE)暴露给脚本;脚本负责消费该协议
   *  - codex / codex-sdk / *-api:不支持,executor capability gate 会拒绝,
   *    绝不静默忽略后把 mock_hit 记成模型失败 */
  mocks?: Mock[];
  /** 解析 mock.return_file 的相对路径锚点(默认 sample 文件所在目录)。 */
  mocksBaseDir?: string;
  /** strict 模式:未命中 mock 的 tool 调用直接 deny。来源:Sample.mocksStrict。 */
  mocksStrict?: boolean;
  /** 轻量生成提示；宿主自行决定是否支持。评测调用不得启用。 */
  lean?: boolean;
  /** 推理投入级别；由支持该选项的宿主执行。 */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Cooperative cancellation owned by the caller; executors forward it to I/O. */
  abortSignal?: AbortSignal;
}

export type ExecutorRuntimeFingerprintResolver = (
  model: string,
  options?: { skillDir?: string | null },
) => ExecutorRuntimeFingerprint;

export type ExecutorFn = ((input: ExecutorInput) => Promise<ExecResult>) & {
  /** Same-process hosts can report the runtime that actually owns execution. */
  readonly runtimeFingerprint?: ExecutorRuntimeFingerprintResolver;
};

export interface ExecutorCache {
  get(key: string): ExecResult | null;
  set(key: string, value: ExecResult): void;
  save(): void;
  size(): number;
}
