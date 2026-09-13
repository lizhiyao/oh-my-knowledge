import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  reviewActionLabels,
  reviewActionRequest,
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
    assert.equal(reviewActionLabels('zh').revoke, '撤销复核');
    assert.equal(reviewActionLabels('en').revoke, 'Undo review');
    assert.match(reviewActionLabels('zh').revokeHint, /撤销/);
    assert.match(reviewActionLabels('en').revokeHint, /revoke/i);
  });

  it('writes a verdict that is not the current one', () => {
    assert.deepEqual(
      reviewActionRequest('experience_session', 's1', undefined, 'real_issue'),
      { method: 'POST', targetType: 'experience_session', targetId: 's1', verdict: 'real_issue' },
    );
    // 换结论是写入，不是撤销。
    assert.deepEqual(
      reviewActionRequest('experience_session', 's1', 'real_issue', 'not_issue'),
      { method: 'POST', targetType: 'experience_session', targetId: 's1', verdict: 'not_issue' },
    );
  });

  it('revokes when the current verdict is clicked again without a note', () => {
    assert.deepEqual(
      reviewActionRequest('experience_session', 's1', 'real_issue', 'real_issue'),
      { method: 'DELETE', targetType: 'experience_session', targetId: 's1' },
    );
    // 清空意见后保存，等价于撤销这条留意见复核。
    assert.deepEqual(
      reviewActionRequest('experience_session', 's1', 'needs_more_context', 'needs_more_context', undefined),
      { method: 'DELETE', targetType: 'experience_session', targetId: 's1' },
    );
  });

  it('keeps a note on the same verdict as a write', () => {
    assert.deepEqual(
      reviewActionRequest('experience_session', 's1', 'needs_more_context', 'needs_more_context', '还需要 trace'),
      {
        method: 'POST',
        targetType: 'experience_session',
        targetId: 's1',
        verdict: 'needs_more_context',
        reason: '还需要 trace',
      },
    );
  });

  it('builds review state keys identical to the persisted shape', () => {
    assert.equal(reviewStateKey('experience_session', 's1'), 'experience_session:s1');
    assert.equal(reviewStateKey('skill', 'audit'), 'skill:audit');
  });
});
