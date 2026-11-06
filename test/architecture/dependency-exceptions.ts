/** 已审计例外的单一登记处；扩大边界时必须同步说明来源与防腐约束。 */
interface BoundaryEdge {
  importer: string;
  target: string;
  importerDomain: string;
  targetDomain: string;
  typeOnly: boolean;
}

const DIAGNOSIS_OBSERVE_PRODUCER_TARGETS = new Set([
  'observe/experience.ts',
  'observe/inbox/index.ts',
  'observe/inbox/problem-patterns.ts',
  'observe/skill-health/advisories.ts',
  'observe/skill-health/skill-chain.ts',
]);
export const REGISTERED_RUNTIME_CYCLES = [
  {
    domains: ['observe', 'observe/diagnosis'],
    edges: [
      'observe/application.ts → observe/diagnosis/lifecycle.ts',
      'observe/application.ts → observe/diagnosis/studio-projection.ts',
      'observe/diagnosis/observe-producer.ts → observe/skill-health/advisories.ts',
      'observe/inbox/report-store.ts → observe/diagnosis/contracts/parser.ts',
    ],
    rationale: '诊断是 Observe 子域，仍单独审计依赖：事实侧只消费诊断契约／parser，诊断 producer 消费观测事实，根应用入口向 Studio 提供诊断摘要与生命周期查询。',
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
    sourceSha256: '5d44ebefb9d9feed42e1309a563f28205b19495fc8336e3993884c5e8ffb58b5',
    rationale: 'Documentation generation loads only fixed compiled current body, Source3, independent review/relation contracts and the Graph3 version constant to derive identities and limits. All file arguments, including relations.js and application/graph.js, are source literals inside this loader; documentation content cannot choose executable code, and generation makes no model calls.',
  },
  {
    importer: 'scripts/bench/studio-baseline.ts',
    expression: 'pathToFileURL(resolve(REPO_ROOT, path)).href',
    sourceSha256: 'c3ba9f2b30bb387b36ecda2ddbd7cbd6b5d3733c49ba847b5057cc6a6fdb2e38',
    rationale: 'Loads only three fixed built modules for the isolated Studio benchmark; the sealed source fixes all callers and paths.',
  },
] as const;

export const MUTUAL_BOUNDARY_VALIDATORS: Record<string, (edge: BoundaryEdge) => boolean> = {
  'knowledge/artifacts/doctor↔storage': (edge) => {
    if (edge.importerDomain === 'knowledge/artifacts/doctor') {
      return edge.targetDomain === 'storage';
    }
    return edge.importer === 'storage/discovery-index.ts'
      && edge.typeOnly
      && edge.target === 'knowledge/artifacts/doctor/contracts.ts';
  },
  'observe↔observe/diagnosis': (edge) => {
    if (edge.importerDomain === 'observe') {
      return edge.target.startsWith('observe/diagnosis/contracts')
        || (edge.importer === 'observe/application.ts' && [
          'observe/diagnosis/lifecycle.ts',
          'observe/diagnosis/studio-projection.ts',
        ].includes(edge.target));
    }
    return edge.importer === 'observe/diagnosis/observe-producer.ts'
      && DIAGNOSIS_OBSERVE_PRODUCER_TARGETS.has(edge.target);
  },
};

