import type { WindowExtractionModel } from '../../../src/knowledge/extraction/window-proposals.js';

// Literal public excerpts from issues10578/11555/8564; the packet below is authored test data,
// not a model response, human judgment, reproduction or rerun of a closed study.
// Speaker aliases are issue-local and do not establish identity across issues.
export const technicalDiscussionSources = [
  {
    "sourceUrl": "https://github.com/vuejs/core/issues/10578",
    "speaker": "participant-1",
    "text": "### Steps to reproduce\n\n组件v-model的trim修饰符和自定义修饰符 capitalize 在初始化的时候没有生效，只有绑定的值发生变化的时候才生效。\n\n### What is expected?\n\nv-model的修饰符在初始化的时候也要生效\n\n### What is actually happening?\n\n初始化的时候修饰符没有生效，只有绑定的值发生变化时才生效。\n\n"
  },
  {
    "sourceUrl": "https://github.com/vuejs/core/issues/10578#issuecomment-2016723944",
    "speaker": "participant-1",
    "text": "首先新增get函数，只会更改子组件中的值，父组件中的值仍然是在 v-model 绑定的值发生变化后才会生效。\r\n其次，如果要增加get才能达到目的，那自带的修饰符怎么办？比如：我在v-model用了自带的  .trim   .number。初始化的时候这两个自带的修饰符也不生效"
  },
  {
    "sourceUrl": "https://github.com/vuejs/core/issues/10578#issuecomment-2016748863",
    "speaker": "participant-2",
    "text": "有道理，或许可以新增一个`immediate`的option参数"
  },
  {
    "sourceUrl": "https://github.com/vuejs/core/issues/10578#issuecomment-2016751300",
    "speaker": "participant-1",
    "text": "immediate  这个参数是watch里面的吧。v-model 的参数类型是 PropOptions。PropOptions里面没有  immediate 这个配置项吧。"
  },
  {
    "sourceUrl": "https://github.com/vuejs/core/issues/11555",
    "speaker": "participant-1",
    "text": "> 这里的 `bindings` 和 `oldBindings` 两个数组的长度不一致导致的，数组取值错误。\r\n> 建议  `bindings` 和 `oldBindings` 使用Map类型，key是指令函数对象，value是指令配置对象(包含参数、修饰符等)，这样既能保证指令的顺序，又能动态设置指令(动态配置指令在开发低代码平台场景下极为有用！)\n\n"
  },
  {
    "sourceUrl": "https://github.com/vuejs/core/issues/11555#issuecomment-2275328991",
    "speaker": "participant-3",
    "text": "`withDirectives` is a compiler-only private API. There are no expectations of its behavior as a public API.\r\n\r\nIf you are using render functions, just use CSS to control the `display` instead of relying on `vShow`.\r\n\r\nThis is not going to be supported."
  },
  {
    "sourceUrl": "https://github.com/vuejs/core/issues/8564",
    "speaker": "participant-1",
    "text": "在src/services中有一个GetLogModel.ts文件，其中定义了GetLogModel类，其继承于GetPaginationModel，当在HelloWorld.vue进行new GetLogModel时，打印的结果只有pageIndex和pageSize有值，其他属性都为undefined，无论是否赋值。\r\n但是，如果把GetLogModel.ts中的类型全部复制到HelloWorld.vue中，再进行new GetLogModel()，就会正常的将其属性赋上值。\r\n此外，如果抛开Vue，只运行ts代码时，也会正常赋值。\n\n### What is expected?\n\n在new GetLogModel时，根据传入的值，进行子类属性赋值\n\n### What is actually happening?\n\n在new GetLogModel时  只对父类的属性进行了赋值。"
  },
  {
    "sourceUrl": "https://github.com/vuejs/core/issues/8564",
    "speaker": "participant-1",
    "text": "首先感谢您的回复，我也在Vue playground试过，结果确实如此。\r\n但是在vsCode中运行后，打开浏览器的console却是以下结果"
  },
  {
    "sourceUrl": "https://github.com/vuejs/core/issues/8564",
    "speaker": "participant-2",
    "text": "I have a try, your tsconfig.json is have set the `useDefineForClassFields` `true`, so it has this behavior."
  }
];

