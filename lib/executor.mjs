import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);

export const DEFAULT_MODEL = 'sonnet';
export const JUDGE_MODEL = 'haiku';

/**
 * Create an executor by name.
 * Executors wrap CLI tools into a unified interface.
 *
 * Available executors:
 *   - claude: Claude CLI (`claude -p`)
 *   - openai: OpenAI CLI (`openai api chat.completions.create`)
 *   - gemini: Gemini CLI (`gemini` via stdin pipe)
 */
export function createExecutor(name = 'claude') {
  switch (name) {
    case 'claude':
      return claudeExecutor;
    case 'openai':
      return openaiExecutor;
    case 'gemini':
      return geminiExecutor;
    case 'script':
      return scriptExecutor;
    default:
      throw new Error(`Unknown executor: ${name}. Available: claude, openai, gemini, script`);
  }
}

// ---------------------------------------------------------------------------
// Claude CLI executor
// ---------------------------------------------------------------------------

async function claudeExecutor({ model, system, prompt }) {
  const args = ['-p', prompt, '--output-format', 'json', '--model', model];
  if (system) args.push('--system-prompt', system);

  const proxyUrl = process.env.CCV_PROXY_URL || undefined;
  const env = proxyUrl
    ? { ...process.env, ANTHROPIC_BASE_URL: proxyUrl }
    : { ...process.env };

  const start = Date.now();
  try {
    const { stdout } = await execFileAsync('claude', args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
      env,
    });
    const durationMs = Date.now() - start;
    const data = JSON.parse(stdout);
    const usage = data.usage || {};
    return {
      ok: !data.is_error,
      durationMs: data.duration_ms || durationMs,
      durationApiMs: data.duration_api_ms || 0,
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      cacheReadTokens: usage.cache_read_input_tokens || 0,
      cacheCreationTokens: usage.cache_creation_input_tokens || 0,
      costUSD: data.total_cost_usd || 0,
      output: data.result || '',
      stopReason: data.stop_reason || 'unknown',
      numTurns: data.num_turns || 1,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    let parsed = null;
    try { parsed = JSON.parse(err.stdout || ''); } catch {}
    return {
      ok: false,
      error: parsed?.result || err.message || 'unknown error',
      durationMs,
      durationApiMs: 0,
      inputTokens: parsed?.usage?.input_tokens || 0,
      outputTokens: parsed?.usage?.output_tokens || 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUSD: parsed?.total_cost_usd || 0,
      output: null,
      stopReason: 'error',
      numTurns: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// OpenAI CLI executor
// Requires: `pip install openai` (provides `openai` CLI)
// Auth: OPENAI_API_KEY environment variable
// ---------------------------------------------------------------------------

async function openaiExecutor({ model, system, prompt }) {
  const args = ['api', 'chat.completions.create',
    '-m', model || 'gpt-4o',
  ];
  if (system) {
    args.push('-g', 'system', system);
  }
  args.push('-g', 'user', prompt);

  const start = Date.now();
  try {
    const { stdout } = await execFileAsync('openai', args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
      env: { ...process.env },
    });
    const durationMs = Date.now() - start;
    const data = JSON.parse(stdout);
    const usage = data.usage || {};
    const content = data.choices?.[0]?.message?.content || '';
    const finishReason = data.choices?.[0]?.finish_reason || 'unknown';

    return {
      ok: true,
      durationMs,
      durationApiMs: 0,
      inputTokens: usage.prompt_tokens || 0,
      outputTokens: usage.completion_tokens || 0,
      cacheReadTokens: usage.prompt_tokens_details?.cached_tokens || 0,
      cacheCreationTokens: 0,
      costUSD: 0, // OpenAI CLI does not return cost
      output: content,
      stopReason: finishReason,
      numTurns: 1,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    let parsed = null;
    try { parsed = JSON.parse(err.stdout || ''); } catch {}
    return {
      ok: false,
      error: parsed?.error?.message || err.message || 'unknown error',
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

// ---------------------------------------------------------------------------
// Gemini CLI executor
// Requires: `npm i -g @google/gemini-cli` (provides `gemini` CLI)
// Auth: Google account login or GOOGLE_API_KEY environment variable
//
// Gemini CLI is primarily interactive. We pipe the prompt via stdin
// and collect stdout as the response.
// ---------------------------------------------------------------------------

async function geminiExecutor({ model, system, prompt }) {
  const fullPrompt = system ? `${system}\n\n${prompt}` : prompt;

  const start = Date.now();
  try {
    const output = await new Promise((resolve, reject) => {
      const args = [];
      if (model) {
        args.push('--model', model);
      }
      const child = spawn('gemini', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
        timeout: 120_000,
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });

      child.on('error', (err) => reject(err));
      child.on('close', (code) => {
        if (code !== 0 && !stdout) {
          reject(new Error(stderr || `gemini exited with code ${code}`));
        } else {
          resolve(stdout);
        }
      });

      child.stdin.write(fullPrompt);
      child.stdin.end();
    });

    const durationMs = Date.now() - start;

    // Try to parse as JSON (gemini may return structured output)
    let text = output;
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      const data = JSON.parse(output);
      if (data.response) text = data.response;
      if (data.stats) {
        inputTokens = data.stats.inputTokens || 0;
        outputTokens = data.stats.outputTokens || 0;
      }
    } catch {
      // Plain text response — use as-is
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
  } catch (err) {
    const durationMs = Date.now() - start;
    return {
      ok: false,
      error: err.message || 'unknown error',
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

// ---------------------------------------------------------------------------
// Script executor
// Runs a skill directory's scripts with transcript content as input.
// In script mode, `system` is the absolute path to a skill directory.
//
// Auto-detection order for entry point:
//   1. eval.sh in skill root (user-provided wrapper)
//   2. scripts/*.py (auto-wrapped: detect invocation pattern from SKILL.md)
//
// The executor writes transcript content to a temp file, runs the skill,
// captures the generated markdown from a temp output dir, and returns it.
//
// Metrics reporting:
//   Scripts can report token/cost metrics by writing a JSON line to stderr:
//   echo '{"omk_metrics":{"inputTokens":150,"outputTokens":300,"costUSD":0.003}}' >&2
// ---------------------------------------------------------------------------

import { readFileSync as _readFileSync, existsSync as _existsSync, readdirSync as _readdirSync } from 'node:fs';

/**
 * Detect common dependency issues from script stderr output.
 */
function detectDependencyWarnings(stderr) {
  if (!stderr) return [];
  const warnings = [];
  const lower = stderr.toLowerCase();
  if (lower.includes('no module named') || lower.includes('importerror') || lower.includes('modulenotfounderror')) {
    const match = stderr.match(/No module named ['"]([\w.-]+)['"]/i)
      || stderr.match(/ModuleNotFoundError.*['"]([\w.-]+)['"]/i);
    const pkg = match ? match[1] : 'unknown';
    warnings.push(`Python 依赖缺失: ${pkg}。请运行 pip install ${pkg}`);
  }
  if (lower.includes('anthropic') && (lower.includes('import') || lower.includes('fallback') || lower.includes('not available'))) {
    if (!warnings.some((w) => w.includes('anthropic'))) {
      warnings.push('anthropic SDK 未安装，skill 可能使用了 fallback 模式（质量降低）。请运行 pip install anthropic');
    }
  }
  if (lower.includes('command not found') || lower.includes('not recognized')) {
    const match = stderr.match(/([\w-]+):\s*(command not found|not recognized)/i);
    const cmd = match ? match[1] : 'unknown';
    warnings.push(`命令未找到: ${cmd}。请确认已安装对应工具`);
  }
  return warnings;
}

function parseMetricsFromStderr(stderr) {
  if (!stderr) return {};
  const lines = stderr.split('\n').reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.includes('"omk_metrics"')) {
      try {
        const parsed = JSON.parse(trimmed);
        return parsed.omk_metrics || {};
      } catch { /* not valid JSON, skip */ }
    }
  }
  return {};
}

/**
 * Detect Python entry script in a skill directory.
 * Returns the absolute path to the .py file, or null.
 */
function findPythonEntry(skillDir) {
  const scriptsDir = join(skillDir, 'scripts');
  if (!_existsSync(scriptsDir)) return null;
  const pyFiles = _readdirSync(scriptsDir).filter((f) => f.endsWith('.py') && !f.startsWith('__'));
  if (pyFiles.length === 0) return null;
  return join(scriptsDir, pyFiles[0]);
}

/**
 * Detect invocation style from SKILL.md frontmatter or script content.
 * Returns 'stdin' if the script reads from stdin, 'cli' otherwise.
 */
function detectInvocationStyle(pyPath) {
  try {
    const content = _readFileSync(pyPath, 'utf-8');
    // If script reads stdin (sys.stdin), it expects hook JSON input
    if (content.includes('sys.stdin') || content.includes('read_hook_input')) {
      return 'stdin';
    }
    return 'cli';
  } catch {
    return 'cli';
  }
}

/**
 * Build a shell command string that invokes the skill and outputs markdown to stdout.
 */
function buildSkillCommand(skillDir, transcriptPath) {
  const outputDir = join(tmpdir(), `omk-skill-output-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  // 1. Check for eval.sh (user-provided wrapper)
  const evalSh = join(skillDir, 'eval.sh');
  if (_existsSync(evalSh)) {
    return `bash "${evalSh}" "${transcriptPath}"`;
  }

  // 2. Auto-detect Python entry
  const pyPath = findPythonEntry(skillDir);
  if (!pyPath) {
    return `echo "No entry script found in ${skillDir}" >&2 && exit 1`;
  }

  const style = detectInvocationStyle(pyPath);

  if (style === 'stdin') {
    // stdin-based (codex style): pipe hook JSON to script
    // Note: heredoc uses unquoted HOOKEOF so $OUTPUT_DIR gets expanded
    return [
      `OUTPUT_DIR=$(mktemp -d)`,
      `printf '{"session_id":"eval-%s","cwd":"%s","transcript_path":"${transcriptPath}"}' "$$" "$OUTPUT_DIR" | python3 "${pyPath}"`,
      `MDFILE=$(find "$OUTPUT_DIR" -name "*.md" -type f 2>/dev/null | head -1)`,
      `[ -n "$MDFILE" ] && cat "$MDFILE"`,
      `rm -rf "$OUTPUT_DIR"`,
    ].join('\n');
  } else {
    // cli-based (cc style): pass transcript as argument
    // stderr is NOT suppressed so metrics can be captured
    return [
      `OUTPUT_DIR=$(mktemp -d)`,
      `python3 "${pyPath}" --transcript "${transcriptPath}" --machine-ip "127.0.0.1" --memory-path "$OUTPUT_DIR" --auto-confirm true`,
      `MDFILE=$(find "$OUTPUT_DIR" -name "*.md" -type f 2>/dev/null | head -1)`,
      `[ -n "$MDFILE" ] && cat "$MDFILE"`,
      `rm -rf "$OUTPUT_DIR"`,
    ].join('\n');
  }
}

async function scriptExecutor({ model, system, prompt }) {
  const skillDir = system; // In script mode, system holds the skill directory path
  if (!skillDir) {
    return {
      ok: false, error: 'script executor requires a skill directory path in system field',
      durationMs: 0, durationApiMs: 0, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheCreationTokens: 0, costUSD: 0,
      output: null, stopReason: 'error', numTurns: 0,
    };
  }

  // Write prompt content to a temp file (serves as transcript input)
  const tmpFile = join(tmpdir(), `omk-transcript-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(tmpFile, prompt);

  const command = buildSkillCommand(skillDir, tmpFile);

  const start = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync('bash', ['-c', command], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 180_000,
      env: { ...process.env },
      cwd: skillDir,
    });
    const durationMs = Date.now() - start;
    const output = stdout.trim();
    const metrics = parseMetricsFromStderr(stderr);

    // Check stderr for dependency warnings
    const warnings = detectDependencyWarnings(stderr);
    if (warnings.length > 0) {
      process.stderr.write(`\n⚠️  ${warnings.join('\n⚠️  ')}\n`);
    }

    return {
      ok: true, // Script exited successfully (exit code 0), even if no output (e.g. correct rejection)
      durationMs,
      durationApiMs: metrics.durationApiMs || 0,
      inputTokens: metrics.inputTokens || 0,
      outputTokens: metrics.outputTokens || 0,
      cacheReadTokens: metrics.cacheReadTokens || 0,
      cacheCreationTokens: metrics.cacheCreationTokens || 0,
      costUSD: metrics.costUSD || 0,
      output: output || '',
      stopReason: 'end',
      numTurns: 1,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    const metrics = parseMetricsFromStderr(err.stderr);
    return {
      ok: false,
      error: err.stderr || err.message || 'script execution failed',
      durationMs,
      durationApiMs: metrics.durationApiMs || 0,
      inputTokens: metrics.inputTokens || 0,
      outputTokens: metrics.outputTokens || 0,
      cacheReadTokens: metrics.cacheReadTokens || 0,
      cacheCreationTokens: metrics.cacheCreationTokens || 0,
      costUSD: metrics.costUSD || 0,
      output: err.stdout || null,
      stopReason: 'error',
      numTurns: 0,
    };
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}
