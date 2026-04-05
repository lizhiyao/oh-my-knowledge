import { spawn } from 'node:child_process';
import type { ExecResult, ExecutorInput } from '../types.js';
import { DEFAULT_TIMEOUT_MS, errorMessage, GeminiResponse, parseJson } from './shared.js';

export async function geminiExecutor({ model, system, prompt, timeoutMs = DEFAULT_TIMEOUT_MS }: ExecutorInput): Promise<ExecResult> {
  const fullPrompt = system ? `${system}\n\n${prompt}` : prompt;
  const start = Date.now();
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const args: string[] = [];
      if (model) args.push('--model', model);
      const child = spawn('gemini', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
        timeout: timeoutMs,
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
      child.on('error', (err: Error) => reject(err));
      child.on('close', (code: number | null) => {
        if (code !== 0 && !stdout) reject(new Error(stderr || `gemini exited with code ${code}`));
        else resolve(stdout);
      });
      child.stdin.write(fullPrompt);
      child.stdin.end();
    });

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
