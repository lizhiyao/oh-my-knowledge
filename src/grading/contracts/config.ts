/** Single judge configuration: which executor to call and which model alias to pass. */
export interface JudgeConfig {
  /** Executor name (claude / codex / anthropic-api / openai-api / shell command). */
  executor: string;
  /** Model alias passed to the executor (e.g. "opus", "haiku", "gpt-4o"). */
  model: string;
}
