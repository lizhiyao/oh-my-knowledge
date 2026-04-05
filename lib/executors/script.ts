import { spawn } from 'node:child_process';
import type { ExecResult, ExecutorFn, ExecutorInput } from '../types.js';
import { DEFAULT_TIMEOUT_MS } from './shared.js';

export function createScriptExecutor(command: string): ExecutorFn {
  return async function scriptExecutor({ model, system, prompt, cwd, timeoutMs = DEFAULT_TIMEOUT_MS }: ExecutorInput): Promise<ExecResult> {
    const input = JSON.stringify({ model, system: system || '', prompt });
    const start = Date.now();

    return new Promise<ExecResult>((resolve) => {
      const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [command];
      const cmd = parts[0].replace(/^["']|["']$/g, '');
      const args = parts.slice(1).map((a) => a.replace(/^["']|["']$/g, ''));

      const child = spawn(cmd, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
        timeout: timeoutMs,
        ...(cwd && { cwd }),
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => { stdout += d; });
      child.stderr.on('data', (d: Buffer) => { stderr += d; });

      child.on('error', (err: Error) => {
        resolve({
          ok: false, error: `executor command failed: ${err.message}`,
          durationMs: Date.now() - start, durationApiMs: 0,
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
          costUSD: 0, output: null, stopReason: 'error', numTurns: 0,
        });
      });

      child.on('close', (code: number | null) => {
        const durationMs = Date.now() - start;
        if (code !== 0) {
          resolve({
            ok: false, error: stderr.trim() || `executor exited with code ${code}`,
            durationMs, durationApiMs: 0,
            inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
            costUSD: 0, output: null, stopReason: 'error', numTurns: 0,
          });
          return;
        }
        try {
          const data = JSON.parse(stdout);
          resolve({
            ok: true, output: data.output || '', durationMs,
            durationApiMs: data.durationApiMs || 0,
            inputTokens: data.inputTokens || 0, outputTokens: data.outputTokens || 0,
            cacheReadTokens: data.cacheReadTokens || 0, cacheCreationTokens: data.cacheCreationTokens || 0,
            costUSD: data.costUSD || 0, stopReason: data.stopReason || 'end', numTurns: data.numTurns || 1,
          });
        } catch {
          resolve({
            ok: true, output: stdout.trim(), durationMs, durationApiMs: 0,
            inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
            costUSD: 0, stopReason: 'end', numTurns: 1,
          });
        }
      });

      child.stdin.write(input);
      child.stdin.end();
    });
  };
}
