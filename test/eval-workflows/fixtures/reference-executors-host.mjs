// Independent clean-room host: assembles the published reference Executor from a tarball install and
// drives a real vendor process, so packaging regressions surface outside the source tree.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CODEX_CLI_MIN_SUPPORTED_VERSION,
  CODEX_CLI_REFERENCE_ADAPTER_VERSION,
  DEFAULT_CODEX_CLI_REFERENCE_PROBE_TIMEOUT_MS,
  createCodexCliReferenceExecutor,
} from 'oh-my-knowledge/eval-hosts';

const CREDENTIAL = 'sk-clean-room-credential-must-not-leak';
const vendorPath = fileURLToPath(new URL('./vendor-codex.mjs', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'omk-eval-hosts-clean-room-'));
const capturePath = join(root, 'capture.json');

try {
  const executor = await createCodexCliReferenceExecutor({
    executorId: 'clean-room.vendor-codex/v1',
    executablePath: vendorPath,
    model: 'gpt-clean-room',
    effort: 'medium',
    sandbox: 'read-only',
    contentIdentityFiles: [{ facetId: 'clean-room-vendor', path: vendorPath }],
    fingerprintFacets: { deployment: 'clean-room' },
    environment: {
      PATH: { value: dirname(process.execPath), identity: { identityKind: 'behavior', value: 'host' } },
      HOME: { value: '/home/vendor-account', identity: { identityKind: 'behavior', value: '/home/vendor-account' } },
      CODEX_SESSION_SECRET: { value: CREDENTIAL, identity: { identityKind: 'credential' } },
      OMK_TEST_MODE: { value: 'success', identity: { identityKind: 'behavior', value: 'success' } },
      OMK_TEST_CAPTURE: { value: capturePath, identity: { identityKind: 'effect-locator' } },
    },
  });

  // The vendor stand-in reports the floor release itself, so the probed version is the floor.
  assert.equal(executor.version, CODEX_CLI_MIN_SUPPORTED_VERSION);
  assert.equal(executor.capabilities.determinism, 'stochastic');
  assert.equal(executor.capabilities.seedControl, 'unsupported');
  assert.equal(executor.capabilities.telemetry.providerCost.reporting, 'unsupported');
  assert.equal(executor.outputClassification, 'secret');
  assert.deepEqual(Object.keys(executor).sort(), [
    'capabilities',
    'execute',
    'executorId',
    'fingerprintFacets',
    'outputClassification',
    'outputMediaType',
    'schemas',
    'traceClassification',
    'traceMediaType',
    'version',
  ]);
  assert.ok(!JSON.stringify(executor).includes(CREDENTIAL));
  const codex = executor.fingerprintFacets.codexCli;
  assert.equal(codex.adapter.adapterVersion, CODEX_CLI_REFERENCE_ADAPTER_VERSION);
  assert.equal(codex['version-floor'].minSupportedVersion, CODEX_CLI_MIN_SUPPORTED_VERSION);
  assert.equal(codex['version-floor'].probeTimeoutMs, DEFAULT_CODEX_CLI_REFERENCE_PROBE_TIMEOUT_MS);
  assert.equal(codex.runtime.model, 'gpt-clean-room');
  assert.equal(codex.runtime.effort, 'medium');
  assert.ok(codex.launcher.executablePathDigest.startsWith('sha256:'));
  assert.equal(codex.binary.files.length, 2);
  assert.equal(codex['fixed-controls'].session, 'ephemeral');
  assert.equal(codex['input-projection'].version, 'omk.codex-cli-prompt/v1');

  const result = await executor.execute({
    input: { prompt: 'clean-room' },
    artifact: { name: 'skill', kind: 'skill', source: 'inline', content: '# Skill\nRule.' },
    config: undefined,
    sampleId: 'sample-1',
    variantId: 'candidate',
    trialIndex: 0,
    attemptNumber: 1,
    signal: new AbortController().signal,
  });
  assert.equal(result.errorCode, undefined);
  assert.equal(result.output, 'fixture answer');
  const captured = JSON.parse(await readFile(capturePath, 'utf8'));
  assert.equal(captured.args[0], 'exec');
  assert.equal(captured.inheritedHome, '/home/vendor-account');
  assert.ok(captured.prompt.includes('# Skill'));

  // A leased workspace is outside the published seam: fail closed instead of running without it.
  const refused = await executor.execute({
    input: { prompt: 'clean-room' },
    artifact: { name: 'skill', kind: 'skill', source: 'inline', content: '# Skill\nRule.' },
    config: undefined,
    sampleId: 'sample-2',
    variantId: 'candidate',
    trialIndex: 1,
    attemptNumber: 1,
    workspace: { root: join(root, 'overlay'), descriptor: { resourceId: 'clean-room-workspace' } },
    signal: new AbortController().signal,
  });
  assert.equal(refused.errorCode, 'OMK_CODEX_CLI_ISOLATION_UNSUPPORTED');
  assert.equal(refused.output, undefined);
} finally {
  await rm(root, { recursive: true, force: true });
}
