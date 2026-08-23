import type { ExecResult, ExecutorInput } from '../types/index.js';
import { optionalTokenCount } from '../shared/token-usage.js';
import { DEFAULT_TIMEOUT_MS } from './defaults.js';
import { errorMessage, interruptedExecResult, timeoutExecResult } from './runtime.js';
import { spawnWithSigintPropagation, type SpawnHelperError } from './subprocess.js';

interface GeminiResponse {
  response?: string;
  stats?: { inputTokens?: number; outputTokens?: number };
}

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
    child.stdin?.on('error', () => undefined);
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
      const durationMs = Date.now() - start;
      return {
        ok: false,
        error: details.stderr?.trim() || details.message || `gemini exited with code ${details.code ?? '?'}`,
        durationMs,
        durationApiMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        tokenUsageReportedByExecutor: false,
        costUSD: 0,
        costReportedByExecutor: false,
        output: details.stdout?.trim() || null,
        stopReason: 'error',
        numTurns: 0,
      };
    }

    const durationMs = Date.now() - start;
    let text = output;
    let inputTokens = 0;
    let outputTokens = 0;
    let tokenUsageReported = false;
    try {
      const parsed = JSON.parse(output) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        const declaresProtocol = Object.hasOwn(record, 'response')
          || Object.hasOwn(record, 'stats');
        if (declaresProtocol) {
          const data = parsed as GeminiResponse;
          if (typeof data.response !== 'string') {
            return invalidGeminiProtocolResult(
              durationMs,
              '"response" must be a string',
            );
          }
          text = data.response;
          if (
            data.stats !== undefined
            && (
              !data.stats
              || typeof data.stats !== 'object'
              || Array.isArray(data.stats)
            )
          ) {
            return invalidGeminiProtocolResult(
              durationMs,
              '"stats" must be an object when present',
            );
          }
          if (data.stats !== undefined) {
            const parsedInput = optionalTokenCount(data.stats.inputTokens);
            const parsedOutput = optionalTokenCount(data.stats.outputTokens);
            if (parsedInput === undefined || parsedOutput === undefined) {
              return invalidGeminiProtocolResult(
                durationMs,
                'invalid token usage',
              );
            }
            inputTokens = parsedInput;
            outputTokens = parsedOutput;
            tokenUsageReported = true;
          }
        }
      }
    } catch {
      text = output.trim();
    }

    if (!text.trim()) {
      return {
        ok: false,
        error: 'gemini completed without model output',
        durationMs,
        durationApiMs: 0,
        inputTokens,
        outputTokens,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        ...(!tokenUsageReported && { tokenUsageReportedByExecutor: false }),
        costUSD: 0,
        costReportedByExecutor: false,
        output: null,
        stopReason: 'error',
        numTurns: 1,
      };
    }

    return {
      ok: true,
      durationMs,
      durationApiMs: 0,
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      ...(!tokenUsageReported && { tokenUsageReportedByExecutor: false }),
      costUSD: 0,
      costReportedByExecutor: false,
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
      tokenUsageReportedByExecutor: false,
      costUSD: 0,
      costReportedByExecutor: false,
      output: null,
      stopReason: 'error',
      numTurns: 0,
    };
  }
}

function invalidGeminiProtocolResult(
  durationMs: number,
  message: string,
): ExecResult {
  return {
    ok: false,
    error: `gemini returned malformed protocol JSON: ${message}`,
    durationMs,
    durationApiMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    tokenUsageReportedByExecutor: false,
    costUSD: 0,
    costReportedByExecutor: false,
    output: null,
    stopReason: 'error',
    numTurns: 1,
  };
}
