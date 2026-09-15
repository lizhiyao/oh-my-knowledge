import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile, readFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createCodexCliReferenceExecutor, createCodexCliReferenceEvaluator, evaluate } from 'oh-my-knowledge';

const root = process.cwd();
const modelConfigPath = join(root, 'codex-reference-config.toml');
await writeFile(modelConfigPath, 'model = "fixture-default"');
// 捕获按角色建目录：同一角色的并发调用各自写唯一文件，断言侧聚合，
// 不共享 O_TRUNC 目标（issue #921）。
const environment = (mode, role) => ({
  PATH: { value: dirname(process.execPath), identity: { identityKind: 'behavior', value: dirname(process.execPath) } },
  OMK_TEST_MODE: { value: mode, identity: { identityKind: 'behavior', value: mode } },
  OMK_TEST_CAPTURE: { value: join(root, `${role}-captures`), identity: { identityKind: 'effect-locator' } },
});
for (const role of ['target', 'judge']) await mkdir(join(root, `${role}-captures`));
const readCaptures = async (role) => {
  const directory = join(root, `${role}-captures`);
  const files = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  assert.ok(files.length > 0, `expected at least one ${role} capture`);
  return Promise.all(files.map((name) => readFile(join(directory, name), 'utf8').then(JSON.parse)));
};
const connection = { executablePath: join(root, 'vendor-codex.mjs'), modelConfigPath };
const evaluator = await createCodexCliReferenceEvaluator({
  ...connection, environment: environment('judge', 'judge'),
  judgeId: 'codex-judge', evaluatorId: 'quality', rubrics: [{ metricId: 'quality-score',  criterionId: 'quality', prompt: 'Judge correctness.', rubric: '4 means correct.'  }],

});
const executor = await createCodexCliReferenceExecutor({
  ...connection, environment: environment('success', 'target'), executorId: 'codex-target',
  model: evaluator.judges[0].model,
});
await writeFile(modelConfigPath, 'model = "changed"');
const result = await evaluate({
  dataset: { datasetId: 'codex-fixture', samples: ['one', 'two'].map((sampleId) => ({ sampleId, input: 'answer' })) },
  variants: [
    { variantId: 'baseline', artifact: { name: 'baseline', kind: 'baseline', source: 'baseline', content: null }, execution: { executor } },
    { variantId: 'candidate', artifact: { name: 'candidate', kind: 'prompt', source: 'inline', content: 'Answer carefully.' }, execution: { executor } },
  ],
  evaluators: [evaluator],
  comparisons: [{ comparisonId: 'comparison', controlVariantId: 'baseline', treatmentVariantIds: ['candidate'], metricIds: ['quality-score'] }],
  analyses: [{ analysisId: 'interval', analysisKind: 'comparison-interval', statistic: 'mean-difference', comparisonId: 'comparison', treatmentVariantId: 'candidate', metricId: 'quality-score', confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 100 } }],
  decision: { decisionKind: 'analysis', analysisId: 'interval' },
  experiment: { seed: 'fixed', sampling: { samplingKind: 'paired', seedCoupling: 'uncontrolled' } },
  policy: {},
}, { runId: 'codex-package-run' });
assert.equal(result.status, 'completed');
const observations = result.artifacts.evaluation.records.flatMap((record) => record.evaluationStatus === 'completed' ? record.observations : []);
assert.equal(observations.length, 4);
assert.ok(observations.every((observation) => observation.observationStatus === 'observed' && observation.value === 4));
// 2 samples × 2 variants = 4 次 target 调用、4 次 judge 调用；逐次断言保持原有口径。
const targets = await readCaptures('target');
const judges = await readCaptures('judge');
assert.equal(targets.length, 4);
assert.equal(judges.length, 4);
for (const target of targets) {
  assert.ok(target.args.includes('fixture-default'));
  assert.ok(!target.prompt.includes('4 means correct.'));
  await assert.rejects(access(target.cwd));
}
for (const judge of judges) {
  assert.ok(judge.args.includes('fixture-default'));
  assert.ok(judge.prompt.includes('4 means correct.'));
  await assert.rejects(access(judge.cwd));
}
const targetCwds = new Set(targets.map((capture) => capture.cwd));
const judgeCwds = new Set(judges.map((capture) => capture.cwd));
assert.equal(targetCwds.size, 4);
assert.equal(judgeCwds.size, 4);
assert.ok([...targetCwds].every((cwd) => !judgeCwds.has(cwd)));
