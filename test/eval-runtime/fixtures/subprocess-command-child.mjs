// Test child for the façade-level subprocess exchange. The mode arrives through the environment
// because the request document only carries measurement coordinates, never test instructions.
import { setTimeout as sleep } from 'node:timers/promises';

const SCHEMA_VERSION = 'omk.subprocess-command-exchange/v1';
const CONFORMANCE_ANSWERS = { one: 'A' };
const mode = process.env.OMK_FIXTURE_MODE ?? 'echo';

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;

const request = JSON.parse(raw);
const { trial, attempt } = request;

function write(document) {
  process.stdout.write(`${JSON.stringify(document)}\n`);
}

function completed(extra = {}) {
  write({
    schemaVersion: SCHEMA_VERSION,
    resultStatus: 'completed',
    output: {
      echoed: trial.input.query,
      artifactName: request.artifact.name,
      sampleId: trial.sampleId,
      variantId: trial.variantId,
      trialIndex: trial.trialIndex,
      attemptNumber: attempt.attemptNumber,
      allowedTools: trial.allowedTools ?? null,
      executionContext: trial.executionContext ?? null,
      config: trial.config ?? null,
    },
    usage: { totalTokens: 7 },
    ...extra,
  });
}

switch (mode) {
  case 'echo':
    completed({ trace: { environmentKeys: Object.keys(process.env).sort() } });
    break;
  case 'env-probe':
    completed();
    break;
  case 'failed':
    write({
      schemaVersion: SCHEMA_VERSION,
      resultStatus: 'failed',
      error: { code: 'OMK_FIXTURE_TARGET_UNAVAILABLE', stage: 'execution' },
      usage: { totalTokens: 3 },
    });
    break;
  case 'malformed':
    process.stdout.write('this is not a JSON document\n');
    break;
  case 'stale-schema-version':
    write({
      schemaVersion: 'omk.subprocess-command-exchange/v0',
      resultStatus: 'completed',
      output: { echoed: trial.input.query },
    });
    break;
  case 'unknown-field':
    completed({ diagnostic: 'provider-private detail' });
    break;
  case 'missing-output':
    write({ schemaVersion: SCHEMA_VERSION, resultStatus: 'completed' });
    break;
  case 'undeclared-trace':
    completed({ trace: { unexpected: true } });
    break;
  case 'slow':
    await sleep(10_000);
    completed();
    break;
  case 'noisy':
    for (let index = 0; index < 512; index += 1) process.stdout.write('x'.repeat(1024));
    break;
  case 'byte-chunked': {
    // One byte per write: read boundaries necessarily fall inside multibyte characters.
    const document = Buffer.from(`${JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      resultStatus: 'completed',
      output: { echoed: '知识改动有据可依' },
    })}\n`, 'utf8');
    for (const byte of document) {
      process.stdout.write(Buffer.from([byte]));
      await sleep(1);
    }
    break;
  }
  case 'nonzero-exit':
    process.stderr.write('provider-private crash detail\n');
    process.exitCode = 3;
    break;
  case 'conformance': {
    const prompt = trial.input.prompt;
    if (prompt === 'failure') {
      write({
        schemaVersion: SCHEMA_VERSION,
        resultStatus: 'failed',
        error: { code: 'OMK_FIXTURE_TARGET_UNAVAILABLE', stage: 'execution' },
      });
      break;
    }
    if (prompt === 'cancellation') {
      await sleep(10_000);
      break;
    }
    write({
      schemaVersion: SCHEMA_VERSION,
      resultStatus: 'completed',
      output: CONFORMANCE_ANSWERS[prompt] ?? null,
    });
    break;
  }
  default:
    process.exitCode = 1;
}
