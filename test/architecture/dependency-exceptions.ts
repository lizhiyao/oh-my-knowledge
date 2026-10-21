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
// #1285 只移动既有依赖：按新子域观察后，原 Observability 聚合环显露为六域 SCC。
// 完整 runtime 边只有这一份登记，同时供 SCC 拓扑与双向边界校验复用；不得扩大为目录级豁免。
const KNOWLEDGE_AGGREGATE_RUNTIME_EDGES = [
  // #1304: fixed workers preserve the existing synchronous checker; only delivery scheduling changes.
  'knowledge/application/study-inspection.ts → knowledge/adapters/study-inspection-errors.ts',
  'knowledge/application/study-inspection-service.ts → knowledge/adapters/study-inspection-errors.ts',
  'knowledge/application/study-inspection-worker.ts → knowledge/adapters/study-inspection-errors.ts',
  'knowledge/application/study-inspection-worker.ts → knowledge/adapters/study-inspection-input.ts',
  'knowledge/adapters/study-inspection-input.ts → knowledge/extraction/study-capacity.ts',
  'knowledge/application/study-inspection.ts → knowledge/adapters/study-host.ts',
  'knowledge/application/study-inspection.ts → knowledge/extraction/study-plan.ts',
  'knowledge/application/study-inspection.ts → knowledge/extraction/study-corpus.ts',
  'knowledge/application/study-inspection.ts → knowledge/extraction/study-analysis.ts',
  'knowledge/application/study-inspection.ts → knowledge/extraction/study-review.ts',
  'knowledge/application/study-inspection.ts → knowledge/extraction/study-capacity.ts',

  // #1290：研究适配器与应用复用生产生成和冻结证据，未开放适配器反向依赖应用。
  'knowledge/adapters/study-files.ts → knowledge/extraction/study-corpus.ts',
  'knowledge/adapters/study-files.ts → knowledge/extraction/study-plan.ts',
  'knowledge/application/study-local.ts → knowledge/adapters/entity-store.ts',
  'knowledge/application/study-local.ts → knowledge/adapters/executor.ts',
  'knowledge/application/study-local.ts → knowledge/adapters/knowledge-store.ts',
  'knowledge/application/study-local.ts → knowledge/adapters/knowledge-tags.ts',
  'knowledge/application/study-local.ts → knowledge/adapters/run-store.ts',
  'knowledge/application/study-local.ts → knowledge/adapters/study-files.ts',
  'knowledge/application/study-local.ts → knowledge/adapters/study-host.ts',
  'knowledge/application/study-local.ts → knowledge/adapters/trace-evidence.ts',
  'knowledge/application/study-local.ts → knowledge/extraction/generation-policy.ts',
  'knowledge/application/study-local.ts → knowledge/extraction/generation.ts',
  'knowledge/application/study-local.ts → knowledge/extraction/study-analysis.ts',
  'knowledge/application/study-local.ts → knowledge/extraction/study-corpus.ts',
  'knowledge/application/study-local.ts → knowledge/extraction/study-plan.ts',
  'knowledge/application/study-local.ts → knowledge/extraction/study-review.ts',
  'knowledge/application/study-runner.ts → knowledge/extraction/generation-policy.ts',
  'knowledge/application/study-runner.ts → knowledge/extraction/generation.ts',
  'knowledge/application/study-runner.ts → knowledge/extraction/model-input.ts',
  'knowledge/application/study-runner.ts → knowledge/extraction/model-wire.ts',
  'knowledge/application/study-runner.ts → knowledge/extraction/runs.ts',
  'knowledge/application/study-runner.ts → knowledge/extraction/study-corpus.ts',
  'knowledge/application/study-runner.ts → knowledge/extraction/study-plan.ts',
  'knowledge/application/study-runner.ts → knowledge/extraction/window-proposals.ts',

  'knowledge/adapters/entity-link-api-producer.ts → knowledge/entity-linking/entity-link-hash.ts',
  'knowledge/adapters/entity-link-executor.ts → knowledge/entity-linking/entity-link-hash.ts',
  'knowledge/adapters/entity-link-executor.ts → knowledge/entity-linking/entity-link-prompt.ts',
  'knowledge/adapters/entity-link-store.ts → knowledge/entity-linking/entity-link-hash.ts',
  'knowledge/adapters/executor.ts → knowledge/extraction/generation.ts',
  'knowledge/adapters/executor.ts → knowledge/extraction/model-wire.ts',
  'knowledge/adapters/run-store.ts → knowledge/extraction/generation-policy.ts',
  // #1304：仅比较当前 wire 身份及校验纯封存契约，不解码旧 wire，也不执行模型调用。
  'knowledge/adapters/run-store.ts → knowledge/extraction/model-wire.ts',
  'knowledge/adapters/run-store.ts → knowledge/extraction/run-sealing.ts',
  'knowledge/adapters/run-store.ts → knowledge/extraction/runs.ts',
  'knowledge/adapters/trace-evidence.ts → knowledge/extraction/evidence.ts',
  'knowledge/adapters/trace-evidence.ts → observability/trace/source.ts',
  'knowledge/application/application.ts → knowledge/extraction/entities.ts',
  'knowledge/application/application.ts → knowledge/extraction/generation-policy.ts',
  'knowledge/application/application.ts → knowledge/extraction/generation.ts',
  'knowledge/application/application.ts → knowledge/extraction/model-input.ts',
  'knowledge/application/application.ts → knowledge/extraction/quality.ts',
  'knowledge/application/application.ts → knowledge/extraction/runs.ts',
  'knowledge/application/application.ts → knowledge/extraction/window-proposals.ts',
  'knowledge/application/auto-extraction.ts → knowledge/adapters/executor.ts',
  'knowledge/application/auto-extraction.ts → knowledge/adapters/run-store.ts',
  'knowledge/application/auto-extraction.ts → knowledge/extraction/conversation-source.ts',
  'knowledge/application/auto-extraction.ts → knowledge/extraction/generation-policy.ts',
  'knowledge/application/auto-extraction.ts → knowledge/extraction/generation.ts',
  'knowledge/application/auto-extraction.ts → knowledge/extraction/model-input.ts',
  'knowledge/application/auto-extraction.ts → knowledge/extraction/runs.ts',
  'knowledge/application/citation-locators.ts → knowledge/extraction/quote-occurrence.ts',
  'knowledge/application/library.ts → knowledge/entity-linking/entity-link-source.ts',
  'knowledge/application/local.ts → knowledge/adapters/entity-link-api-producer.ts',
  'knowledge/application/local.ts → knowledge/adapters/entity-link-store.ts',
  'knowledge/application/local.ts → knowledge/adapters/entity-store.ts',
  'knowledge/application/local.ts → knowledge/adapters/knowledge-store.ts',
  'knowledge/application/local.ts → knowledge/adapters/knowledge-tags.ts',
  'knowledge/application/local.ts → knowledge/adapters/library-store.ts',
  'knowledge/application/local.ts → knowledge/adapters/run-store.ts',
  'knowledge/application/local.ts → knowledge/adapters/trace-evidence.ts',
  'knowledge/application/local.ts → knowledge/entity-linking/entity-link-hash.ts',
  'knowledge/application/local.ts → knowledge/entity-linking/entity-links.ts',
  'knowledge/application/operations.ts → knowledge/extraction/generation-policy.ts',
  'knowledge/extraction/conversation-source.ts → knowledge/adapters/trace-evidence.ts',
  'knowledge/entity-linking/entity-links.ts → knowledge/adapters/entity-link-api-producer.ts',
  'knowledge/entity-linking/entity-links.ts → knowledge/adapters/entity-link-executor.ts',
  'knowledge/entity-linking/entity-links.ts → knowledge/application/library.ts',
  'observability/application.ts → knowledge/adapters/executor.ts',
  'observability/application.ts → knowledge/adapters/trace-evidence.ts',
  'observability/application.ts → knowledge/application/auto-extraction.ts',
  'observability/application.ts → knowledge/application/library.ts',
  'observability/application.ts → knowledge/application/local.ts',
  'observability/application.ts → knowledge/application/operations.ts',
  'observability/application.ts → knowledge/extraction/conversation-source.ts',
  'observability/application.ts → knowledge/extraction/generation-policy.ts',
  'observability/application.ts → knowledge/extraction/runs.ts',
] as const;

