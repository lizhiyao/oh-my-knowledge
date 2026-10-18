// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { KnowledgeEntities } from '../../../src/studio/web/components/knowledge/entities.js';
import { EntityLinksDrawer } from '../../../src/studio/web/components/knowledge/entity-links.js';
import { entityLinkFixture } from './entity-link-fixture.js';
import { entityLinkQuality } from '../../../src/knowledge/linking/entity-link-quality.js';
import { entityLinkDigest } from '../../../src/knowledge/linking/entity-link-hash.js';
import { entityLinkTextHash } from '../../../src/knowledge/adapters/entity-link-api-producer.js';
import type { EntityLinkStudioQuality } from '../../../src/studio/view-models/knowledge/entity-links.js';

// Keep the production handlers/evidence; native controls isolate lifecycle from portal/layout machinery.
vi.mock('antd', () => {
  const Input = Object.assign((props: Record<string, unknown>) => createElement('input', props), { Search: ({ onSearch: _onSearch, allowClear: _clear, ...props }: Record<string, unknown>) => createElement('input', props), TextArea: (props: Record<string, unknown>) => createElement('textarea', props) });
  return { Input, Drawer: ({ children, title }: { children: ReactNode; title: string }) => createElement('div', { role: 'dialog', 'aria-label': title }, children),
    Pagination: () => null,
    Button: ({ children, onClick, disabled }: { children: ReactNode; onClick(): void; disabled: boolean }) => createElement('button', { onClick, disabled }, children),
    Select: ({ options = [], value, onChange, mode, ...props }: { options: { value: string; label: string }[]; value?: string | string[]; onChange(value: string | string[]): void; mode?: string }) => createElement('select', { ...props, multiple: mode === 'multiple', value: value ?? '', onChange: (event: { target: HTMLSelectElement }) => onChange(mode === 'multiple' ? [...event.target.selectedOptions].map(option => option.value) : event.target.value) }, options.map(option => createElement('option', { key: option.value, value: option.value }, option.label))),
    Checkbox: ({ children, checked, disabled, onChange }: { children: ReactNode; checked: boolean; disabled: boolean; onChange: unknown }) => createElement('label', {}, createElement('input', { type: 'checkbox', checked, disabled, onChange: onChange as never }), children),
    Alert: ({ title }: { title: ReactNode }) => createElement('div', { role: 'alert' }, title), Empty: ({ description }: { description: ReactNode }) => createElement('p', {}, description),
    Space: ({ children }: { children: ReactNode }) => createElement('div', {}, children), Spin: () => createElement('span', {}, 'loading'), Tag: ({ children }: { children: ReactNode }) => createElement('span', {}, children) };
});
let fixture: Awaited<ReturnType<typeof entityLinkFixture>>;
let quality: EntityLinkStudioQuality;
beforeAll(async () => { fixture = await entityLinkFixture(); quality = entityLinkQuality([fixture.saved.history], { hashJson: entityLinkDigest, hashText: entityLinkTextHash }); });
afterAll(() => fixture?.cleanup());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function harness(options: { failPropose?: boolean } = {}) {
  const calls: Record<string, unknown>[] = [];
  const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string); calls.push(body);
    if (body.operation === 'propose' && options.failPropose) throw new Error('ack lost');
    const value = body.operation === 'quality' ? quality : body.operation === 'candidates' ? fixture.candidates : body.operation === 'list' ? [] : body.operation === 'entity-detail' ? fixture.right
      : body.operation === 'preview' ? fixture.preview : fixture.saved;
    return new Response(JSON.stringify(value), { status: 200 });
  });
  vi.stubGlobal('fetch', fetch); return { calls, fetch };
}
async function selectPreview() {
  await waitFor(() => expect(screen.getByLabelText('选择跨窗口候选')).toBeTruthy());
  fireEvent.change(screen.getByLabelText('选择跨窗口候选'), { target: { value: `${fixture.right.history.analysisId}:${fixture.right.entity.entityId}` } });
  await waitFor(() => expect(screen.getByLabelText('右侧选中提及')).toBeTruthy());
  fireEvent.change(screen.getByLabelText('API 模型（明确填写）'), { target: { value: 'fixture-model' } });
  fireEvent.click(screen.getByText('本地预览精确发送内容'));
  await waitFor(() => expect(screen.getByText('发送以上内容，生成关联建议')).toBeTruthy());
}
describe('entity-link drawer lifecycle and explicit authorization', () => {
  it('reads only on mount, requires separate content and human consent, and blocks double clicks', async () => {
    const { calls } = harness(); render(createElement(EntityLinksDrawer, { workspace: fixture.workspace, detail: fixture.left, lang: 'zh', onClose() {} }));
    await selectPreview(); expect(calls.filter(call => call.operation === 'propose')).toHaveLength(0);
    const send = screen.getByText('发送以上内容，生成关联建议') as HTMLButtonElement; expect(send.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('我已核对当前工作区、完整发送内容、选中提及、模型与 endpoint，确认发送一次。'));
    fireEvent.click(send); fireEvent.click(send);
    await waitFor(() => expect(screen.getByText('人工接受并组织知识库')).toBeTruthy());
    expect(calls.filter(call => call.operation === 'propose')).toHaveLength(1);
    const accept = screen.getByText('人工接受并组织知识库') as HTMLButtonElement; expect(accept.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('人工处理理由'), { target: { value: '核对两侧来源' } }); expect(accept.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('我已独立核对两侧来源与身份，确认是同一对象。')); fireEvent.click(accept);
    await waitFor(() => expect(calls.filter(call => call.operation === 'accept')).toHaveLength(1));
    expect(calls.find(call => call.operation === 'propose')).toEqual({ workspace: fixture.workspace, operation: 'propose', previewToken: 'fixture-token', contentConfirmed: true });
    expect(calls.find(call => call.operation === 'accept')).toMatchObject({ identityConfirmed: true, reason: '核对两侧来源' });
  });
  it('keeps unknown acknowledgement on the same review and requires inspection before any new send', async () => {
    const { calls } = harness({ failPropose: true }); render(createElement(EntityLinksDrawer, { workspace: fixture.workspace, detail: fixture.left, lang: 'zh', onClose() {} }));
    await selectPreview(); fireEvent.click(screen.getByLabelText('我已核对当前工作区、完整发送内容、选中提及、模型与 endpoint，确认发送一次。')); fireEvent.click(screen.getByText('发送以上内容，生成关联建议'));
    await waitFor(() => expect(screen.getByText(/操作回执未确认/)).toBeTruthy());
    expect((screen.getByText('发送以上内容，生成关联建议') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('核对同一 review ID') as HTMLInputElement).value).toBe(fixture.preview.preview.reviewId);
    fireEvent.click(screen.getByText('读取同一 review（不发送）')); await waitFor(() => expect(screen.getByText('持久记录与原生证据')).toBeTruthy());
    expect(calls.filter(call => call.operation === 'propose')).toHaveLength(1); expect(calls.filter(call => call.operation === 'show')).toHaveLength(1);
  });

  it('keeps the review drawer and original snapshot mounted through real parent knowledge refresh', async () => {
    let detailReads = 0;
    const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const value = body.operation === 'entity-catalog' ? { rows: [], analysisCount: 2, total: 0, page: 1, pageSize: 20, unavailableAnalyses: 0, knowledgeStatus: 'available' }
        : body.operation === 'owners' ? []
          : body.operation === 'entity-detail' ? (++detailReads && (body.analysisId === fixture.right.history.analysisId ? fixture.right : fixture.left))
            : body.operation === 'quality' ? quality : body.operation === 'candidates' ? fixture.candidates : body.operation === 'list' ? [] : body.operation === 'preview' ? fixture.preview : fixture.saved;
      return new Response(JSON.stringify(value));
    });
    vi.stubGlobal('fetch', fetch);
    render(createElement(KnowledgeEntities, { lang: 'zh', initialWorkspace: fixture.workspace, initialAnalysisId: fixture.left.history.analysisId, initialEntityId: fixture.left.entity.entityId }));
    await waitFor(() => expect((screen.getByText('查找跨窗口对应') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText('查找跨窗口对应')); await selectPreview();
    fireEvent.click(screen.getByLabelText('我已核对当前工作区、完整发送内容、选中提及、模型与 endpoint，确认发送一次。'));
    fireEvent.click(screen.getByText('发送以上内容，生成关联建议'));
    await waitFor(() => expect(screen.getByText('人工接受并组织知识库')).toBeTruthy());
    const reads = detailReads;
    await act(async () => { window.dispatchEvent(new CustomEvent('omk-knowledge-changed', { detail: fixture.workspace })); });
    await waitFor(() => expect(detailReads).toBeGreaterThan(reads));
    expect(screen.getByText('人工接受并组织知识库')).toBeTruthy(); expect(screen.getByText('持久记录与原生证据')).toBeTruthy();
    expect((screen.getByLabelText('核对同一 review ID') as HTMLInputElement).value).toBe(fixture.saved.history.reviewId);
    expect(fetch.mock.calls.filter(([, init]) => JSON.parse(init.body as string).operation === 'propose')).toHaveLength(1);
  });
  it('aborts old workspace requests and ignores late responses without dispatching', async () => {
    let release!: (response: Response) => void; const old = new Promise<Response>(resolve => { release = resolve; }); let signal: AbortSignal | undefined;
    const fetch = vi.fn((_url: unknown, init: RequestInit) => { const body = JSON.parse(init.body as string); if (body.workspace === '/old') { signal = init.signal as AbortSignal; return old; } return Promise.resolve(new Response(JSON.stringify(body.operation === 'quality' ? quality : body.operation === 'candidates' ? fixture.candidates : []))); });
    vi.stubGlobal('fetch', fetch);
    const rendered = render(createElement(EntityLinksDrawer, { workspace: '/old', detail: fixture.left, lang: 'zh', onClose() {} }));
    rendered.rerender(createElement(EntityLinksDrawer, { workspace: fixture.workspace, detail: fixture.left, lang: 'zh', onClose() {} }));
    expect(signal?.aborted).toBe(true);
    await act(async () => { release(new Response(JSON.stringify({ rows: [], unavailableAnalyses: 999 }))); });
    await waitFor(() => expect(screen.getByLabelText('选择跨窗口候选')).toBeTruthy()); expect(screen.queryByText(/999 份分析/)).toBeNull();
    expect(fetch.mock.calls.every(([, init]) => !['propose', 'continue'].includes(JSON.parse(init.body as string).operation))).toBe(true);
  });
});
