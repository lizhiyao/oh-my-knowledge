// Fixture executor for omk doctor CLI tests — bypasses real LLM calls.
//
// Reads { model, system, prompt } from stdin (script-executor protocol)
// and writes { output, ... } to stdout. The `output` is a deterministic
// JSON payload shaped for src/doctor/health/parser.ts: 7 builtin dimensions
// with checklist + summary.overall_health.
//
// Outcome is controlled via OMK_DOCTOR_FIXTURE_OUTCOME env:
//   'pass' (default) → all dims 健康, overall 良好
//   'fail'           → all dims 不健康 + 错误 finding, overall 严重缺陷
//
// Test harness sets the env per-case to drive pass/fail paths without
// touching real Claude/Codex sessions.

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
JSON.parse(Buffer.concat(chunks).toString('utf8'));

const outcome = process.env.OMK_DOCTOR_FIXTURE_OUTCOME ?? 'pass';

const DIM_IDS = [
  'trigger-boundary',
  'doc-clarity',
  'instr-precision',
  'dependency',
  'tool-conventions',
  'security',
  'examples',
];

const checklist = DIM_IDS.map((dim_id) => {
  if (outcome === 'fail') {
    return {
      dim_id,
      level: '不健康',
      findings: [{ level: '错误', subtype: 'fixture', evidence: 'fixture marker', description: 'fixture-injected failure' }],
      suggestions: ['fixture: address the injected failure'],
    };
  }
  return { dim_id, level: '健康', findings: [], suggestions: [] };
});

const summary = {
  overall_health: outcome === 'fail' ? '严重缺陷' : '良好',
  top_suggestions: outcome === 'fail' ? ['fixture: fix the injected issues'] : [],
};

const reportJson = JSON.stringify({
  skill_name: 'fixture-skill',
  checklist,
  summary,
  feature_points: [],
});

process.stdout.write(JSON.stringify({
  output: reportJson,
  durationApiMs: 1,
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUSD: 0,
  stopReason: 'end',
  numTurns: 1,
}));