const KNOWLEDGE_AGGREGATE_TYPE_EDGES = [
  'knowledge/adapters/study-host.ts → knowledge/extraction/study-plan.ts',
  'knowledge/application/study-runner.ts → knowledge/extraction/study-plan.ts',
  'knowledge/adapters/executor.ts → knowledge/extraction/generation.ts',
  'knowledge/adapters/executor.ts → knowledge/extraction/runs.ts',
  'knowledge/adapters/trace-evidence.ts → observability/trace/trace-ir.ts',
  'knowledge/application/auto-extraction.ts → observability/conversation/catalog.ts',
  'knowledge/extraction/conversation-source.ts → observability/conversation/catalog.ts',
  'knowledge/entity-linking/entity-link-source.ts → knowledge/application/application.ts',
  'knowledge/entity-linking/entity-links.ts → knowledge/application/application.ts',
  'observability/application.ts → knowledge/application/application.ts',
  'observability/application.ts → knowledge/application/auto-extraction.ts',
  'observability/application.ts → knowledge/application/library.ts',
  'observability/application.ts → knowledge/application/operations.ts',
  'observability/application.ts → knowledge/extraction/evidence.ts',
  'observability/application.ts → knowledge/extraction/generation-policy.ts',
  'observability/application.ts → knowledge/extraction/runs.ts',
] as const;

