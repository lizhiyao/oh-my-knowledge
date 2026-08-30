#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

if (process.argv.includes('--version')) {
  process.stdout.write('2.1.226 (Claude Code)\n');
  process.exit(0);
}

if (process.argv.includes('--help')) {
  const flags = [
    '--append-system-prompt-file',
    '--disable-slash-commands',
    '--disallowedTools',
    '--effort',
    '--mcp-config',
    '--model',
    '--no-chrome',
    '--no-session-persistence',
    '--output-format',
    '--permission-mode',
    '--print',
    '--setting-sources',
    '--settings',
    '--strict-mcp-config',
    '--tools',
    '--verbose',
  ];
  if (process.env.OMK_TEST_INCOMPLETE_HELP) flags.pop();
  process.stdout.write(flags.join('\n') + '\n');
  process.exit(0);
}

const mode = process.env.OMK_TEST_MODE || 'success';
if (process.env.OMK_TEST_INVOCATIONS) {
  appendFileSync(process.env.OMK_TEST_INVOCATIONS, 'invoke\n');
}

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk.toString();

function valuesAfter(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return [];
  const values = [];
  for (let cursor = index + 1; cursor < process.argv.length; cursor += 1) {
    const value = process.argv[cursor];
    if (value.startsWith('--')) break;
    values.push(value);
  }
  return values;
}

if (process.env.OMK_TEST_CAPTURE || process.env.OMK_TEST_CAPTURE_LOG) {
  const systemPromptFile = valuesAfter('--append-system-prompt-file')[0];
  const settingsFile = valuesAfter('--settings')[0];
  const mcpConfigFiles = valuesAfter('--mcp-config');
  const capture = {
    args: process.argv.slice(2),
    prompt,
    cwd: process.cwd(),
    configDirectory: process.env.CLAUDE_CONFIG_DIR,
    settingSources: valuesAfter('--setting-sources'),
    systemPrompt: systemPromptFile ? readFileSync(systemPromptFile, 'utf8') : null,
    settingsExists: settingsFile ? existsSync(settingsFile) : false,
    mcpConfigs: mcpConfigFiles.map((path) => path.startsWith('{')
      ? JSON.parse(path)
      : JSON.parse(readFileSync(path, 'utf8'))),
    mockFileExists: process.env.OMK_MOCKS_FILE
      ? existsSync(process.env.OMK_MOCKS_FILE)
      : false,
    mockFile: process.env.OMK_MOCKS_FILE || null,
    ambientMemoryDisabled: process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS === '1'
      && process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === '1',
    attachmentsDisabled: process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS === '1',
    persistentBackgroundWorkDisabled: process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS === '1'
      && process.env.CLAUDE_CODE_DISABLE_CRON === '1',
    secretVisible: process.env.OMK_TEST_SECRET ? true : false,
  };
  if (process.env.OMK_TEST_CAPTURE) {
    writeFileSync(process.env.OMK_TEST_CAPTURE, JSON.stringify(capture));
  }
  if (process.env.OMK_TEST_CAPTURE_LOG) {
    appendFileSync(process.env.OMK_TEST_CAPTURE_LOG, `${JSON.stringify(capture)}\n`);
  }
}

if (mode === 'wait') {
  if (process.env.OMK_TEST_STARTED) writeFileSync(process.env.OMK_TEST_STARTED, 'started');
  const keepAlive = setInterval(() => {}, 60_000);
  process.on('SIGTERM', () => {
    clearInterval(keepAlive);
    if (process.env.OMK_TEST_CANCELLED) writeFileSync(process.env.OMK_TEST_CANCELLED, 'cancelled');
    process.exit(143);
  });
  await new Promise(() => {});
}

if (mode === 'oversized') {
  process.stdout.write(JSON.stringify({ type: 'system', payload: 'x'.repeat(8192) }) + '\n');
  await new Promise((resolve) => setTimeout(resolve, 1000));
  process.exit(0);
}

if (mode === 'malformed') {
  process.stdout.write('{\n');
  process.exit(0);
}

const assistant = {
  type: 'assistant',
  message: {
    role: 'assistant',
    content: mode === 'invalid-message'
      ? 'fixture answer'
      : [{ type: 'text', text: 'fixture answer' }],
  },
  uuid: 'assistant-a',
  session_id: 'session-a',
};
const result = {
  type: 'result',
  subtype: mode === 'failed' ? 'error_during_execution' : 'success',
  is_error: mode === 'invalid-terminal' ? 'false' : mode === 'failed',
  result: mode === 'empty' ? '' : 'fixture answer',
  stop_reason: 'end_turn',
  duration_ms: 12,
  duration_api_ms: 10,
  num_turns: 1,
  ...(
    mode === 'no-usage'
      ? {}
      : {
          total_cost_usd: mode === 'invalid-usage'
            ? -1
            : mode === 'overflowing-cost'
              ? Number.MAX_VALUE
              : 0.002,
          modelUsage: {
            'claude-test': {
              inputTokens: 8,
              outputTokens: 5,
              cacheReadInputTokens: 2,
              cacheCreationInputTokens: 1,
            },
          },
        }
  ),
  ...(mode === 'failed' ? { errors: ['provider failed'] } : {}),
  uuid: 'result-a',
  session_id: 'session-a',
};

process.stdout.write(JSON.stringify({
  type: 'system', subtype: 'init', session_id: 'session-a', uuid: 'system-a',
}) + '\n');
process.stdout.write(JSON.stringify(assistant) + '\n');
process.stdout.write(JSON.stringify(result) + '\n');
if (mode === 'duplicate-result') process.stdout.write(JSON.stringify(result) + '\n');
if (mode === 'post-terminal') process.stdout.write(JSON.stringify(assistant) + '\n');
if (mode === 'nonzero') process.exit(7);
