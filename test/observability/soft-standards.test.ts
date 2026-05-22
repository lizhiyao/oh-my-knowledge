import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  __softStandardsTestInternals,
  type RuntimeSignal,
  type RuntimeSignalType,
  type RuntimeStandardNode,
} from '../../src/observability/soft-standards.js';
import type { SkillRuntimeEvidencePack, SkillRuntimeEvidencePackRef, SkillRuntimeEvidencePackSourceType } from '../../src/observability/skill-chain.js';

const { evaluateRuntimeStandardNodes, normalizeRuntimeSignals, normalizeRuntimeTriggers, normalizeFuzzyText, normalizeToolNameValue } = __softStandardsTestInternals;

function ref(input: {
  id: string;
  sourceType: SkillRuntimeEvidencePackSourceType;
  snippet: string;
  kind?: string;
  toolName?: string;
  messageIndex?: number;
  sessionId?: string;
}): SkillRuntimeEvidencePackRef {
  return {
    id: input.id,
    kind: (input.kind ?? 'assistant_message') as SkillRuntimeEvidencePackRef['kind'],
    sourceTrace: 'trace.jsonl',
    sessionId: input.sessionId ?? 's1',
    snippet: input.snippet,
    label: input.snippet,
    sourceType: input.sourceType,
    toolName: input.toolName,
    messageIndex: input.messageIndex,
    logicalMessageIndex: input.messageIndex,
  };
}

function pack(refs: SkillRuntimeEvidencePackRef[], nodeEvidence: SkillRuntimeEvidencePack['nodeEvidence'] = []): SkillRuntimeEvidencePack {
  return {
    schemaVersion: 1,
    skillName: 'test-skill',
    generatedBy: 'deterministic_rule_pack',
    definition: { found: true },
    declaredStandards: { hardRules: [], workflowNodes: [] },
    runtimeEvidence: {
      toolCalls: refs.filter((item) => item.sourceType === 'tool_call' || item.sourceType === 'tool_result'),
      assistantMessages: refs.filter((item) => item.sourceType === 'assistant_message'),
      userFeedback: refs.filter((item) => item.sourceType === 'user_feedback'),
      artifacts: refs.filter((item) => item.sourceType === 'artifact'),
    },
    nodeEvidence,
    evidenceQuality: {
      pollutedSourceCount: 0,
      windowTooNarrow: false,
      missingRuntimeEvidence: refs.length === 0,
      notes: [],
    },
  };
}

function signal(type: RuntimeSignalType, value: string | string[], op: RuntimeSignal['op'] = 'contains'): RuntimeSignal {
  return { id: `${type}_signal`, type, value, op };
}

function node(input: Partial<RuntimeStandardNode> & { expectedSignals?: RuntimeSignal[] }): RuntimeStandardNode {
  return {
    nodeId: input.nodeId ?? 'node',
    nodeEvidenceRef: input.nodeEvidenceRef,
    kind: input.kind ?? 'workflow',
    title: input.title ?? 'node',
    expectedSignals: input.expectedSignals ?? [],
    failureSignals: input.failureSignals ?? [],
    forbiddenSignals: input.forbiddenSignals ?? [],
    conditionSignals: input.conditionSignals ?? [],
    triggers: input.triggers ?? [],
    sourceHints: input.sourceHints ?? [],
    childNodeIds: input.childNodeIds,
  };
}