function isRegisteredKnowledgeBoundary(edge: BoundaryEdge): boolean {
  const registered: readonly string[] = edge.typeOnly
    ? KNOWLEDGE_AGGREGATE_TYPE_EDGES : KNOWLEDGE_AGGREGATE_RUNTIME_EDGES;
  return registered.includes(`${edge.importer} → ${edge.target}`);
}

export const REGISTERED_RUNTIME_CYCLES = [
  {
    domains: ['diagnosis', 'knowledge/adapters', 'knowledge/application', 'knowledge/entity-linking', 'knowledge/extraction', 'observability'],
    edges: [
      'diagnosis/observe-producer.ts → observability/skill-health/advisories.ts',
      ...KNOWLEDGE_AGGREGATE_RUNTIME_EDGES,
      'observability/inbox/report-store.ts → diagnosis/contracts/parser.ts',
    ],
    rationale: '迁移前 Observability 内的提取、关联、应用与适配器聚合关系原样保留；新知识子域消费 Trace，观测应用继续向交付层装配知识能力。Diagnosis 与 Observability 的 producer／wire contract 边界未变。',
  },
] as const;

export const REGISTERED_NON_LITERAL_DYNAMIC_IMPORTS = [
  {
    importer: 'scripts/bench/knowledge-study-panel.ts',
    expression: "pathToFileURL(resolve(repository, 'dist/cli/runtime/knowledge-study-panel.js')).href",
    sourceSha256: 'c2e54d4e0afd607f58613fa06af07d6fb41ed464b742073c67883e5164548d7e',
    rationale: '多人复核只加载固定构建的离线组合根，原始研究和回执不能选择代码；没有模型调用入口。',
  },
  {
    importer: 'scripts/bench/knowledge-study.ts',
    expression: "pathToFileURL(resolve(repository, 'dist/cli/runtime/knowledge-study.js')).href",
    sourceSha256: 'd9ea717f5db9c3fead48476c29a146d85044bdb52f3c22b456121bd97d525235',
    rationale: '研究入口只加载固定构建的生产组合根；语料和证据不能选择代码，执行还需精确计划授权。',
  },
  {
    importer: 'scripts/bench/entity-semantic-review.ts',
    expression: "pathToFileURL(resolve(repository, 'dist/knowledge/extraction/prompt.js')).href",
    sourceSha256: 'f7d024c120b88d810548b541df9a5da1ffd4eb37bdda81ce71847cad92577f03',
    rationale: 'Offline semantic inspection verifies the fixed built prompt identity; no bundle or capture can choose imported code.',
  },
  {
    importer: 'scripts/bench/entity-semantic-review.ts',
    expression: "pathToFileURL(resolve(repository, 'dist/knowledge/extraction/window-proposals.js')).href",
    sourceSha256: 'f7d024c120b88d810548b541df9a5da1ffd4eb37bdda81ce71847cad92577f03',
    rationale: 'Offline semantic inspection reuses the fixed production admission validator and has no model execution path.',
  },
  {
    importer: 'scripts/bench/entity-capture-provider.ts',
    expression: "pathToFileURL(resolve(repository, 'dist/cli/runtime/entity-capture.js')).href",
    sourceSha256: '4cede9fe33761c090fda04fbfd419002704853faabc4d3661add4e353217bd19',
    rationale: 'Loads only the fixed built capture composition root; capture input cannot select code, and sending requires explicit plan permission and a verified budget profile.',
  },
  {
    importer: 'scripts/bench/entity-extraction-review.ts',
    expression: "pathToFileURL(resolve(repo, 'dist/knowledge/extraction/prompt.js')).href",
    sourceSha256: '4eb58679b02c75e591b82bcf2a8cc70d2e7b3edaab12ae0fd3060031f0a78155',
    rationale: 'Offline entity inspection reads only the fixed built prompt for measurement identity; the sealed command has no executor entry.',
  },
  {
    importer: 'scripts/bench/entity-extraction-review.ts',
    expression: "pathToFileURL(resolve(repo, 'dist/knowledge/extraction/window-proposals.js')).href",
    sourceSha256: '4eb58679b02c75e591b82bcf2a8cc70d2e7b3edaab12ae0fd3060031f0a78155',
    rationale: 'Offline entity inspection loads only the fixed production admission validator; capture data cannot select imported code.',
  },
  {
    importer: 'scripts/bench/assets/entity-extraction-five-positive-strict-v3/verify.mjs',
    expression: "pathToFileURL(resolve(repository, 'dist/knowledge/extraction/strict-prompt.js')).href",
    sourceSha256: '08e275d09cf5157d9d8a60436cadb88706a66dd65708f72bc742f6fea3b29dca',
    rationale: 'Offline bundle verification reads only the fixed built production prompt identity; bundle data cannot select imported code.',
  },
  {
    importer: 'scripts/bench/assets/entity-extraction-five-positive-strict-v3/verify.mjs',
    expression: "pathToFileURL(resolve(repository, 'dist/knowledge/extraction/strict-fewshot.js')).href",
    sourceSha256: '08e275d09cf5157d9d8a60436cadb88706a66dd65708f72bc742f6fea3b29dca',
    rationale: 'Offline bundle verification reads only the fixed built few-shot block for production equality; bundle data cannot select imported code.',
  },
  {
    importer: 'scripts/bench/assets/entity-extraction-five-positive-strict-v4/verify.mjs',
    expression: "pathToFileURL(resolve(repository, 'dist/knowledge/extraction/strict-prompt.js')).href",
    sourceSha256: '6d3ba21df43b23461da69fab197bc2d4ae694c1f9aa9db76e32ddbbecdee9c4d',
    rationale: 'Offline revision verification reads only the fixed built production prompt; it does not dispatch a model or register a collector arm.',
  },
  {
    importer: 'scripts/bench/assets/entity-extraction-five-positive-strict-v4/verify.mjs',
    expression: "pathToFileURL(resolve(repository, 'dist/knowledge/extraction/strict-fewshot.js')).href",
    sourceSha256: '6d3ba21df43b23461da69fab197bc2d4ae694c1f9aa9db76e32ddbbecdee9c4d',
    rationale: 'Offline revision verification compares the fixed production demonstrations with the frozen v3 revision and the source-grounding correction.',
  },
  {
    importer: 'scripts/bench/entity-link-review.ts',
    expression: "pathToFileURL(resolve(repository, 'dist', path)).href",
    sourceSha256: '102c43bdc4b091e81e1aaad44b0b83904479a61f3993e805cccab02a57ada024',
    rationale: 'Offline link review loads only three fixed production modules; corpus and captures cannot choose code. Actual checker and matching installed production validator bytes enter the measurement identity; preparation has no executor entry.',
  },
  {
    importer: 'scripts/bench/entity-link-live.ts',
    expression: "pathToFileURL(resolve(repository, 'dist', path)).href",
    sourceSha256: 'c4408fd10626b4d07644169b0f3bebfd16aeb0dc1604a23cf35d4860acac850d',
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
    sourceSha256: '17b2f1b867dabb8bf97a3d5318ed3576c27cdd34746346f07c99e45f424684ea',
    rationale: 'Loads only the built input-compilation registry to derive CLI documentation; the sealed source fixes the file URL.',
  },
  {
    importer: 'scripts/build/knowledge-contract.ts',
    expression: "pathToFileURL(resolve(root, 'dist/knowledge', file)).href",
    sourceSha256: '8fcc021764390af3036d2eaecc2bbe31b9e4fec0a8df275adce5603bd6bd703f',
    rationale: 'Documentation generation loads only eleven fixed compiled knowledge modules to derive current identities and limits. All file arguments are source literals inside this loader; documentation content cannot choose executable code, and generation makes no model calls.',
  },
  {
    importer: 'scripts/bench/studio-baseline.ts',
    expression: 'pathToFileURL(resolve(REPO_ROOT, path)).href',
    sourceSha256: 'e07ca97b9d8660440ba32ff80ef50bfd9d811d20f2a241949845624795ebb27f',
    rationale: 'Loads only three fixed built modules for the isolated Studio benchmark; the sealed source fixes all callers and paths.',
  },
] as const;

