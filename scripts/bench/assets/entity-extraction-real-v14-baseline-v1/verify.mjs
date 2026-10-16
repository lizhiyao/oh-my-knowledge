#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import childProcess from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';

const assetRoot = dirname(fileURLToPath(import.meta.url));
const repository = resolve(assetRoot, '../../../..');
const manifestDigest = 'sha256:60215f01005ee8c2fb3a1e69728bcad89d6b328cadfecdd127d51b076ba08243';
const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const inside = (root, path) => { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); };
const utf8 = bytes => { const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); assert(Buffer.from(text).equals(bytes)); return text; };
const usage = 'node verify.mjs --capture-dir /absolute/external-originals [--out /tmp/new-report.json]';
let stage = 'arguments';
const counters = { fetch: 0, socket: 0, listen: 0, http: 0, tls: 0, datagram: 0, subprocess: 0 };
const restorations = [];
function deny(target, key, counter) {
  const original = target[key];
  target[key] = function () { counters[counter]++; throw new Error('Offline operation forbidden.'); };
  restorations.push(() => { target[key] = original; });
}
function guard() {
  deny(globalThis, 'fetch', 'fetch'); deny(net.Socket.prototype, 'connect', 'socket'); deny(net.Server.prototype, 'listen', 'listen');
  deny(net, 'connect', 'socket'); deny(net, 'createConnection', 'socket'); deny(tls, 'connect', 'tls');
  for (const module of [http, https]) for (const method of ['request', 'get']) deny(module, method, 'http');
  deny(dgram, 'createSocket', 'datagram');
  for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) deny(childProcess, method, 'subprocess');
  syncBuiltinESMExports();
}
function fixedFile(root, name, expected) {
  assert(!isAbsolute(name) && !name.split('/').some(part => part === '..' || part === ''), 'Invalid fixed filename.');
  let path = root;
  for (const part of name.split('/')) { path = resolve(path, part); assert(!lstatSync(path).isSymbolicLink(), 'Symlink rejected.'); }
  const stat = lstatSync(path); assert(stat.isFile() && stat.size === expected.bytes, 'File length mismatch.');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd); assert(opened.isFile()); assert.equal(opened.size, expected.bytes, 'File changed before read.');
    // Read at most the frozen length plus one byte even if another process grows the file after fstat.
    const buffer = Buffer.alloc(expected.bytes + 1); let offset = 0;
    while (offset < buffer.length) { const count = readSync(fd, buffer, offset, buffer.length - offset, offset); if (!count) break; offset += count; }
    assert.equal(offset, expected.bytes, 'File length changed during read.'); assert.equal(fstatSync(fd).size, expected.bytes);
    const bytes = buffer.subarray(0, offset); assert.equal(hash(bytes), expected.sha256, 'File hash mismatch.');
    return bytes;
  } finally { closeSync(fd); }
}
function outputPath(requested, captureRoot) {
  assert(isAbsolute(requested), 'Output must be absolute.'); const target = resolve(requested), parent = realpathSync(dirname(target));
  const temporaryRoots = [tmpdir(), ...(existsSync('/tmp') ? ['/tmp'] : [])].map(path => realpathSync(path));
  assert(temporaryRoots.some(root => inside(root, parent)), 'Output must be under OS temporary storage.');
  assert(!inside(realpathSync(repository), parent) && !inside(captureRoot, parent), 'Output must be outside checkout and originals.');
  assert(!existsSync(target), 'Existing output rejected.'); return resolve(parent, target.split(sep).at(-1));
}
async function verify(options) {
  stage = 'manifest'; const manifestBytes = readFileSync(resolve(assetRoot, 'manifest.json')); assert.equal(hash(manifestBytes), manifestDigest);
  const manifest = JSON.parse(utf8(manifestBytes)); assert.equal(manifest.manifestKind, 'omk-external-entity-baseline/v1');
  stage = 'capture-directory'; assert(isAbsolute(options['--capture-dir'])); const captureRoot = realpathSync(options['--capture-dir']);
  assert(!inside(realpathSync(repository), captureRoot), 'Originals must stay outside checkout.');
  const reportPath = options['--out'] ? outputPath(options['--out'], captureRoot) : null;
  stage = 'capture-files'; const bytes = new Map();
  for (const file of manifest.files) bytes.set(file.path, fixedFile(captureRoot, file.path, file));
  const json = name => JSON.parse(utf8(bytes.get(name)));
  stage = 'historical-bindings';
  const identity = json('measurement-identity.json'), plan = json('plan.json'), executedPlan = json('capture/execution-plan.json');
  const authorization = json('authorization.json'), captured = json('capture/manifest.json'), output = json('capture/output.json'), runtime = json('capture/runtime.json');
  const receipt = json('results/execution-receipt.json'), closure = json('results/closure-receipt.json'), preparation = json('preparation-receipt.json');
  assert.equal(hash(bytes.get('measurement-identity.json')), manifest.historicalMeasurementId);
  for (const value of [plan, executedPlan, authorization, captured, receipt, closure, preparation]) assert.equal(value.measurementId, manifest.historicalMeasurementId);
  assert.deepEqual(executedPlan.identity, identity); assert.deepEqual(plan.identity, identity);
  for (const [file, field] of [['plan.json', 'preparedPlanDigest'], ['capture.mjs', 'captureDriverDigest'], ['preflight.mjs', 'preflightDriverDigest'], ['preparation-receipt.json', 'preparationReceiptDigest']]) {
    assert.equal(hash(bytes.get(file)), authorization[field]);
  }
  assert.deepEqual(captured.authorization, authorization); assert.deepEqual(executedPlan.authorization, authorization);
  assert.equal(captured.preparedPlanDigest, authorization.preparedPlanDigest);
  assert.equal(authorization.maxCalls, 1); assert.equal(authorization.executor, manifest.historicalExecution.requestedExecutor);
  assert.equal(authorization.model, manifest.historicalExecution.requestedModel); assert.equal(authorization.automaticRetries, 0);
  assert.equal(captured.executorInvocations, 1); assert.equal(captured.recorded, 1); assert.equal(captured.attempted, 1);
  assert.equal(captured.budgetClosed, true); assert.equal(captured.remainingCallsAuthorizedForFurtherExecution, 0);
  assert.equal(closure.remainingCalls, 0); assert.equal(closure.goldReady, false); assert.equal(closure.independentHumanReview, 'not_performed');
  for (const item of receipt.rawCaptureFiles) assert.equal(hash(bytes.get(item.file)), item.digest);
  for (const item of preparation.files) if (bytes.has(item.file)) assert.equal(hash(bytes.get(item.file)), item.digest);
  const source = json('capture/input.json'); const rawOutput = Buffer.from(output.result.output, 'utf8');
  assert.equal(hash(bytes.get('capture/input.json')), manifest.historicalInputDigest); assert.equal(output.inputDigest, manifest.historicalInputDigest);
  assert.equal(identity.inputDigest, manifest.historicalInputDigest); assert.equal(identity.promptDigest, manifest.historicalPromptDigest);
  assert.equal(hash(bytes.get('capture/prompt.txt')), manifest.historicalPromptDigest);
  assert.equal(hash(bytes.get('response-schema.json')), identity.responseSchemaDigest);
  assert.equal(hash(rawOutput), manifest.historicalRawOutputDigest); assert.equal(rawOutput.length, manifest.rawOutputUtf8Bytes);
  assert.equal(runtime.output, output.result.output); assert.equal(captured.outputDigest, manifest.historicalRawOutputDigest);
  assert.equal(receipt.outputDigest, manifest.historicalRawOutputDigest); assert.equal(output.result.captureStatus, 'output');
  assert.equal(output.caseId, executedPlan.caseId); assert.equal(output.repeat, 1); assert.equal(source.excerpts.length, 4); assert.equal(source.limitations.length, manifest.dataPolicy.originalInputLimitations.count);
  assert.equal(hash(JSON.stringify(source.limitations)), manifest.dataPolicy.originalInputLimitations.jsonStringifyDigest);
  assert.deepEqual(json('results/source-wrapper-disclosure.json').originalInputLimitations, source.limitations);
  assert.equal(runtime.ok, true); assert.equal(runtime.inputTokens, manifest.historicalExecution.inputTokens);
  assert.equal(runtime.outputTokens, manifest.historicalExecution.outputTokens); assert.equal(runtime.costReportedByExecutor, false);
  assert.equal(hash(bytes.get('capture/manifest.json')), receipt.rawCaptureFiles.find(file => file.file === 'capture/manifest.json').digest);
  stage = 'current-pure-runtime';
  const runtimeRoot = realpathSync(resolve(repository, 'dist'));
  const components = ['observability/knowledge-extraction/model-wire.js', 'observability/knowledge-extraction/window-proposals.js',
    'observability/knowledge-extraction/entities.js', 'observability/knowledge-extraction/quote-occurrence.js',
    'observability/knowledge-extraction/proposals.js', 'knowledge/contracts.js', 'knowledge/validation.js', 'observability/knowledge-extraction/prompt.js'];
  const moduleDigests = components.map(path => ({ path, sha256: hash(readFileSync(resolve(runtimeRoot, path))) }));
  // Literal deterministic production entry points. Never import old scripts, sealed-build, an executor or a corpus.
  const wire = await import('../../../../dist/observability/knowledge-extraction/model-wire.js');
  const checker = await import('../../../../dist/observability/knowledge-extraction/window-proposals.js');
  const knowledge = await import('../../../../dist/knowledge/contracts.js');
  const prompt = await import('../../../../dist/observability/knowledge-extraction/prompt.js');
  const requireValidator = createRequire(pathToFileURL(resolve(runtimeRoot, components[0])));
  const validators = { zod: requireValidator('zod/package.json').version, ajv: requireValidator('ajv/package.json').version };
  const currentPromptDigest = hash(Buffer.from(prompt.EXTRACTION_PROMPT, 'utf8'));
  const replayIdentity = { identityKind: 'omk-external-entity-baseline-replay/v1', historicalMeasurementId: manifest.historicalMeasurementId,
    assetManifestDigest: hash(manifestBytes), verifierDigest: hash(readFileSync(fileURLToPath(import.meta.url))),
    inputDigest: manifest.historicalInputDigest, outputDigest: manifest.historicalRawOutputDigest,
    transport: 'historical-prompt-json/JSON.parse', currentPromptVersion: prompt.EXTRACTION_PROMPT_VERSION, currentPromptDigest,
    currentWireId: wire.WINDOW_EXTRACTION_WIRE_ID, currentWireIdentity: wire.WINDOW_EXTRACTION_WIRE_IDENTITY, validators,
    nodeVersion: process.versions.node, nodeBinaryDigest: hash(readFileSync(process.execPath)), moduleDigests };
  stage = 'current-replay';
  let domainValid = null, deterministic = null, admissionDigest = null, counts = null, validDrafts = null;
  let admissionStatus = 'checker_error';
  try {
    // Historical prompt-json uses JSON.parse, as production/collector do. Do not add null placeholders.
    const response = JSON.parse(utf8(rawOutput)); domainValid = checker.WindowExtractionModelSchema.safeParse(response).success;
    const admitted = checker.checkWindowExtractionResponse(response, source.excerpts);
    const second = checker.checkWindowExtractionResponse(JSON.parse(utf8(rawOutput)), source.excerpts);
    admissionDigest = hash(canonical(admitted)); deterministic = admissionDigest === hash(canonical(second));
    counts = { entities: admitted.analysis.entities.length, mentions: admitted.analysis.mentions.length, acceptedProposals: admitted.accepted.length,
      statements: admitted.accepted.reduce((n, proposal) => n + proposal.draft.content.statements.length, 0),
      citations: admitted.accepted.reduce((n, proposal) => n + proposal.citations.length, 0),
      evidenceLinks: admitted.accepted.reduce((n, proposal) => n + proposal.draft.evidence.length, 0),
      entityRejections: admitted.analysis.rejected.length, proposalRejections: admitted.rejected.length };
    validDrafts = admitted.accepted.filter(proposal => knowledge.KnowledgeDraftSchema.safeParse(proposal.draft).success).length;
    admissionStatus = 'completed';
  } catch {
    // An incompatible current checker is a new-identity diagnostic, not damage to the frozen capture.
    deterministic = null; admissionDigest = null; counts = null; validDrafts = null;
  }
  // Diagnostic only: an old prompt-only response need not satisfy the newer strict-wire placeholders.
  let wireDiagnostic;
  try { wireDiagnostic = wire.decodeWindowExtractionWire(rawOutput); }
  catch { wireDiagnostic = { decodeStatus: 'decoder_error' }; }
  const matchesHistoricalCounts = counts !== null && canonical(counts) === canonical(manifest.historicalCounts);
  const status = admissionStatus === 'completed' && deterministic && domainValid && validDrafts === counts.acceptedProposals
    && matchesHistoricalCounts ? 'replayed' : 'diagnostic_mismatch';
  assert(Object.values(counters).every(value => value === 0), 'Forbidden operation attempted.');
  const report = { verificationKind: 'omk-external-entity-baseline-verification/v1', status,
    verificationId: hash(canonical(replayIdentity)), identity: replayIdentity,
    integrity: { fixedFiles: bytes.size, allMatched: true, historicalAuthorizationBindingsMatched: true, rawOutputMatchesRuntime: true },
    replay: { originalTransport: 'prompt-json', admissionStatus, domainValid, deterministic, admissionDigest,
      counts, historicalCounts: manifest.historicalCounts, matchesHistoricalCounts, validDrafts,
      strictWireDiagnostic: { scope: 'diagnostic-only;not-the-historical-transport', decodeStatus: wireDiagnostic.decodeStatus,
        wireStatus: wireDiagnostic.wireStatus ?? null, itemFailureCount: wireDiagnostic.wireFailures?.length ?? null },
      currentPromptMatchesHistorical: currentPromptDigest === manifest.historicalPromptDigest },
    historicalExecution: manifest.historicalExecution, historicalReview: manifest.review,
    currentModelCalls: 0, attemptedOperations: { ...counters },
    codeScope: { imports: 'fixed-literal-deterministic-production-entries;no-executor-entry',
      credentials: 'no-credential-access-in-verifier-source;not-a-global-read-counter' },
    independentHumanReview: 'not_performed', goldReady: false, qualityConclusion: 'not_evaluated', rawTextEmitted: false,
    limits: ['Integrity and deterministic structural/location/reference replay only; no new semantic review or historical dispatch re-attestation.',
      'Current replay identity is separate from historical measurement and from both proposed strict-wire arms.',
      'Listed deterministic modules and actual validator versions are not a complete transitive dependency-byte closure.',
      'Historical requested model is not provider-reported model/snapshot; provider request count/endpoint and per-bucket presence remain unknown.',
      'Raw source/output/runtime stay external; metadata review is not permission to publish their text.'] };
  stage = 'optional-report'; if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n'); if (status !== 'replayed') process.exitCode = 1;
}

try {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const name = process.argv[i]; if (name === '--help' && process.argv.length === 3) { console.log(usage); process.exit(0); }
    assert(['--capture-dir', '--out'].includes(name) && !Object.hasOwn(options, name));
    assert(process.argv[i + 1] && !process.argv[i + 1].startsWith('--')); options[name] = process.argv[i + 1];
  }
  assert(options['--capture-dir'], 'Explicit capture directory required.');
  assert.equal(process.execArgv.length, 0, 'Use a clean Node process without loaders/preloads.');
  assert(!process.env.NODE_OPTIONS, 'NODE_OPTIONS is forbidden; use a clean process.');
  guard(); await verify(options);
} catch {
  // Native parser/assertion errors can include private text, values or paths. Emit only a fixed stage and counters.
  process.stderr.write(JSON.stringify({ verificationKind: 'omk-external-entity-baseline-verification/v1', status: 'rejected', stage, attemptedOperations: counters }) + '\n');
  process.exitCode = 1;
} finally { restorations.reverse().forEach(restore => restore()); syncBuiltinESMExports(); }
