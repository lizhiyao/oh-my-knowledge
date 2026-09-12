import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  reviewActionLabels,
  reviewPriorityMeta,
  reviewStateKey,
  reviewVerdictBadge,
} from '../../../src/observability/inbox/review-semantics.js';

describe('review semantics (host-independent)', () => {
  it('maps review priorities to bilingual labels and tones', () => {
    assert.deepEqual(reviewPriorityMeta('review_first', 'zh'), { label: '建议优先复盘', tone: 'error' });
    assert.deepEqual(reviewPriorityMeta('sample_review', 'en'), { label: 'Sample review', tone: 'warning' });
    assert.deepEqual(reviewPriorityMeta('routine' as never, 'zh'), { label: '常规抽样', tone: 'neutral' });
  });

  it('maps verdicts to stable bilingual badges', () => {
    assert.deepEqual(reviewVerdictBadge('real_issue', 'zh'), { label: '已同意', color: 'success' });
    assert.deepEqual(reviewVerdictBadge('not_issue', 'en'), { label: 'Rejected', color: 'error' });
    assert.deepEqual(reviewVerdictBadge('needs_more_context', 'zh'), { label: '已留意见', color: 'warning' });
    assert.deepEqual(reviewVerdictBadge('needs_more_context', 'en'), { label: 'Noted', color: 'warning' });
    assert.deepEqual(reviewVerdictBadge('reviewed', 'zh'), { label: '已看过', color: 'processing' });
  });

  it('provides bilingual action labels', () => {
    assert.equal(reviewActionLabels('zh').confirm, '同意');
    assert.equal(reviewActionLabels('en').confirm, 'Confirm');
    assert.equal(reviewActionLabels('zh').note, '留意见');
    assert.equal(reviewActionLabels('en').saveNote, 'Save note');
  });

  it('builds review state keys identical to the persisted shape', () => {
    assert.equal(reviewStateKey('experience_session', 's1'), 'experience_session:s1');
    assert.equal(reviewStateKey('skill', 'audit'), 'skill:audit');
  });
});
