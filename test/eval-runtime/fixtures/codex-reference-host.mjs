import assert from 'node:assert/strict';
import { writeFile, readFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createCodexCliReferenceExecutor, createCodexCliReferenceEvaluator, evaluate } from 'oh-my-knowledge';

const root = process.cwd();
const modelConfigPath = join(root, 'codex-reference-config.toml');
await writeFile(modelConfigPath, 'model = "fixture-default"');
const environment = (mode, role) => ({
  PATH: { value: dirname(process.execPath), identity: { identityKind: 'behavior', value: dirname(process.execPath) } },
  OMK_TEST_MODE: { value: mode, identity: { identityKind: 'behavior', value: mode } },
  OMK_TEST_CAPTURE: { value: join(root, `${role}.json`), identity: { identityKind: 'effect-locator' } },
});
const connection = { executablePath: join(root, 'vendor-codex.mjs'), modelConfigPath };
const evaluator = await createCodexCliReferenceEvaluator({
  ...connection, environment: environment('judge', 'judge'),
  judgeId: 'codex-judge', evaluatorId: 'quality', metricId: 'quality-score',
  rubric: { criterionId: 'quality', prompt: 'Judge correctness.', rubric: '4 means correct.' },
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
const target = JSON.parse(await readFile(join(root, 'target.json'), 'utf8'));
const judge = JSON.parse(await readFile(join(root, 'judge.json'), 'utf8'));
assert.ok(target.args.includes('fixture-default'));
assert.ok(judge.args.includes('fixture-default'));
assert.ok(!target.prompt.includes('4 means correct.'));
assert.ok(judge.prompt.includes('4 means correct.'));
assert.notEqual(target.cwd, judge.cwd);
await assert.rejects(access(target.cwd));
await assert.rejects(access(judge.cwd));
