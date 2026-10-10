/** 已审计例外的单一登记处；扩大边界时必须同步说明来源与防腐约束。 */
interface BoundaryEdge {
  importer: string;
  target: string;
  importerDomain: string;
  targetDomain: string;
  typeOnly: boolean;
}

const DIAGNOSIS_OBSERVABILITY_PRODUCER_TARGETS = new Set([
  'observability/experience.ts',
  'observability/inbox/index.ts',
  'observability/inbox/problem-patterns.ts',
  'observability/skill-health/advisories.ts',
  'observability/skill-health/skill-chain.ts',
]);
export const REGISTERED_RUNTIME_CYCLES = [
  {
    domains: ['diagnosis', 'observability'],
    edges: [
      'diagnosis/observe-producer.ts → observability/skill-health/advisories.ts',
      'observability/inbox/report-store.ts → diagnosis/contracts/parser.ts',
    ],
    rationale: 'Diagnosis produces Observability projections while Observability parses the stable Diagnosis wire contract.',
  },
] as const;

export const REGISTERED_NON_LITERAL_DYNAMIC_IMPORTS = [
  {
    importer: 'scripts/bench/entity-extraction-review.ts',
    expression: "pathToFileURL(resolve(repo, 'dist/observability/knowledge-extraction/prompt.js')).href",
    sourceSha256: '139f8cc28adb9bdb9df1a9283ebde2a3740f5b9a37b08a8254db11e68f0982b6',
    rationale: 'Offline v5 inspection reads only the fixed built prompt for measurement identity; the sealed command has no executor entry.',
  },
  {
    importer: 'scripts/bench/entity-extraction-review.ts',
    expression: "pathToFileURL(resolve(repo, 'dist/observability/knowledge-extraction/window-proposals.js')).href",
    sourceSha256: '139f8cc28adb9bdb9df1a9283ebde2a3740f5b9a37b08a8254db11e68f0982b6',
    rationale: 'Offline v5 inspection loads only the fixed production admission validator; capture data cannot select imported code.',
  },
  {
    importer: 'scripts/bench/knowledge-extraction-quality.ts',
    expression: "pathToFileURL(resolve(repo, 'dist/observability/knowledge-extraction/adapters/executor.js')).href",
    sourceSha256: '8f9167d73dee75779076ba1b7d5aabfe33a4b1190182fa1a0196c4565c2f3f24',
    rationale: 'Loads only the built text-only Codex executor for explicit quality runs; the sealed source fixes the path independently of user arguments.',
  },
  {
    importer: 'scripts/bench/knowledge-extraction-quality.ts',
    expression: "pathToFileURL(resolve(repo, 'dist/observability/knowledge-extraction/prompt.js')).href",
    sourceSha256: '8f9167d73dee75779076ba1b7d5aabfe33a4b1190182fa1a0196c4565c2f3f24',
    rationale: 'Loads only the built versioned extraction prompt for explicit quality runs; the sealed source fixes the path independently of user arguments.',
  },
  {
    importer: 'scripts/bench/knowledge-extraction-quality.ts',
    expression: "pathToFileURL(resolve(repo, 'dist/observability/knowledge-extraction/window-proposals.js')).href",
    sourceSha256: '8f9167d73dee75779076ba1b7d5aabfe33a4b1190182fa1a0196c4565c2f3f24',
    rationale: 'Loads only the built current window/proposal validator for explicit quality runs; the sealed source fixes the path independently of user arguments.',
  },
  {
    importer: 'scripts/bench/entity-extraction-quality.ts',
    expression: "pathToFileURL(resolve(repo, 'dist/observability/knowledge-extraction/adapters/executor.js')).href",
    sourceSha256: '96c6ff2f3ac528c5af052f7f4603842a4f9a2b2688284b162703cacfa119ab74',
    rationale: 'Loads only the built text extraction executor for the frozen synthetic entity corpus; the sealed source fixes the path, and model calls require explicit invocation.',
  },
  {
    importer: 'scripts/bench/entity-extraction-quality.ts',
    expression: "pathToFileURL(resolve(repo, 'dist/observability/knowledge-extraction/prompt.js')).href",
    sourceSha256: '96c6ff2f3ac528c5af052f7f4603842a4f9a2b2688284b162703cacfa119ab74',
    rationale: 'Loads only the built versioned prompt; arbitrary prompt files are data, never imported code.',
  },
  {
    importer: 'scripts/bench/entity-extraction-quality.ts',
    expression: "pathToFileURL(resolve(repo, 'dist/observability/knowledge-extraction/window-proposals.js')).href",
    sourceSha256: '96c6ff2f3ac528c5af052f7f4603842a4f9a2b2688284b162703cacfa119ab74',
    rationale: 'Loads only the built current window validator; the frozen gold standard stays outside model input.',
  },
  {
    importer: 'executors/anthropic/claude/sdk.ts',
    expression: 'CLAUDE_AGENT_SDK_PACKAGE',
    sourceSha256: 'c4d92bdfa7385281fba50233c15f365ba3a6020eab5a4609b829577c70214b4a',
    rationale: 'Loads the fixed optional Claude SDK package; the source hash seals its binding.',
  },
  {
    importer: 'executors/openai/codex/sdk.ts',
    expression: 'CODEX_SDK_PACKAGE',
    sourceSha256: 'd38e53693dda6414841f2d62d6f393c9e40d98608a420a35aff23839533f9921',
    rationale: 'Loads the fixed optional Codex SDK package; the source hash seals its binding.',
  },
  {
    importer: 'eval-workflows/hosts/adapters/claude/sdk-runtime.ts',
    expression: 'sdkModuleUrl.href',
    sourceSha256: '2080fb6a80757e18a01f53818937be83f898f29c590bed189c925af4676aa51d',
    rationale: 'Loads the resolved optional Claude SDK entrypoint with a per-runtime file URL.',
  },
  {
    importer: 'eval-workflows/hosts/adapters/codex/sdk-runtime.ts',
    expression: 'sdkModuleUrl.href',
    sourceSha256: 'c4589b05f9c2d518615a7faa35c50eb9b84f718e90cee9a562dc8a1895779bff',
    rationale: 'Loads the resolved optional Codex SDK entrypoint with a per-runtime file URL.',
  },
  {
    importer: 'scripts/build/docs.ts',
    expression: 'registryModuleUrl',
    sourceSha256: 'a6cfe4d9c56f611e5fec8afed4702f1317d51f2f0ef2cb7d8e2a1c170ffaaad8',
    rationale: 'Loads only the built input-compilation registry to derive CLI documentation; the sealed source fixes the file URL.',
  },
  {
    importer: 'scripts/bench/studio-baseline.ts',
    expression: 'pathToFileURL(resolve(REPO_ROOT, path)).href',
    sourceSha256: 'c46f743c64c55eede15075cc33eb0025f7e9ac1c8dc5cdbfc7073a95dce22b28',
    rationale: 'Loads only three fixed built modules for the isolated Studio benchmark; the sealed source fixes all callers and paths.',
  },
] as const;