/** Exercises existing fact organization; no new schema or inferred implementation state. */
export function authoredTechnicalDiscussion(excerpts: readonly { evidenceRef: string }[]): WindowExtractionModel {
  const statement = (statementId: string, subject: string, relation: string, source: number,
    polarity: 'positive' | 'negative' = 'positive', modality: 'descriptive' | 'normative' = 'descriptive') => ({
    statementId, subject: { entityId: subject }, relation, modality, polarity,
    context: { scenario: technicalDiscussionSources[source].speaker + ' 的来源说法；' + technicalDiscussionSources[source].sourceUrl,
      conditions: source < 4 ? ['该组件 v-model 初始化讨论'] : source < 6 ? ['该动态指令数组讨论'] : ['该继承类初始化讨论'], exceptions: [],
      unknowns: ['未独立验证来源主张、实现或发布状态。'],
      occurredDuring: { timeKind: 'unknown' as const, reason: '来源没有事实发生时间。' },
      validDuring: { timeKind: 'unknown' as const, reason: '适用期限未知。' } },
  });
  const environmentFollowup = statement('environment-followup', 'model-init', '报告者在 vsCode 运行后查看浏览器 console，并继续报告环境条件', 7);
  environmentFollowup.context.conditions = ['报告者称也在 Vue playground 试过，回复为“结果确实如此”'];
  environmentFollowup.context.unknowns = ['具体 console 结果未包含在选段中，不能确定该环境下的属性值或与其他条件相同／不同。'];
  const groups = [
    { id: 'model', label: 'v-model', source: 0, title: '初始化报告、请求与方案异议', rows: [
      { source: 0, statement: statement('initial', 'model', '初始化时应用 trim 和自定义 capitalize 修饰符', 0, 'negative') },
      { source: 0, statement: statement('change', 'model', '修饰符只有绑定值变化后才生效', 0) },
      { source: 0, statement: statement('expected', 'model', '修饰符在初始化时生效', 0, 'positive', 'normative') },
      { source: 1, statement: statement('builtin-objection', 'model', '内置 .trim 和 .number 在初始化时生效', 1, 'negative') },
      { source: 2, statement: statement('tentative', 'model', '被参与者试探性建议新增 immediate option', 2) },
      { source: 3, statement: statement('ownership-objection', 'model', 'immediate 被参与者质疑为 watch 的参数而非 PropOptions 中的配置', 3) },
    ] },
    { id: 'directives', label: 'withDirectives', source: 5, title: '动态指令提案与否定支持边界', rows: [
      { source: 4, statement: statement('map-proposal', 'directives', '被参与者建议将 bindings 和 oldBindings 改为以指令函数为 key、配置为 value 的 Map', 4) },
      { source: 5, statement: statement('negative-support', 'directives', '支持所请求的动态指令行为', 5, 'negative') },
    ] },
    { id: 'model-init', label: 'GetLogModel', source: 6, title: '继承类初始化的环境与位置对照、续议及配置解释', rows: [
      { source: 6, statement: statement('initialization-problem', 'model-init', '在 HelloWorld.vue 中实例化时仅 pageIndex 和 pageSize 有值，其余属性均为 undefined', 6) },
      { source: 6, statement: statement('same-file', 'model-init', '把类型全部复制到 HelloWorld.vue 后实例化可正常赋值', 6) },
      { source: 6, statement: statement('plain-ts', 'model-init', '抛开 Vue、只运行 ts 代码时可正常赋值', 6) },
      { source: 7, statement: environmentFollowup },
      { source: 8, statement: statement('configuration-explanation', 'model-init', '被另一参与者归因于 tsconfig.json 的 useDefineForClassFields 为 true', 8) },
    ] },
  ];
  return { responseKind: 'knowledge-extraction', schemaVersion: 4,
    entities: groups.map(g => ({ entityId: g.id, label: g.label, description: '此公开讨论所谈接口', qualifiers: [],
      identityStatus: 'proposed', possibleEntityIds: [], uncertainties: [], referentKind: 'object', componentRef: null, collection: null })),
    mentions: groups.map(g => ({ mentionId: 'm-' + g.id, entityId: g.id, selection: { evidenceRef: excerpts[g.source].evidenceRef, quote: g.label, occurrence: 0 },
      basis: 'explicit', rationale: '原文所谈接口名称，不是已经核实的技术结论。' })),
    proposals: groups.map(g => ({ proposalId: 'p-' + g.id, entityIds: [g.id], mentionIds: ['m-' + g.id],
      draft: { title: g.title, content: { statements: g.rows.map(r => r.statement), organization: { knowledgeKind: 'fact' } },
        evidence: g.rows.map(r => ({ evidenceLinkId: 'l-' + r.statement.statementId, evidenceRef: excerpts[r.source].evidenceRef,
          statementIds: [r.statement.statementId], relation: 'supports', basis: 'source_assertion', interpretation: '保存来源主张及语气，不认证实现。' })) },
      citations: g.rows.map(r => ({ evidenceLinkId: 'l-' + r.statement.statementId, selection: { evidenceRef: excerpts[r.source].evidenceRef,
        quote: technicalDiscussionSources[r.source].text, occurrence: 0 } })),
      reuseRationale: '评估相似初始化或动态配置方案时核对问题、异议与支持范围。', identityUncertainties: [] })),
  };
}
