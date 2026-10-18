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
    importer: 'scripts/bench/entity-capture-provider.ts',
    expression: "pathToFileURL(resolve(repository, 'dist/cli/runtime/entity-capture.js')).href",
    sourceSha256: '0b0de123cdb7c62d050c29f0aff87bc47e4d23949d6c456c89e78c5b33972b28',
    rationale: 'Loads only the fixed built capture composition root; capture input cannot select code, and sending requires explicit plan permission and a verified budget profile.',
  },
  {
    importer: 'scripts/bench/entity-extraction-review.ts',
    expression: "pathToFileURL(resolve(repo, 'dist/observability/knowledge-extraction/extraction/prompt.js')).href",
    sourceSha256: 'b9a3a71565c0244072fc82396f4012b7e4c4662cb4328e32c0b38d6e02293367',
    rationale: 'Offline v14 inspection reads only the fixed built prompt for measurement identity; the sealed command has no executor entry.',
  },
  {
    importer: 'scripts/bench/entity-extraction-review.ts',
    expression: "pathToFileURL(resolve(repo, 'dist/observability/knowledge-extraction/extraction/window-proposals.js')).href",
    sourceSha256: 'b9a3a71565c0244072fc82396f4012b7e4c4662cb4328e32c0b38d6e02293367',
    rationale: 'Offline v14 inspection loads only the fixed production admission validator; capture data cannot select imported code.',
  },
  {
    importer: 'scripts/bench/assets/entity-extraction-five-positive-strict-v3/verify.mjs',
    expression: "pathToFileURL(resolve(repository, 'dist/observability/knowledge-extraction/extraction/strict-prompt.js')).href",
    sourceSha256: '94fac425697d6f9f95d316ed9a6fffe4dd29dff81ddc603463addaeafaf40bc8',
    rationale: 'Offline bundle verification reads only the fixed built production prompt identity; bundle data cannot select imported code.',
  },
  {
    importer: 'scripts/bench/assets/entity-extraction-five-positive-strict-v3/verify.mjs',
    expression: "pathToFileURL(resolve(repository, 'dist/observability/knowledge-extraction/extraction/strict-fewshot.js')).href",
    sourceSha256: '94fac425697d6f9f95d316ed9a6fffe4dd29dff81ddc603463addaeafaf40bc8',
    rationale: 'Offline bundle verification reads only the fixed built few-shot block for production equality; bundle data cannot select imported code.',
  },
  {
    importer: 'scripts/bench/assets/entity-extraction-five-positive-strict-v4/verify.mjs',
    expression: "pathToFileURL(resolve(repository, 'dist/observability/knowledge-extraction/extraction/strict-prompt.js')).href",
    sourceSha256: '8bc3bb13c26e0937a8dc002a26debbbb2ecb97b00aa7e49cfb4c8931b24837fd',
    rationale: 'Offline revision verification reads only the fixed built production prompt; it does not dispatch a model or register a collector arm.',
  },
  {
    importer: 'scripts/bench/assets/entity-extraction-five-positive-strict-v4/verify.mjs',
    expression: "pathToFileURL(resolve(repository, 'dist/observability/knowledge-extraction/extraction/strict-fewshot.js')).href",
    sourceSha256: '8bc3bb13c26e0937a8dc002a26debbbb2ecb97b00aa7e49cfb4c8931b24837fd',
    rationale: 'Offline revision verification compares the fixed production demonstrations with the frozen v3 revision and the source-grounding correction.',
  },
  {
    importer: 'scripts/bench/entity-link-review.ts',
    expression: "pathToFileURL(resolve(repository, 'dist', path)).href",
    sourceSha256: 'bb3f7d1c55e57f2205fdc79ecc6354586b6798bd710d640d5b640fa28e0d40d6',
    rationale: 'Offline link review loads only three fixed production modules; corpus and captures cannot choose code. Actual checker and matching installed production validator bytes enter the measurement identity; preparation has no executor entry.',
  },
  {
    importer: 'scripts/bench/entity-link-live.ts',
    expression: "pathToFileURL(resolve(repository, 'dist', path)).href",
    sourceSha256: '50c5f02fb6d7367c0e31084fc594a21a39bc22e1eed3bce6938bc71329718f31',
    rationale: 'Loads only fixed production request, outcome, executor and admission modules. A verified frozen measurement, exact plan confirmation and exclusive invocation reservation precede sending; input data cannot choose modules.',
  },
  {
    importer: 'executors/openai/codex/sdk.ts',
    expression: 'CODEX_SDK_PACKAGE',
    sourceSha256: '88a5ebb2fc9a572806afb9cd2f20c5369b58d684067e3c77a4df2c499ebfb839',
    rationale: 'Loads the fixed optional Codex SDK package; the source hash seals its binding.',
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
    sourceSha256: '2919557f97657ed5ea4f6f4f4103f56c1f398aed39188ebf409ad74873ef7a55',
    rationale: 'Loads only the built input-compilation registry to derive CLI documentation; the sealed source fixes the file URL.',
  },
  {
    importer: 'scripts/bench/studio-baseline.ts',
    expression: 'pathToFileURL(resolve(REPO_ROOT, path)).href',
    sourceSha256: 'e07ca97b9d8660440ba32ff80ef50bfd9d811d20f2a241949845624795ebb27f',
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