describe('runtime standard signal matcher', () => {
  const cases: Array<{
    type: RuntimeSignalType;
    signalValue: string | string[];
    signalOp?: RuntimeSignal['op'];
    matchingRef: SkillRuntimeEvidencePackRef;
    nonMatchingRef: SkillRuntimeEvidencePackRef;
  }> = [
    {
      type: 'tool_name',
      signalValue: 'yuque_cli',
      signalOp: 'equals',
      matchingRef: ref({ id: 'tool-ok', sourceType: 'tool_call', toolName: 'yuque-cli', snippet: 'yuque read' }),
      nonMatchingRef: ref({ id: 'tool-no', sourceType: 'tool_call', toolName: 'bash', snippet: 'bash' }),
    },
    {
      type: 'tool_input',
      signalValue: 'source.md',
      matchingRef: ref({ id: 'input-ok', sourceType: 'tool_call', toolName: 'Read', snippet: 'Read source.md' }),
      nonMatchingRef: ref({ id: 'input-no', sourceType: 'tool_result', toolName: 'Read', snippet: 'Read source.md' }),
    },
    {
      type: 'tool_output',
      signalValue: '读取成功',
      matchingRef: ref({ id: 'output-ok', sourceType: 'tool_result', toolName: 'Read', snippet: '文档读取成功' }),
      nonMatchingRef: ref({ id: 'output-no', sourceType: 'tool_call', toolName: 'Read', snippet: '文档读取成功' }),
    },
    {
      type: 'assistant_text',
      signalValue: '已完成',
      matchingRef: ref({ id: 'assistant-ok', sourceType: 'assistant_message', snippet: '任务已完成，结果如下' }),
      nonMatchingRef: ref({ id: 'assistant-no', sourceType: 'user_feedback', snippet: '任务已完成吗' }),
    },
    {
      type: 'user_text',
      signalValue: '有结论吗',
      matchingRef: ref({ id: 'user-ok', sourceType: 'user_feedback', snippet: '有结论吗' }),
      nonMatchingRef: ref({ id: 'user-no', sourceType: 'assistant_message', snippet: '有结论吗' }),
    },
    {
      type: 'artifact_kind',
      signalValue: 'document',
      signalOp: 'equals',
      matchingRef: ref({ id: 'artifact-kind-ok', sourceType: 'artifact', snippet: 'outputs/result.md 文档已生成' }),
      nonMatchingRef: ref({ id: 'artifact-kind-no', sourceType: 'artifact', snippet: 'preview.html demo page' }),
    },
    {
      type: 'artifact_path',
      signalValue: '*.md',
      signalOp: 'glob',
      matchingRef: ref({ id: 'artifact-path-ok', sourceType: 'artifact', snippet: 'artifact\noutputs/result.md' }),
      nonMatchingRef: ref({ id: 'artifact-path-no', sourceType: 'artifact', snippet: 'outputs/result.html' }),
    },
    {
      type: 'event_kind',
      signalValue: 'tool_use',
      signalOp: 'equals',
      matchingRef: ref({ id: 'event-kind-ok', sourceType: 'tool_call', kind: 'tool_use', toolName: 'Read', snippet: 'Read' }),
      nonMatchingRef: ref({ id: 'event-kind-no', sourceType: 'tool_result', kind: 'tool_result', snippet: 'ok' }),
    },
  ];

  for (const item of cases) {
    it(`matches ${item.type} and rejects unrelated refs`, () => {
      const standard = node({
        expectedSignals: [signal(item.type, item.signalValue, item.signalOp)],
      });

      const positive = evaluateRuntimeStandardNodes([standard], pack([item.matchingRef]))[0];
      const negative = evaluateRuntimeStandardNodes([standard], pack([item.nonMatchingRef]))[0];

      assert.equal(positive.status, 'passed');
      assert.equal(negative.status, 'missed');
    });
  }

  it('normalizes fuzzy text without embedding semantics', () => {
    assert.equal(normalizeFuzzyText('读取 成功！Result.md'), '读取 成功resultmd');
  });

  it('normalizes common tool aliases', () => {
    assert.equal(normalizeToolNameValue('yuque-cli'), normalizeToolNameValue('yuque_cli'));
    assert.equal(normalizeToolNameValue('skylark_doc_detail'), 'skylark');
  });

  it('filters polluted runtime and skill context refs before matching', () => {
    const standard = node({
      expectedSignals: [signal('assistant_text', '已完成')],
    });
    const result = evaluateRuntimeStandardNodes([standard], pack([
      ref({ id: 'runtime', sourceType: 'runtime_context', snippet: '已完成 Current time' }),
      ref({ id: 'skill', sourceType: 'skill_context', snippet: '已完成 SKILL.md' }),
    ]))[0];
    assert.equal(result.status, 'missed');
  });
});

