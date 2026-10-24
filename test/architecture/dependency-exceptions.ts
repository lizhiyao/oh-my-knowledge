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
// #1299 移除观测入口对知识用例的聚合后，仅登记知识内部的四域 SCC。
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
  // #1321：共享输入的 study/v1 只读取固定任务身份以拒绝 v37，不派发不同输入。
  'knowledge/application/study-runner.ts → knowledge/extraction/occurrence-guided-prompt.ts',
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
  // #1321：显式研究任务只消费输入／原生证据校验与 prompt／wire 身份，不扩展允许领域或反向依赖。
  'knowledge/application/application.ts → knowledge/extraction/bound-knowledge-evidence.ts',
  'knowledge/application/application.ts → knowledge/extraction/entity-review-evidence.ts',
  'knowledge/application/application.ts → knowledge/extraction/reviewed-knowledge-evidence.ts',
  'knowledge/application/application.ts → knowledge/extraction/coverage-review-input.ts',
  'knowledge/application/application.ts → knowledge/extraction/entities.ts',
  'knowledge/application/application.ts → knowledge/extraction/entity-only-task.ts',
  'knowledge/application/application.ts → knowledge/extraction/generation-policy.ts',
  'knowledge/application/application.ts → knowledge/extraction/generation.ts',
  'knowledge/application/application.ts → knowledge/extraction/model-input.ts',
  'knowledge/application/application.ts → knowledge/extraction/model-wire.ts',
  'knowledge/application/application.ts → knowledge/extraction/quality.ts',
  'knowledge/application/application.ts → knowledge/extraction/runs.ts',
  'knowledge/application/application.ts → knowledge/extraction/source-plan-evidence.ts',
  'knowledge/application/application.ts → knowledge/extraction/source-plan-input.ts',
  'knowledge/application/application.ts → knowledge/extraction/strict-prompt.ts',
  'knowledge/application/application.ts → knowledge/extraction/window-proposals.ts',
  'knowledge/application/auto-extraction.ts → knowledge/adapters/executor.ts',
  'knowledge/application/auto-extraction.ts → knowledge/adapters/run-store.ts',
  'knowledge/application/auto-extraction.ts → knowledge/extraction/conversation-source.ts',
  'knowledge/application/auto-extraction.ts → knowledge/extraction/generation-policy.ts',
  'knowledge/application/auto-extraction.ts → knowledge/extraction/generation.ts',
  'knowledge/application/auto-extraction.ts → knowledge/extraction/model-input.ts',
  'knowledge/application/auto-extraction.ts → knowledge/extraction/runs.ts',
  'knowledge/application/citation-locators.ts → knowledge/extraction/quote-occurrence.ts',
  // A/B 独立原件只读认证与现有实体写入，不改变普通单 E run 或反向依赖。
  'knowledge/application/discovered-entities.ts → knowledge/extraction/bound-catalog.ts',
  'knowledge/application/discovered-entities.ts → knowledge/extraction/discovered-entities-evidence.ts',
  // 清单→A→B 只重放固定来源清单原件，未决处置在 B 读取前阻断，不执行模型或扩大反向依赖。
  'knowledge/application/discovered-entities.ts → knowledge/extraction/source-plan-evidence.ts',
  // 一轮目录修订仅消费五份原件的纯认证与最终接纳，不创建执行器或反向依赖。
  'knowledge/application/refined-entities.ts → knowledge/extraction/bound-catalog.ts',
  'knowledge/application/refined-entities.ts → knowledge/extraction/refined-entities-evidence.ts',
  // E-first 只重放已归档的原文 E 任务并对应真实初始修订，不经 extraction 反向调用应用或存储。
  'knowledge/application/entity-first-knowledge.ts → knowledge/extraction/generation-policy.ts',
  'knowledge/application/entity-first-knowledge.ts → knowledge/extraction/generation.ts',
  'knowledge/application/entity-first-knowledge.ts → knowledge/extraction/model-input.ts',
  'knowledge/application/entity-first-knowledge.ts → knowledge/extraction/model-wire.ts',
  'knowledge/application/entity-first-knowledge.ts → knowledge/extraction/window-proposals.ts',
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
] as const;

const KNOWLEDGE_AGGREGATE_TYPE_EDGES = [
  'knowledge/adapters/study-host.ts → knowledge/extraction/study-plan.ts',
  'knowledge/application/study-runner.ts → knowledge/extraction/study-plan.ts',
  'knowledge/adapters/executor.ts → knowledge/extraction/generation.ts',
  'knowledge/adapters/executor.ts → knowledge/extraction/runs.ts',
  'knowledge/entity-linking/entity-link-source.ts → knowledge/application/application.ts',
  'knowledge/entity-linking/entity-links.ts → knowledge/application/application.ts',
] as const;

function isRegisteredKnowledgeBoundary(edge: BoundaryEdge): boolean {
  const registered: readonly string[] = edge.typeOnly
    ? KNOWLEDGE_AGGREGATE_TYPE_EDGES : KNOWLEDGE_AGGREGATE_RUNTIME_EDGES;
  return registered.includes(`${edge.importer} → ${edge.target}`);
}

export const REGISTERED_RUNTIME_CYCLES = [
  {
    domains: ['diagnosis', 'observability'],
    edges: [
      'diagnosis/observe-producer.ts → observability/skill-health/advisories.ts',
      'observability/inbox/report-store.ts → diagnosis/contracts/parser.ts',
    ],
    rationale: 'Diagnosis producer 消费观测建议，观测只消费 Diagnosis wire parser；知识用例不再经过观测入口。',
  },
  {
    domains: ['knowledge/adapters', 'knowledge/application', 'knowledge/entity-linking', 'knowledge/extraction'],
    edges: KNOWLEDGE_AGGREGATE_RUNTIME_EDGES,
    rationale: '保留知识内部既有的生产生成、关联与纯证据校验边界；实体专项任务仅消费固定 prompt 身份和纯接纳校验，不引入新宿主或跨域反向边。Trace 仍由知识适配器单向消费，不再形成经过观测装配入口的反向边。',
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
  'knowledge/application↔knowledge/entity-linking': isRegisteredKnowledgeBoundary,
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

