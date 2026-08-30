import { appendFile, writeFile } from 'node:fs/promises';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const schemaVersion = 'omk.custom-command-exchange/v1';
const mode = process.env.OMK_TEST_MODE ?? 'success';

if (process.env.OMK_TEST_INVOCATIONS) {
  await appendFile(process.env.OMK_TEST_INVOCATIONS, 'spawn\n');
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

if (mode === 'exit') {
  process.stderr.write('sensitive-provider-diagnostic');
  process.exit(7);
}

if (mode === 'oversized') {
  process.stdout.write('x'.repeat(4096));
  process.exit(0);
}

if (mode === 'invalid') {
  process.stdout.write(JSON.stringify({
    schemaVersion,
    resultStatus: 'completed',
    output: { value: 'ok', classification: 'public' },
    unexpected: true,
  }));
  process.exit(0);
}

if (mode === 'failed') {
  process.stdout.write(JSON.stringify({
    schemaVersion,
    resultStatus: 'failed',
    error: { code: 'TEST_PROVIDER_UNAVAILABLE', stage: 'infrastructure' },
    ...(process.env.OMK_TEST_USAGE === '1' ? { usage: { inputTokens: 3 } } : {}),
  }));
  process.exit(0);
}

process.stdout.write(JSON.stringify({
  schemaVersion,
  resultStatus: 'completed',
  output: {
    value: { echoed: request.trial.input },
    classification: 'public',
  },
  trace: {
    value: {
      request,
      cwd: process.cwd(),
      inheritedHome: process.env.HOME ?? null,
      explicitValue: process.env.OMK_TEST_EXPLICIT ?? null,
    },
    classification: 'sensitive',
  },
  ...(process.env.OMK_TEST_USAGE === '1'
    ? { usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } }
    : process.env.OMK_TEST_USAGE === 'empty'
      ? { usage: {} }
    : {}),
}));