export const MUTUAL_BOUNDARY_VALIDATORS: Record<string, (edge: BoundaryEdge) => boolean> = {
  'evidence/graph↔knowledge-artifacts/doctor': (edge) => {
    // Doctor owns report persistence; the graph producer consumes only its wire types.
    // This is not a runtime back-edge, and no other doctor/graph imports are admitted.
    if (edge.importerDomain === 'knowledge-artifacts/doctor') {
      return edge.importer === 'knowledge-artifacts/doctor/persistence.ts'
        && edge.target === 'evidence/graph/doctor.ts';
    }
    return edge.importer === 'evidence/graph/doctor.ts'
      && edge.typeOnly
      && edge.target === 'knowledge-artifacts/doctor/contracts.ts';
  },
  'evidence/storage↔knowledge-artifacts/doctor': (edge) => {
    if (edge.importerDomain === 'knowledge-artifacts/doctor') {
      return edge.targetDomain === 'evidence/storage';
    }
    return edge.importer === 'evidence/storage/discovery-index.ts'
      && edge.typeOnly
      && edge.target === 'knowledge-artifacts/doctor/contracts.ts';
  },
  'diagnosis↔observability': (edge) => {
    if (edge.importerDomain === 'observability') {
      return edge.target.startsWith('diagnosis/contracts');
    }
    return edge.importer === 'diagnosis/observe-producer.ts'
      && DIAGNOSIS_OBSERVABILITY_PRODUCER_TARGETS.has(edge.target);
  },
};

