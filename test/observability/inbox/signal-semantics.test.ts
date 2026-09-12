import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  signalEvidenceConclusion,
  signalRuleDescription,
  signalSemanticEvidence,
  signalSeverityMeta,
  signalSourceMeta,
} from '../../../src/observability/inbox/signal-semantics.js';
import { baseItem } from './_helpers.js';

describe('signal semantics (host-independent)', () => {
  it('maps all severities to bilingual labels, decisions and tones', () => {
    assert.deepEqual(signalSeverityMeta('high', 'zh'), {
      label: '高风险/需关注',
      decision: '优先看，可能要补 SKILL.md 或改 skill 说明',
      tone: 'error',
    });
    assert.deepEqual(signalSeverityMeta('medium', 'en'), {
      label: 'Low risk / sample-check',
      decision: 'Usually no skill change; sample-check whether time is repeatedly wasted',
      tone: 'warning',
    });
    assert.equal(signalSeverityMeta('low', 'zh').label, '不确定/低优先级');
    assert.equal(signalSeverityMeta('low').tone, 'info');
    assert.equal(signalSeverityMeta('noise', 'en').label, 'Noise / no skill change');
    assert.equal(signalSeverityMeta('noise').tone, 'neutral');
  });

  it('concludes evidence per subtype in zh and en with tool fallback', () => {
    const probe = baseItem({ signalSubtype: 'bash_probe', evidence: { tool: 'Bash', query: 'ls' } });
    assert.equal(signalEvidenceConclusion(probe, 'zh'), 'skill 运行过程中，agent 调用了一条 Bash 命令。');
    assert.equal(signalEvidenceConclusion(probe, 'en'), 'During the skill run, the agent invoked a Bash command.');

    const limited = baseItem({ signalSubtype: 'tool_limit', evidence: { query: 'x' } });
    assert.equal(signalEvidenceConclusion(limited, 'zh'), '工具 触发了文件太长、token 或超时限制。');
    assert.equal(signalEvidenceConclusion(limited, 'en'), 'Tool hit a file-length, token or timeout limit.');

    const denied = baseItem({ signalSubtype: 'permission_denied', evidence: { tool: 'Read', path: '/a' } });
    assert.equal(signalEvidenceConclusion(denied, 'zh'), 'Read 被权限拒绝。');

    const hardMiss = baseItem({ signalSubtype: 'hard_miss', evidence: { tool: 'Grep', query: 'q' } });
    assert.equal(signalEvidenceConclusion(hardMiss, 'en'), 'Grep returned nothing useful, and no later success on the same topic was observed.');

    const hedge = baseItem({ signalType: 'hedging', signalSubtype: 'llm_classified', evidence: {} });
    assert.equal(signalEvidenceConclusion(hedge, 'zh'), '模型文本里出现了不确定表达。');
    const marker = baseItem({ signalType: 'explicit_marker', signalSubtype: 'llm_classified', evidence: {} });
    assert.equal(signalEvidenceConclusion(marker, 'en'), 'The model text contains an explicit marker.');
  });

  it('falls back to semantic evidence for unhandled subtype and signal type pairs', () => {
    const item = baseItem({ signalType: 'failed_search', signalSubtype: 'llm_classified', evidence: { query: 'q' } });
    assert.equal(signalEvidenceConclusion(item, 'zh'), signalSemanticEvidence(item, 'zh'));
    assert.equal(signalSemanticEvidence(item, 'zh'), 'q');
    const empty = baseItem({ signalType: 'failed_search', signalSubtype: 'llm_classified', evidence: {} });
    assert.equal(signalSemanticEvidence(empty, 'zh'), '');
  });

  it('formats the rule description with label, identity, confidence and reason', () => {
    const item = baseItem({ signalSubtype: 'hard_miss', confidence: 0.9 });
    const zh = signalRuleDescription(item, 'zh');
    assert.match(zh, /^高风险\/需关注: failed_search\/hard_miss, confidence=0\.90\. /);
    assert.match(zh, /疑似知识缺口。$/);
    const en = signalRuleDescription(item, 'en');
    assert.match(en, /^High risk: failed_search\/hard_miss, confidence=0\.90\. /);
  });

  it('maps trace sources to stable labels and tones', () => {
    assert.deepEqual(signalSourceMeta('dsh'), { label: 'DeepSeek Harness', tone: 'teal' });
    assert.deepEqual(signalSourceMeta('openclaw'), { label: 'OpenClaw', tone: 'purple' });
    assert.deepEqual(signalSourceMeta('codex'), { label: 'Codex', tone: 'geekblue' });
    assert.deepEqual(signalSourceMeta('markdown_log'), { label: 'Markdown log', tone: 'green' });
    assert.deepEqual(signalSourceMeta('claude'), { label: 'Claude', tone: 'blue' });
  });
});
