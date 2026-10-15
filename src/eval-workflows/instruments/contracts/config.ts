/** Single judge configuration: provider selection plus optional deployment identity. */
export interface JudgeConfig {
  /** Executor name (codex / codex-sdk / openai-api / custom executable path). */
  executor: string;
  /** Model identifier or mutable alias passed to the executor. */
  model: string;
  /**
   * Host-declared immutable revision of the remote model/deployment actually selected.
   * Omit when unknown; OMK then marks the judge Runtime identity opaque.
   */
  deploymentRevision?: string;
}
