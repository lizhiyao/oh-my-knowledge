#!/usr/bin/env node

import { appendFile, readFile, writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);

if (args.length === 1 && args[0] === '--version') {
  process.stdout.write('codex-cli 0.146.0\n');
  process.exit(0);
}

if (process.env.OMK_TEST_INVOCATIONS) {
  await appendFile(process.env.OMK_TEST_INVOCATIONS, 'exec\n');
}

if (process.env.OMK_TEST_CAPTURE) {
  const separator = args.lastIndexOf('--');
  await writeFile(process.env.OMK_TEST_CAPTURE, JSON.stringify({
    args,
    cwd: process.cwd(),
    prompt: separator < 0 ? null : args[separator + 1],
    inheritedHome: process.env.HOME ?? null,
    explicit: process.env.OMK_TEST_EXPLICIT ?? null,
  }));
}

let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
if (stdin !== '') {
  process.stderr.write('unexpected stdin content');
  process.exit(9);
}

const mode = process.env.OMK_TEST_MODE ?? 'success';
if (mode === 'exit') {
  process.stderr.write('sensitive provider failure');
  process.exit(7);
}
if (mode === 'invalid') {
  process.stdout.write('{not-json}\n');
  process.exit(0);
}
if (mode === 'oversized') {
  process.stdout.write('x'.repeat(4096));
  process.exit(0);
}
if (mode === 'wait') {
  if (process.env.OMK_TEST_STARTED) await writeFile(process.env.OMK_TEST_STARTED, 'started');
  process.on('SIGTERM', async () => {
    if (process.env.OMK_TEST_CANCELLED) {
      await writeFile(process.env.OMK_TEST_CANCELLED, 'cancelled');
    }
    process.exit(0);
  });
  await new Promise(() => setInterval(() => {}, 1_000));
}

let answer = 'fixture answer';
if (mode === 'workspace-state') {
  answer = await readFile('.trial-marker', 'utf8').catch(() => 'clean');
  await writeFile('.trial-marker', 'contaminated');
}

const event = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
if (mode !== 'missing-thread') event({ type: 'thread.started', thread_id: 'thread-test' });
event({ type: 'turn.started' });
event({
  type: 'item.completed',
  item: { id: 'message-1', type: 'agent_message', text: answer },
});
if (mode === 'duplicate-item') {
  event({
    type: 'item.completed',
    item: { id: 'message-1', type: 'agent_message', text: 'duplicate answer' },
  });
}
if (mode === 'tool') {
  event({
    type: 'item.completed',
    item: {
      id: 'command-1',
      type: 'command_execution',
      command: 'pwd',
      aggregated_output: process.cwd(),
      exit_code: 0,
      status: 'completed',
    },
  });
}
const usage = mode === 'usage' || mode === 'failed-usage'
  ? {
      input_tokens: 8,
      cached_input_tokens: 3,
      output_tokens: 5,
      reasoning_output_tokens: 2,
    }
  : undefined;
event({
  type: mode === 'failed' || mode === 'failed-usage' ? 'turn.failed' : 'turn.completed',
  ...(usage === undefined ? {} : { usage }),
  ...(mode === 'failed' || mode === 'failed-usage'
    ? { error: { message: 'sensitive failure detail' } }
    : {}),
});
