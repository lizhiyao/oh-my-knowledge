import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntityLinkPreviewEvidence, EntityLinkSavedEvidence } from '../../../src/studio/web/components/knowledge/entity-link-evidence.js';
import { EntityLibraryDetail } from '../../../src/studio/web/components/knowledge/entities.js';
import { entityLinkFixture } from './entity-link-fixture.js';
import { EntityLinkQualityEvidence } from '../../../src/studio/web/components/knowledge/entity-link-quality.js';
import { entityLinkQuality } from '../../../src/knowledge/entity-linking/entity-link-quality.js';
import { entityLinkDigest } from '../../../src/knowledge/entity-linking/entity-link-hash.js';
import { entityLinkTextHash } from '../../../src/knowledge/adapters/entity-link-api-producer.js';

let fixture: Awaited<ReturnType<typeof entityLinkFixture>>, terminatedFixture: Awaited<ReturnType<typeof entityLinkFixture>>;
beforeAll(async () => { fixture = await entityLinkFixture(); terminatedFixture = await entityLinkFixture({ terminate: true }); });
afterAll(() => { fixture?.cleanup(); terminatedFixture?.cleanup(); });
describe('entity-link actual evidence rendering', () => {
  it('renders shared quality denominators and unknown usage in both languages, escaping model identity and distinguishing unreadable', () => {
    const quality = entityLinkQuality([fixture.saved.history], { hashJson: entityLinkDigest, hashText: entityLinkTextHash });
    for (const lang of ['zh', 'en'] as const) {
      const value = structuredClone(quality); value.groups[0].identity.model = '<script>unsafe</script>';
      const html = renderToStaticMarkup(createElement(EntityLinkQualityEvidence, { value, failed: false, lang }));
      expect(html).toContain(lang === 'zh' ? '机器接纳分母：1' : 'Admission denominator: 1');
      expect(html).toContain(lang === 'zh' ? '人工决定分母：0' : 'Human decision denominator: 0');
      expect(html).toContain('insufficient_evidence'); expect(html).toContain('unknownReviewCount'); expect(html).toContain('knownTotal');
      expect(html).toContain(lang === 'zh' ? '均不代表准确率' : 'neither measures accuracy');
      expect(html).toContain('&lt;script&gt;unsafe&lt;/script&gt;'); expect(html).not.toContain('<script>');
      const failed = renderToStaticMarkup(createElement(EntityLinkQualityEvidence, { failed: true, lang }));
      expect(failed).toContain(lang === 'zh' ? '数量未知' : 'counts are unknown'); expect(failed).not.toContain('review：0');
    }
  });
  it('renders human termination and late evidence without admission or human-decision claims in both languages', () => {
    for (const saved of [terminatedFixture.terminated!, terminatedFixture.saved]) for (const lang of ['zh', 'en'] as const) {
      const html = renderToStaticMarkup(createElement(EntityLinkSavedEvidence, { value: saved, lang }));
      expect(html).toContain(lang === 'zh' ? '人工已终止调用' : 'Execution terminated by human');
      expect(html).toContain(lang === 'zh' ? '人工终止记录' : 'Human termination record');
      expect(html).toContain(saved.projection.termination!.actor.actorId);
      expect(html).toContain('人工终止理由 &lt;script&gt;unsafe&lt;/script&gt;'); expect(html).not.toContain('<script>');
      expect(html).toContain(lang === 'zh' ? '终止不证明原进程或请求已停止' : 'Termination does not prove the original process or request stopped');
      expect(html).not.toContain(`<h4>${lang === 'zh' ? '结构接纳' : 'Structural admission'}</h4>`);
      expect(html).not.toContain(`<h4>${lang === 'zh' ? '独立人工决定' : 'Separate human decision'}</h4>`);
      const quality = entityLinkQuality([saved.history], { hashJson: entityLinkDigest, hashText: entityLinkTextHash });
      const observation = renderToStaticMarkup(createElement(EntityLinkQualityEvidence, { value: quality, failed: false, lang }));
      expect(observation).toContain(lang === 'zh' ? '人工终止：1' : 'Human terminations: 1');
      expect(observation).toContain(lang === 'zh' ? '已派发但排除接纳分母：1' : 'dispatched but excluded from admission: 1');
      expect(observation).toContain(lang === 'zh' ? '机器接纳分母：0' : 'Admission denominator: 0');
      expect(observation).toContain(lang === 'zh' ? '人工决定分母：0' : 'Human decision denominator: 0');
      expect(observation).toContain(lang === 'zh' ? '人工终止不计为身份拒绝或模型失败' : 'Human termination is neither an identity rejection nor a model failure');
      const archived = saved === terminatedFixture.saved;
      expect(observation).toContain(lang === 'zh' ? `尚未归档：${archived ? 0 : 1}；迟到归档：${archived ? 1 : 0}` : `outcome unrecorded: ${archived ? 0 : 1}; late outcome recorded: ${archived ? 1 : 0}`);
      expect(html).toContain(archived ? '模型不知道 &lt;script&gt;unsafe&lt;/script&gt;' : lang === 'zh' ? '尚无可用的归档结果。' : 'No archived outcome is available.');
    }
    expect(terminatedFixture.invocationCount()).toBe(1);
  });
  it('shows the current entity entry and keeps historical revisions read-only', () => {
    const render = (current: boolean) => renderToStaticMarkup(createElement(EntityLibraryDetail, { detail: current ? fixture.left : { ...fixture.left, history: { ...fixture.left.history, writeHeadRevisionId: 'newer' } }, workspace: fixture.workspace, lang: 'zh', onRevision() {}, onLink() {} }));
    expect(render(true)).toContain('查找跨窗口对应'); expect(render(false)).toMatch(/<button[^>]*disabled=""[^>]*><span>查找跨窗口对应/);
  });
  it('shows both original UUIDs, exact selected mentions, model, endpoint, and full source in both languages', () => {
    for (const lang of ['zh', 'en'] as const) {
      const html = renderToStaticMarkup(createElement(EntityLinkPreviewEvidence, { value: fixture.preview, lang }));
      for (const text of [fixture.left.entity.entityId, fixture.right.entity.entityId, fixture.preview.preview.plan.left.mentionIds[0], fixture.workspace, 'fixture-model', 'https://fixture.invalid/v1/chat/completions']) expect(html).toContain(text);
      expect(html).toContain(lang === 'zh' ? '名称只用于召回候选' : 'Names only retrieve candidates');
      expect(html).toContain(lang === 'zh' ? '费用未知' : 'cost unknown'); expect(html).toContain('system');
    }
  });
  it('renders independent model/admission/human/library states, complete evidence and uncertainty without treating unknown as zero', () => {
    const saved = structuredClone(fixture.saved); saved.projection.usage.inputTokens = null;
    for (const lang of ['zh', 'en'] as const) {
      const html = renderToStaticMarkup(createElement(EntityLinkSavedEvidence, { value: saved, lang }));
      expect(html).toContain(lang === 'zh' ? '等待人工核对' : 'Awaiting human review');
      expect(html).toContain(lang === 'zh' ? '未知' : 'Unknown'); expect(html).toContain('insufficient_evidence');
      expect(html).toContain('模型不知道 &lt;script&gt;unsafe&lt;/script&gt;'); expect(html).not.toContain('<script>');
      expect(html).toContain(lang === 'zh' ? '完整原生结果／失败与用量' : 'Complete native result / failure and usage');
      expect(html).toContain(lang === 'zh' ? '不证明提供方明确报告了 0' : 'does not prove a provider explicitly reported zero');
      expect(html).not.toContain(lang === 'zh' ? '知识库组织已保存' : 'Library organization saved');
      const running = renderToStaticMarkup(createElement(EntityLinkSavedEvidence, { value: { ...fixture.prepared, projection: { ...fixture.prepared.projection, status: 'execution_unknown' } }, lang }));
      expect(running).toContain(lang === 'zh' ? '不会重新发送' : 'never resend');
    }
  });
});