describe('runtime standard trigger evaluator', () => {
  it('supports same_session_after anchors', () => {
    const standard = node({
      conditionSignals: [signal('assistant_text', '读取失败')],
      forbiddenSignals: [signal('tool_name', 'Bash', 'equals')],
      triggers: [{
        when: { signalGroup: 'conditionSignals', signalId: 'assistant_text_signal' },
        forbidden: { signalGroup: 'forbiddenSignals', signalId: 'tool_name_signal' },
        verdict: 'violated',
        windowScope: 'same_session_after',
      }],
    });
    const before = evaluateRuntimeStandardNodes([standard], pack([
      ref({ id: 'bash-before', sourceType: 'tool_call', toolName: 'Bash', snippet: 'run', messageIndex: 1 }),
      ref({ id: 'fail', sourceType: 'assistant_message', snippet: '读取失败', messageIndex: 2 }),
    ]))[0];
    const after = evaluateRuntimeStandardNodes([standard], pack([
      ref({ id: 'fail', sourceType: 'assistant_message', snippet: '读取失败', messageIndex: 2 }),
      ref({ id: 'bash-after', sourceType: 'tool_call', toolName: 'Bash', snippet: 'run', messageIndex: 3 }),
    ]))[0];
    assert.equal(before.status, 'unknown');
    assert.equal(after.status, 'violated');
  });

  it('supports same_skill_segment and anywhere_in_session scopes', () => {
    const conditional = node({
      conditionSignals: [signal('assistant_text', '读取失败')],
      forbiddenSignals: [signal('tool_name', 'Bash', 'equals')],
      triggers: [{
        when: { signalGroup: 'conditionSignals', signalId: 'assistant_text_signal' },
        forbidden: { signalGroup: 'forbiddenSignals', signalId: 'tool_name_signal' },
        verdict: 'violated',
        windowScope: 'same_skill_segment',
      }],
    });
    const absolute = node({
      nodeId: 'absolute',
      forbiddenSignals: [signal('artifact_path', '/etc/passwd')],
      triggers: [{
        forbidden: { signalGroup: 'forbiddenSignals', signalId: 'artifact_path_signal' },
        verdict: 'violated',
        windowScope: 'anywhere_in_session',
      }],
    });
    const results = evaluateRuntimeStandardNodes([conditional, absolute], pack([
      ref({ id: 'bash-before', sourceType: 'tool_call', toolName: 'Bash', snippet: 'run', messageIndex: 1 }),
      ref({ id: 'fail', sourceType: 'assistant_message', snippet: '读取失败', messageIndex: 2 }),
      ref({ id: 'forbidden', sourceType: 'artifact', snippet: '/etc/passwd', messageIndex: 99 }),
    ]));
    assert.equal(results[0].status, 'violated');
    assert.equal(results[1].status, 'violated');
  });

  it('keeps same_skill_segment anchored to the same session when an anchor exists', () => {
    const standard = node({
      conditionSignals: [signal('assistant_text', '读取失败')],
      forbiddenSignals: [signal('tool_name', 'Bash', 'equals')],
      triggers: [{
        when: { signalGroup: 'conditionSignals', signalId: 'assistant_text_signal' },
        forbidden: { signalGroup: 'forbiddenSignals', signalId: 'tool_name_signal' },
        verdict: 'violated',
        windowScope: 'same_skill_segment',
      }],
    });
    const result = evaluateRuntimeStandardNodes([standard], pack([
      ref({ id: 'fail', sourceType: 'assistant_message', snippet: '读取失败', sessionId: 's1' }),
      ref({ id: 'bash-other-session', sourceType: 'tool_call', toolName: 'Bash', snippet: 'run', sessionId: 's2' }),
    ]))[0];
    assert.equal(result.status, 'unknown');
  });

  it('supports same_session_after and same_node scopes', () => {
    const sessionAfter = node({
      nodeId: 'session-after',
      conditionSignals: [signal('assistant_text', '授权失败')],
      forbiddenSignals: [signal('tool_name', 'Bash', 'equals')],
      triggers: [{
        when: { signalGroup: 'conditionSignals', signalId: 'assistant_text_signal' },
        forbidden: { signalGroup: 'forbiddenSignals', signalId: 'tool_name_signal' },
        verdict: 'violated',
        windowScope: 'same_session_after',
      }],
    });
    const sameNode = node({
      nodeId: 'same-node',
      expectedSignals: [signal('assistant_text', '结论')],
      triggers: [{
        required: { signalGroup: 'expectedSignals', signalId: 'assistant_text_signal' },
        verdict: 'passed',
        windowScope: 'same_node',
      }],
    });
    const sameNodeRef = ref({ id: 'result', sourceType: 'assistant_message', snippet: '结论如下', messageIndex: 12 });
    const results = evaluateRuntimeStandardNodes([sessionAfter, sameNode], pack([
      ref({ id: 'auth-fail', sourceType: 'assistant_message', snippet: '授权失败', messageIndex: 10 }),
      ref({ id: 'bash-after', sourceType: 'tool_call', toolName: 'Bash', snippet: 'run workflow', messageIndex: 11 }),
      sameNodeRef,
    ], [{
      nodeId: 'same-node',
      kind: 'workflowNode',
      title: 'same-node',
      expectation: '结论',
      deterministicStatus: 'passed',
      deterministicReason: 'matched',
      candidateEvidenceRefs: [sameNodeRef],
      candidateEvidenceSnippets: ['结论如下'],
    }]));
    assert.equal(results[0].status, 'violated');
    assert.equal(results[1].status, 'passed');
  });

  it('keeps same_node from matching refs outside the node evidence set', () => {
    const standard = node({
      nodeId: 'same-node',
      expectedSignals: [signal('assistant_text', '结论')],
      triggers: [{
        required: { signalGroup: 'expectedSignals', signalId: 'assistant_text_signal' },
        verdict: 'passed',
        windowScope: 'same_node',
      }],
    });
    const result = evaluateRuntimeStandardNodes([standard], pack([
      ref({ id: 'global-result', sourceType: 'assistant_message', snippet: '结论如下', messageIndex: 12 }),
    ], [{
      nodeId: 'same-node',
      kind: 'workflowNode',
      title: 'same-node',
      expectation: '结论',
      deterministicStatus: 'manual_review',
      deterministicReason: 'no candidate',
      candidateEvidenceRefs: [],
      candidateEvidenceSnippets: [],
    }]))[0];
    assert.equal(result.status, 'missed');
  });

  it('uses explicit nodeEvidenceRef to resolve same_node evidence when node ids differ', () => {
    const standard = node({
      nodeId: 'llm-read-doc',
      nodeEvidenceRef: 'workflow.read_source',
      expectedSignals: [signal('tool_name', 'Read', 'equals')],
      triggers: [{
        required: { signalGroup: 'expectedSignals', signalId: 'tool_name_signal' },
        verdict: 'passed',
        windowScope: 'same_node',
      }],
    });
    const readRef = ref({ id: 'read-ref', sourceType: 'tool_call', toolName: 'Read', snippet: 'Read source.md', messageIndex: 3 });
    const result = evaluateRuntimeStandardNodes([standard], pack([readRef], [{
      nodeId: 'workflow.read_source',
      kind: 'workflowNode',
      title: '读取源文档',
      expectation: '读取用户提供的文档',
      deterministicStatus: 'passed',
      deterministicReason: 'matched',
      candidateEvidenceRefs: [readRef],
      candidateEvidenceSnippets: ['Read source.md'],
    }]))[0];
    assert.equal(result.status, 'passed');
  });

  it('falls back to signal overlap for same_node evidence when ids differ', () => {
    const standard = node({
      nodeId: 'llm-runner-launch',
      title: '后台启动 runner',
      expectedSignals: [signal('tool_name', 'Bash', 'equals')],
      triggers: [{
        required: { signalGroup: 'expectedSignals', signalId: 'tool_name_signal' },
        verdict: 'passed',
        windowScope: 'same_node',
      }],
    });
    const bashRef = ref({ id: 'bash-ref', sourceType: 'tool_call', toolName: 'Bash', snippet: 'node runner.js', messageIndex: 4 });
    const result = evaluateRuntimeStandardNodes([standard], pack([bashRef], [{
      nodeId: 'workflow.launch_child',
      kind: 'workflowNode',
      title: '启动子任务',
      expectation: '使用 runner.js 后台启动 child',
      deterministicStatus: 'passed',
      deterministicReason: 'matched',
      candidateEvidenceRefs: [bashRef],
      candidateEvidenceSnippets: ['node runner.js'],
    }]))[0];
    assert.equal(result.status, 'passed');
  });

  it('falls back to title similarity for same_node evidence but avoids ambiguous ties', () => {
    const standard = node({
      nodeId: 'llm-result-report',
      title: '回传结果',
      expectedSignals: [signal('assistant_text', '结果如下')],
      triggers: [{
        required: { signalGroup: 'expectedSignals', signalId: 'assistant_text_signal' },
        verdict: 'passed',
        windowScope: 'same_node',
      }],
    });
    const resultRef = ref({ id: 'result-ref', sourceType: 'assistant_message', snippet: '结果如下', messageIndex: 5 });
    const positive = evaluateRuntimeStandardNodes([standard], pack([resultRef], [{
      nodeId: 'workflow.report_result',
      kind: 'workflowNode',
      title: '回传结果',
      expectation: '向用户回传结果',
      deterministicStatus: 'passed',
      deterministicReason: 'matched',
      candidateEvidenceRefs: [resultRef],
      candidateEvidenceSnippets: ['结果如下'],
    }]))[0];
    const tied = evaluateRuntimeStandardNodes([standard], pack([resultRef], [
      {
        nodeId: 'workflow.report_result_a',
        kind: 'workflowNode',
        title: '回传结果',
        expectation: '向用户回传结果',
        deterministicStatus: 'passed',
        deterministicReason: 'matched',
        candidateEvidenceRefs: [resultRef],
        candidateEvidenceSnippets: ['结果如下'],
      },
      {
        nodeId: 'workflow.report_result_b',
        kind: 'workflowNode',
        title: '回传结果',
        expectation: '向用户回传结果',
        deterministicStatus: 'passed',
        deterministicReason: 'matched',
        candidateEvidenceRefs: [resultRef],
        candidateEvidenceSnippets: ['结果如下'],
      },
    ]))[0];
    assert.equal(positive.status, 'passed');
    assert.equal(tied.status, 'missed');
  });

  it('keeps same_session_after from firing before its anchor', () => {
    const standard = node({
      conditionSignals: [signal('assistant_text', '授权失败')],
      forbiddenSignals: [signal('tool_name', 'Bash', 'equals')],
      triggers: [{
        when: { signalGroup: 'conditionSignals', signalId: 'assistant_text_signal' },
        forbidden: { signalGroup: 'forbiddenSignals', signalId: 'tool_name_signal' },
        verdict: 'violated',
        windowScope: 'same_session_after',
      }],
    });
    const result = evaluateRuntimeStandardNodes([standard], pack([
      ref({ id: 'bash-before', sourceType: 'tool_call', toolName: 'Bash', snippet: 'run workflow', messageIndex: 9 }),
      ref({ id: 'auth-fail', sourceType: 'assistant_message', snippet: '授权失败', messageIndex: 10 }),
    ]))[0];
    assert.equal(result.status, 'unknown');
  });

  it('does not treat unindexed refs as after the anchor', () => {
    const standard = node({
      conditionSignals: [signal('assistant_text', '授权失败')],
      forbiddenSignals: [signal('tool_name', 'Bash', 'equals')],
      triggers: [{
        when: { signalGroup: 'conditionSignals', signalId: 'assistant_text_signal' },
        forbidden: { signalGroup: 'forbiddenSignals', signalId: 'tool_name_signal' },
        verdict: 'violated',
        windowScope: 'same_session_after',
      }],
    });
    const result = evaluateRuntimeStandardNodes([standard], pack([
      ref({ id: 'auth-fail', sourceType: 'assistant_message', snippet: '授权失败' }),
      ref({ id: 'bash-no-index', sourceType: 'tool_call', toolName: 'Bash', snippet: 'run workflow' }),
    ]))[0];
    assert.equal(result.status, 'unknown');
  });

  it('supports absence and required trigger branches', () => {
    const required = node({
      nodeId: 'required',
      expectedSignals: [signal('tool_name', 'Read', 'equals')],
      triggers: [{
        required: { signalGroup: 'expectedSignals', signalId: 'tool_name_signal' },
        verdict: 'passed',
        windowScope: 'same_skill_segment',
      }],
    });
    const absence = node({
      nodeId: 'absence',
      failureSignals: [signal('assistant_text', '报错')],
      triggers: [{
        absence: { signalGroup: 'failureSignals', signalId: 'assistant_text_signal' },
        verdict: 'passed',
        windowScope: 'same_skill_segment',
      }],
    });
    const results = evaluateRuntimeStandardNodes([required, absence], pack([
      ref({ id: 'read', sourceType: 'tool_call', toolName: 'Read', snippet: 'Read source.md' }),
    ]));
    assert.equal(results[0].status, 'passed');
    assert.equal(results[1].status, 'passed');
  });

  it('uses conservative verdict priority and stage child aggregation', () => {
    const childOk = node({
      nodeId: 'child_ok',
      expectedSignals: [signal('tool_name', 'Read', 'equals')],
    });
    const childBad = node({
      nodeId: 'child_bad',
      failureSignals: [signal('tool_output', 'command not found')],
    });
    const stage = node({
      nodeId: 'stage',
      kind: 'stage',
      childNodeIds: ['child_ok', 'child_bad'],
    });
    const results = evaluateRuntimeStandardNodes([childOk, childBad, stage], pack([
      ref({ id: 'read', sourceType: 'tool_call', toolName: 'Read', snippet: 'Read source.md' }),
      ref({ id: 'fail', sourceType: 'tool_result', toolName: 'Bash', snippet: 'zsh: command not found' }),
    ]));
    assert.equal(results.find((item) => item.nodeId === 'stage')?.status, 'violated');
  });
});

describe('runtime standard normalizers', () => {
  it('rejects unsupported op/type combinations and malformed triggers', () => {
    assert.equal(normalizeRuntimeSignals([{ id: 'bad', type: 'artifact_kind', value: 'document', op: 'glob' }]).length, 0);
    assert.equal(normalizeRuntimeSignals([
      { id: 'same id', type: 'tool_name', value: 'Read' },
      { id: 'same#id', type: 'tool_name', value: 'Bash' },
    ]).length, 1);
    assert.equal(normalizeRuntimeTriggers([{ verdict: 'passed', windowScope: 'same_session_after' }]).length, 0);
    assert.equal(normalizeRuntimeTriggers([{
      required: { signalGroup: 'expectedSignals', signalId: 'tool' },
      forbidden: { signalGroup: 'forbiddenSignals', signalId: 'tool' },
      verdict: 'passed',
      windowScope: 'same_skill_segment',
    }]).length, 0);
  });
});
