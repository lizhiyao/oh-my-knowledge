import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EntityReviewCorpusSchema, entityReviewInput, reviewMentions } from '../../scripts/bench/entity-review-corpus.js';
import { checkEntityReview } from '../../scripts/bench/entity-review-checks.js';
import { checkWindowExtractionResponse } from '../../src/observability/knowledge-extraction/extraction/window-proposals.js';
import { modelWindow } from '../knowledge/fixtures.js';

describe('version artifact distinction diagnostic v1 (authored responses, no model calls)', () => {
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/entity-version-artifact-v1.json', import.meta.url), 'utf8'));
  const sample = EntityReviewCorpusSchema.shape.cases.element.parse(fixture.sample);
  const spans = Object.fromEntries(reviewMentions(sample).flatMap(mention => mention.spans.map(span => [mention.mentionKey, span])));

  function authored(corpusKind: 'version' | 'object') {
    const output = modelWindow();
    output.entities[0] = { ...output.entities[0], entityId: 'corpus-v12', label: '回归语料 v12', description: '已冻结归档、此后只读的具体语料版本。', referentKind: corpusKind };
    output.entities[1] = { ...output.entities[1], entityId: 'extraction-prompt', label: '提取提示词', description: '持续迭代的提取提示词本身。', referentKind: 'object' };
    const mentionOf = (mentionKey: string, entityId: string) => ({
      mentionId: `m-${mentionKey}`, entityId,
      selection: { evidenceRef: spans[mentionKey].evidenceRef, quote: spans[mentionKey].quote, occurrence: 0 },
      basis: 'explicit' as const, rationale: '按标注位置逐字引用。',
    });
    output.mentions = [
      mentionOf('corpus-full-name', 'corpus-v12'),
      mentionOf('corpus-short-name', 'corpus-v12'),
      mentionOf('prompt-name', 'extraction-prompt'),
    ];
    output.proposals = [{
      proposalId: 'k-no-mix',
      draft: {
        title: '归档版本语料不与后续版本合并计算',
        content: {
          statements: [{
            statementId: 's-no-mix', subject: { entityId: 'corpus-v12' },
            relation: '与后续版本语料合并计算', modality: 'normative', polarity: 'negative',
            context: { scenario: '语料版本演进', conditions: [], exceptions: [], unknowns: [],
              occurredDuring: { timeKind: 'unknown', reason: '来源未说明' },
              validDuring: { timeKind: 'unknown', reason: '来源未说明' } },
          }],
          organization: { knowledgeKind: 'fact' },
        },
        evidence: [{ evidenceLinkId: 'l-no-mix', evidenceRef: `${sample.caseId}:1`, statementIds: ['s-no-mix'],
          relation: 'supports', basis: 'source_assertion', interpretation: '助手在确认中明确提出不混算约束。' }],
      },
      entityIds: ['corpus-v12'], mentionIds: ['m-corpus-short-name'],
      citations: [{ evidenceLinkId: 'l-no-mix', selection: { evidenceRef: `${sample.caseId}:1`, quote: '不与后续版本混算', occurrence: 0 } }],
      reuseRationale: '后续任何冻结制品升版时复查同一约束。', identityUncertainties: [],
    }];
    const checked = checkWindowExtractionResponse(output, entityReviewInput(sample).excerpts);
    return { checked, review: checkEntityReview(sample, checked) };
  }

  it('matches gold when the frozen artifact is typed version and the living prompt stays object', () => {
    expect(fixture).toMatchObject({ reviewVersion: 'omk-entity-version-artifact/v1', provenance: 'synthetic' });
    const { checked, review } = authored('version');
    expect(checked.analysis.rejected).toEqual([]);
    expect(checked.rejected).toEqual([]);
    expect(review.criticalMentionRecall).toMatchObject({ matched: 3, total: 3 });
    expect(review.identities.map(identity => [identity.entity, identity.status])).toEqual([
      ['corpus-v12', 'matched'], ['extraction-prompt', 'matched'],
    ]);
    expect(review.roles.map(role => role.endpointStatus)).toEqual(['endpoints_matched']);
    expect(review.semanticReview).toBe('pending');
  });

  it('flags typing the frozen artifact as object as a referent_kind mismatch', () => {
    const { review } = authored('object');
    const corpus = review.identities.find(identity => identity.entity === 'corpus-v12')!;
    expect(corpus.status).toBe('mismatched');
    expect(corpus.problems).toContain('referent_kind');
    expect(review.identities.find(identity => identity.entity === 'extraction-prompt')!.status).toBe('matched');
  });
});
