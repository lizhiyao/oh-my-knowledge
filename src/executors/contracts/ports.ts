import type { ExecResult } from './result.js';
import type { ExecutorRuntimeFingerprint } from './runtime.js';
import type { Mock } from '../../eval-workflows/inputs/contracts/mock.js';

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
   *  - claude-sdk:转 in-process HookCallback 装到 SDK options.hooks.PreToolUse
   *  - claude-cli:物化为临时 settings.json + on-disk hook 脚本,跑完清理
   *  - script(自定义脚本):同样物化临时 settings,通过 env(OMK_MOCK_SETTINGS_FILE /
   *    OMK_MOCK_MCP_CONFIG_FILE / OMK_MOCKS_FILE)暴露给脚本;脚本负责消费该协议
   *  - codex / codex-sdk / *-api:不支持,executor capability gate 会拒绝,
   *    绝不静默忽略后把 mock_hit 记成模型失败 */
  mocks?: Mock[];
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