export const MUTUAL_BOUNDARY_VALIDATORS: Record<string, (edge: BoundaryEdge) => boolean> = {
  'knowledge/adapters↔knowledge/extraction': isRegisteredKnowledgeBoundary,
  'knowledge/adapters↔knowledge/entity-linking': isRegisteredKnowledgeBoundary,
  'knowledge/adapters↔observability': isRegisteredKnowledgeBoundary,
  'knowledge/application↔knowledge/entity-linking': isRegisteredKnowledgeBoundary,
  'knowledge/application↔observability': isRegisteredKnowledgeBoundary,
  'knowledge/extraction↔observability': isRegisteredKnowledgeBoundary,
  'evidence/graph↔knowledge/artifacts/doctor': (edge) => {
    // Doctor owns report persistence; the graph producer consumes only its wire types.
    // This is not a runtime back-edge, and no other doctor/graph imports are admitted.
    if (edge.importerDomain === 'knowledge/artifacts/doctor') {
      return edge.importer === 'knowledge/artifacts/doctor/persistence.ts'
        && edge.target === 'evidence/graph/doctor.ts';
    }
    return edge.importer === 'evidence/graph/doctor.ts'
      && edge.typeOnly
      && edge.target === 'knowledge/artifacts/doctor/contracts.ts';
  },
  'evidence/storage↔knowledge/artifacts/doctor': (edge) => {
    if (edge.importerDomain === 'knowledge/artifacts/doctor') {
      return edge.targetDomain === 'evidence/storage';
    }
    return edge.importer === 'evidence/storage/discovery-index.ts'
      && edge.typeOnly
      && edge.target === 'knowledge/artifacts/doctor/contracts.ts';
  },
  'diagnosis↔observability': (edge) => {
    if (edge.importerDomain === 'observability') {
      return edge.target.startsWith('diagnosis/contracts');
    }
    return edge.importer === 'diagnosis/observe-producer.ts'
      && DIAGNOSIS_OBSERVABILITY_PRODUCER_TARGETS.has(edge.target);
  },
};

