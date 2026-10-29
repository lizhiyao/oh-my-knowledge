// @vitest-environment jsdom
import { ConfigProvider } from 'antd';
import type { PropsWithChildren } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeTaskSearch } from '../../../src/studio/web/components/knowledge/task-search';
import type { KnowledgeTaskRetrieval } from '../../../src/studio/view-models/knowledge/knowledge-candidates';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = `sha256:${'a'.repeat(64)}`;
const source = { snapshotId: uuid(3), sourceVersion: digest };
function result(): KnowledgeTaskRetrieval {
  const bodyRef = { knowledgeId: uuid(1), revisionId: uuid(2), bodyDigest: digest };
  return { projectionKind: 'knowledge-body-segments', schemaVersion: 2, rankingPolicyId: 'knowledge-body-literal-topic-priority/v3',
    omitted: { oversizedSegments: 0, budgetSegments: 2 }, scopeDiagnostics: { source: { status: 'available' } },
    knowledge: [{ bodyRef, generation: 1, title: 'Conditions for reusing diagnostics', choice: null, reviewStatus: 'pending', segmentScope: { returned: 1, total: 3 },
      derivedAssociations: { status: 'absent', reviewStatus: 'pending', bodyRef } }], sources: [{ ...source, status: 'available', sourceKind: 'codex' }],
    items: [{ knowledge: 0, segmentIndex: 1, segment: { segmentId: 's2', text: 'Reuse only when source, model and configuration match. <script>not markup</script>',
      evidence: [{ source, selection: { evidenceRef: 'record-1', start: 6, end: 11, quote: 'Alpha' }, basis: 'source_assertion' }] },
      evidenceChecks: [{ evidenceIndex: 0, source: 0, positionStatus: 'matched' }] }] };
}
function wrapper({ children }: PropsWithChildren) { return <ConfigProvider theme={{ token: { motion: false } }}>{children}</ConfigProvider>; }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }));
  const computed = window.getComputedStyle.bind(window); vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computed(element));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('task-driven knowledge search', () => {
  it('explicitly scopes candidates, source and budget, reports omissions, and opens exact body/evidence without a write', async () => {
    const calls: Record<string, unknown>[] = [], open = vi.fn(), feedback = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { calls.push(JSON.parse(String(init.body))); return new Response(JSON.stringify(result()), { status: 200 }); }));
    const view = render(<KnowledgeTaskSearch workspace="/task-workspace" lang="en" sources={[{ ...source, title: 'Selected frozen record' }]} onOpen={open} onFeedback={feedback}/>, { wrapper });
    fireEvent.change(screen.getByRole('textbox', { name: 'Question for the current task' }), { target: { value: 'When can diagnostics be reused?' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include candidates without a retain decision' }));
    fireEvent.click(screen.getByText('Source scope and response budget'));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Task retrieval response budget' }), { target: { value: '8192' } });
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Task retrieval source snapshot' }));
    fireEvent.click(await screen.findByText(/Selected frozen record · 00000000/));
    fireEvent.click(screen.getByRole('button', { name: 'Find applicable knowledge' }));
    await screen.findByText('Conditions for reusing diagnostics');
    expect(calls).toEqual([{ workspace: '/task-workspace', operation: 'retrieve', format: 'json', query: 'When can diagnostics be reused?',
      includeCandidates: true, maxBytes: 8192, snapshot: source.snapshotId, sourceVersion: source.sourceVersion }]);
    expect(screen.getByText(/2 omitted by budget; 0 oversized/)).toBeTruthy();
    expect(screen.getByText(/1\/3 segments provided/)).toBeTruthy();
    expect(screen.getByText(result().items[0].segment.text)).toBeTruthy(); expect(view.container.querySelector('script')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open complete content' }));
    expect(open).toHaveBeenLastCalledWith(result().knowledge[0].bodyRef, { tab: 'body', segmentId: 's2' });
    fireEvent.click(screen.getByText('Inspect evidence and exact revision'));
    fireEvent.click(screen.getByRole('button', { name: 'Open exact evidence' }));
    expect(open).toHaveBeenLastCalledWith(result().knowledge[0].bodyRef, { tab: 'evidence', segmentId: 's2', evidence: { ...source, evidenceRef: 'record-1', start: 6, end: 11 } });
    fireEvent.click(screen.getByRole('button', { name: 'Review this segment' }));
    expect(feedback).toHaveBeenCalledWith(result().knowledge[0].bodyRef, 's2', 'When can diagnostics be reused?');
    fireEvent.change(screen.getByRole('textbox', { name: 'Question for the current task' }), { target: { value: 'A different task' } });
    expect(screen.queryByText('Conditions for reusing diagnostics')).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('aborts a workspace request and ignores its late response without exposing the old query or result', async () => {
    let release!: (response: Response) => void; let oldSignal: AbortSignal | undefined;
    const fetcher = vi.fn((_url: string, init: RequestInit) => { oldSignal = init.signal as AbortSignal; return new Promise<Response>(resolve => { release = resolve; }); });
    vi.stubGlobal('fetch', fetcher);
    const view = render(<KnowledgeTaskSearch workspace="/old" lang="en" onOpen={vi.fn()}/>, { wrapper });
    fireEvent.change(screen.getByRole('textbox', { name: 'Question for the current task' }), { target: { value: 'Private old task' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find applicable knowledge' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    view.rerender(<KnowledgeTaskSearch workspace="/new" lang="en" onOpen={vi.fn()}/>);
    expect(oldSignal?.aborted).toBe(true);
    expect((screen.getByRole('textbox', { name: 'Question for the current task' }) as HTMLTextAreaElement).value).toBe('');
    await act(async () => { release(new Response(JSON.stringify(result()), { status: 200 })); });
    expect(screen.queryByText('Conditions for reusing diagnostics')).toBeNull();
    expect(screen.queryByText(/Private old task/)).toBeNull();
  });

  it('keeps read failures distinct from an empty result and defaults to retained-only retrieval', async () => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { calls.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ error: 'internal_failure' }), { status: 503 }); }));
    render(<KnowledgeTaskSearch workspace="/task-workspace" lang="en" onOpen={vi.fn()}/>, { wrapper });
    fireEvent.change(screen.getByRole('textbox', { name: 'Question for the current task' }), { target: { value: 'Find evidence' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find applicable knowledge' }));
    await screen.findByText(/A failed read does not mean no knowledge exists/);
    expect(screen.queryByText(/No content returned for these terms/)).toBeNull();
    expect(calls[0]).toMatchObject({ includeCandidates: false, maxBytes: 65536, format: 'json' });
    expect(screen.queryByRole('button', { name: 'Review this segment' })).toBeNull();
  });
});
