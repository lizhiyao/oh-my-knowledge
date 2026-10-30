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
  // Source3 host composition stays in application; adapters never instantiate its use cases.
  // Migration alone decodes historical Source2. Normal extraction resolves current Source3.
  // Exact four-domain topology remains audited per edge, with no directory-level exemptions.
  'knowledge/adapters/entity-link-api-producer.ts → knowledge/entity-linking/entity-link-hash.ts',
  'knowledge/adapters/entity-link-executor.ts → knowledge/entity-linking/entity-link-hash.ts',
  'knowledge/adapters/entity-link-executor.ts → knowledge/entity-linking/entity-link-prompt.ts',
  'knowledge/adapters/entity-link-store.ts → knowledge/entity-linking/entity-link-hash.ts',
  'knowledge/adapters/executor.ts → knowledge/extraction/generation.ts',
  'knowledge/adapters/executor.ts → knowledge/extraction/model-wire.ts',
  'knowledge/adapters/generation-executor.ts → knowledge/extraction/native-outcome.ts',
  'knowledge/adapters/generation-journal-store.ts → knowledge/extraction/body-generation-wire.ts',
  'knowledge/adapters/generation-journal-store.ts → knowledge/extraction/generation-journal.ts',
  'knowledge/adapters/generation-journal-store.ts → knowledge/extraction/native-outcome.ts',
  'knowledge/adapters/run-store.ts → knowledge/extraction/generation-policy.ts',
  'knowledge/adapters/run-store.ts → knowledge/extraction/model-wire.ts',
  'knowledge/adapters/run-store.ts → knowledge/extraction/run-sealing.ts',
  'knowledge/adapters/run-store.ts → knowledge/extraction/runs.ts',
  'knowledge/adapters/source-migration.ts → knowledge/extraction/evidence.ts',
  'knowledge/adapters/study-files.ts → knowledge/extraction/study-corpus.ts',
  'knowledge/adapters/study-files.ts → knowledge/extraction/study-plan.ts',
  'knowledge/adapters/study-inspection-input.ts → knowledge/extraction/study-capacity.ts',
  'knowledge/adapters/trace-evidence.ts → knowledge/extraction/evidence.ts',
  'knowledge/application/application.ts → knowledge/adapters/body-digest.ts',
  'knowledge/application/application.ts → knowledge/extraction/entities.ts',
  'knowledge/application/auto-extraction.ts → knowledge/adapters/durable-publication.ts',
  'knowledge/application/auto-extraction.ts → knowledge/adapters/generation-journal-store.ts',
  'knowledge/application/auto-extraction.ts → knowledge/adapters/source-store.ts',
  'knowledge/application/auto-extraction.ts → knowledge/adapters/source-workspace.ts',
  'knowledge/application/auto-extraction.ts → knowledge/adapters/trace-source-reader.ts',
  'knowledge/application/auto-extraction.ts → knowledge/extraction/body-generation-wire.ts',
  'knowledge/application/auto-extraction.ts → knowledge/extraction/conversation-source.ts',
  'knowledge/application/auto-extraction.ts → knowledge/extraction/native-outcome.ts',
  'knowledge/application/body-generation.ts → knowledge/adapters/body-digest.ts',
  'knowledge/application/body-generation.ts → knowledge/adapters/generation-journal-store.ts',
  'knowledge/application/body-generation.ts → knowledge/extraction/association-catalog.ts',
  'knowledge/application/body-generation.ts → knowledge/extraction/body-generation-wire.ts',
  'knowledge/application/body-generation.ts → knowledge/extraction/native-outcome.ts',
  'knowledge/application/body-generation.ts → knowledge/extraction/source-input.ts',
  'knowledge/application/library.ts → knowledge/entity-linking/entity-link-source.ts',
  'knowledge/application/local-source-host.ts → knowledge/adapters/project-source-reader.ts',
  'knowledge/application/local-source-host.ts → knowledge/adapters/source-store.ts',
  'knowledge/application/local-source-host.ts → knowledge/adapters/trace-source-reader.ts',
  'knowledge/application/local-source-updates.ts → knowledge/adapters/association-store.ts',
  'knowledge/application/local-source-updates.ts → knowledge/adapters/body-digest.ts',
  'knowledge/application/local-source-updates.ts → knowledge/adapters/entity-store.ts',
  'knowledge/application/local-source-updates.ts → knowledge/adapters/knowledge-store.ts',
  'knowledge/application/local-source-updates.ts → knowledge/adapters/project-source-reader.ts',
  'knowledge/application/local-source-updates.ts → knowledge/adapters/source-store.ts',
  'knowledge/application/local-source-updates.ts → knowledge/adapters/trace-source-reader.ts',
  'knowledge/application/local.ts → knowledge/adapters/association-store.ts',
  'knowledge/application/local.ts → knowledge/adapters/entity-link-api-producer.ts',
  'knowledge/application/local.ts → knowledge/adapters/entity-link-store.ts',
  'knowledge/application/local.ts → knowledge/adapters/entity-store.ts',
  'knowledge/application/local.ts → knowledge/adapters/generation-journal-store.ts',
  'knowledge/application/local.ts → knowledge/adapters/knowledge-store.ts',
  'knowledge/application/local.ts → knowledge/adapters/knowledge-tags.ts',
  'knowledge/application/local.ts → knowledge/adapters/library-store.ts',
  'knowledge/application/local.ts → knowledge/adapters/review-store.ts',
  'knowledge/application/local.ts → knowledge/adapters/source-store.ts',
  'knowledge/application/local.ts → knowledge/adapters/source-workspace.ts',
  'knowledge/application/local.ts → knowledge/entity-linking/entity-link-hash.ts',
  'knowledge/application/local.ts → knowledge/entity-linking/entity-links.ts',
  'knowledge/application/operations.ts → knowledge/adapters/source-store.ts',
  'knowledge/application/read-context.ts → knowledge/adapters/body-digest.ts',
  'knowledge/application/study-inspection-service.ts → knowledge/adapters/study-inspection-errors.ts',
  'knowledge/application/study-inspection-worker.ts → knowledge/adapters/study-inspection-errors.ts',
  'knowledge/application/study-inspection-worker.ts → knowledge/adapters/study-inspection-input.ts',
  'knowledge/application/study-inspection.ts → knowledge/adapters/study-host.ts',
  'knowledge/application/study-inspection.ts → knowledge/adapters/study-inspection-errors.ts',
  'knowledge/application/study-inspection.ts → knowledge/extraction/study-analysis.ts',
  'knowledge/application/study-inspection.ts → knowledge/extraction/study-capacity.ts',
  'knowledge/application/study-inspection.ts → knowledge/extraction/study-corpus.ts',
  'knowledge/application/study-inspection.ts → knowledge/extraction/study-plan.ts',
  'knowledge/application/study-inspection.ts → knowledge/extraction/study-review.ts',
  'knowledge/application/study-local.ts → knowledge/adapters/executor.ts',
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
  'knowledge/application/study-runner.ts → knowledge/extraction/occurrence-guided-prompt.ts',
  'knowledge/application/study-runner.ts → knowledge/extraction/runs.ts',
  'knowledge/application/study-runner.ts → knowledge/extraction/study-corpus.ts',
  'knowledge/application/study-runner.ts → knowledge/extraction/study-plan.ts',
  'knowledge/application/study-runner.ts → knowledge/extraction/window-proposals.ts',
  'knowledge/entity-linking/entity-links.ts → knowledge/adapters/entity-link-api-producer.ts',
  'knowledge/entity-linking/entity-links.ts → knowledge/adapters/entity-link-executor.ts',
  'knowledge/entity-linking/entity-links.ts → knowledge/application/library.ts',
  'knowledge/extraction/conversation-source.ts → knowledge/adapters/trace-source-reader.ts',
] as const;

