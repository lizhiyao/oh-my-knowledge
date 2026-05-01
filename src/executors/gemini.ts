import type { ExecResult, ExecutorInput } from '../types/index.js';
import {
  DEFAULT_TIMEOUT_MS,
  errorMessage,
  GeminiResponse,
  interruptedExecResult,
  parseJson,
  spawnWithSigintPropagation,
  timeoutExecResult,
  type SpawnHelperError,
} from './shared.js';

export async function geminiExecutor({ model, system, prompt, timeoutMs = DEFAULT_TIMEOUT_MS }: ExecutorInput): Promise<ExecResult> {
  const fullPrompt = system ? `${system}\n\n${prompt}` : prompt;
  const start = Date.now();
  try {
    const args: string[] = [];
    if (model) args.push('--model', model);
    const { child, done } = spawnWithSigintPropagation('gemini', args, {
      env: { ...process.env },
      timeoutMs,
    });
    child.stdin?.write(fullPrompt);
    child.stdin?.end();
    let output: string;
    try {
      const r = await done;
      output = r.stdout;
    } catch (err: unknown) {
      const details = err as SpawnHelperError;
      if (details.killedByTimeout) return timeoutExecResult(timeoutMs, Date.now() - start);
      if (details.killedBySignal) return interruptedExecResult(Date.now() - start);
      // gemini 退出码非 0 但有 stdout 时仍按成功路径解析(原行为);只在 stdout 为空时才视为失败
      if (details.stdout && details.stdout.length > 0) {
        output = details.stdout;
      } else {
        throw err;
      }
    }

    const durationMs = Date.now() - start;
    let text = output;
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      const data = parseJson<GeminiResponse>(output);
      if (data.response) text = data.response;
      if (data.stats) {
        inputTokens = data.stats.inputTokens || 0;
        outputTokens = data.stats.outputTokens || 0;
      }
    } catch {
      text = output.trim();
    }

    return {
      ok: true,
      durationMs,
      durationApiMs: 0,
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUSD: 0,
      output: text,
      stopReason: 'end',
      numTurns: 1,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    return {
      ok: false,
      error: errorMessage(err),
      durationMs,
      durationApiMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUSD: 0,
      output: null,
      stopReason: 'error',
      numTurns: 0,
    };
  }
}