const KNOWLEDGE_AGGREGATE_TYPE_EDGES = [
  'knowledge/adapters/generation-executor.ts → knowledge/extraction/body-generation-wire.ts',
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
    rationale: '正文生成应用装配独立 journal/custody 适配器；local 与来源组合根装配 Source3 读取、捕获、变化清单和独立复核账本；适配器不反向调用应用用例，迁移适配器仅显式消费历史 Source2 decoder；适配器仅消费纯 profile 类型、journal schema 与原始 outcome 校验/序列化叶子，不反向调用生成用例。保留冻结 typed 测量的只读 inspect/replay 与独立实体测量，退役旧默认多阶段生成宿主。完整四域 SCC 及逐边登记保持精确；Trace 仍仅由适配器消费，不引入观测装配反向边。',
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
    sourceSha256: 'dfc47c5956f6598179a059eda75a83c76b1adb4ad1e2ab8a5bcfe34d92012146',
    rationale: '研究入口只加载固定构建组合根；语料和证据不能选择代码。当前宿主仅支持 prepare/report，旧 typed run 在配置执行器或占槽前明确拒绝。',
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
    sourceSha256: 'c4ae2e414475a1fa8f21205ae9b5be13802e3ce95397d5e6164decc84f0d6d05',
    rationale: 'Documentation generation loads only fixed compiled current body, Source3 and independent review contract modules to derive identities and limits. All file arguments are source literals inside this loader; documentation content cannot choose executable code, and generation makes no model calls.',
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

