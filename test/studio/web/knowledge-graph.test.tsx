// @vitest-environment jsdom
import { ConfigProvider } from 'antd';
import { type PropsWithChildren } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeGraphInspection, KnowledgeGraphView } from '../../../src/studio/web/components/knowledge/knowledge-graph';
import { KnowledgeLibrary } from '../../../src/studio/web/components/knowledge/library';
import { KnowledgeReader } from '../../../src/studio/web/components/knowledge/reader';
import type { KnowledgeCandidateDetail, KnowledgeEntityAnalysisDetail, KnowledgeGraph } from '../../../src/studio/view-models/knowledge/knowledge-candidates';
import type { KnowledgeLibraryKnowledge } from '../../../src/studio/view-models/knowledge/knowledge-library';
import type { KnowledgeReviewStatus } from '../../../src/studio/view-models/knowledge/knowledge-reviews';
import { bodyWrite } from '../../knowledge/body-fixtures';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(window.location.search), useRouter: () => ({ push: vi.fn() }) }));
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = `sha256:${'a'.repeat(64)}`;
const at = '2026-10-29T00:00:00Z';
function fixture() {
  const revision = { ...bodyWrite().revision, knowledgeId: uuid(1), revisionId: uuid(2), title: '保存可核对的项目认识',
    content: { segments: [{ segmentId: 's1', text: 'Alpha 的使用受本次来源限定，仍需回查原文。', evidence: [{
      source: { snapshotId: uuid(3), sourceVersion: digest }, basis: 'source_assertion' as const,
      selection: { evidenceRef: 'record-1', start: 6, end: 11, quote: 'Alpha' },
    }] }], organization: { knowledgeKind: 'fact' as const } } };
  const source = revision.content.segments[0].evidence[0].source;
  const entity = { entityId: uuid(4), label: 'Alpha', description: '本来源谈到的项目', qualifiers: ['选定来源'],
    identityStatus: 'proposed' as const, possibleEntityIds: [], uncertainties: [], referentKind: 'object' as const, componentRef: null, collection: null };
  const mentions = [{ mentionId: uuid(5), entityId: entity.entityId, selection: { evidenceRef: 'record-1', start: 0, end: 5, quote: 'Alpha' }, basis: 'explicit' as const, rationale: '首次名称' },
    { mentionId: uuid(6), entityId: entity.entityId, selection: { evidenceRef: 'record-1', start: 6, end: 11, quote: 'Alpha' }, basis: 'inference' as const, rationale: '第二次名称，保持精确位置' }];
  const excerpts = [{ evidenceRef: 'record-1', text: 'Alpha；Alpha\n<script>来源原文</script>', recordIndex: 0, eventKind: 'message', role: 'user' }];
  const entityRevision = { revisionId: uuid(8), entities: [entity], mentions, limitations: ['仅选定消息'], revisedAt: at,
    revisedBy: { actorKind: 'human' as const, actorId: 'reviewer' }, revisionReason: '核对窗口内身份' };
  const analysis: KnowledgeEntityAnalysisDetail = { history: { storeKind: 'entity-analysis-history', schemaVersion: 2, analysisId: uuid(7), ...source,
    generation: 1, writeHeadRevisionId: entityRevision.revisionId, revisions: [entityRevision], receipts: [] }, revision: entityRevision, source: { status: 'available', excerpts, limitations: [] } };
  const bodyRef = { knowledgeId: revision.knowledgeId, revisionId: revision.revisionId, bodyDigest: revision.bodyDigest };
  const association = { revisionId: uuid(9), bodyRef, status: 'available' as const, reviewStatus: 'pending' as const,
    catalogRefs: [{ analysisId: analysis.history.analysisId, entityRevisionId: entityRevision.revisionId }],
    segmentEntityRefs: [{ segmentId: 's1', analysisId: analysis.history.analysisId, entityRevisionId: entityRevision.revisionId, entityId: entity.entityId, mentionIds: [mentions[0].mentionId] }],
    issues: [], revisedAt: at, revisedBy: { actorKind: 'human' as const, actorId: 'reviewer' }, revisionReason: '原映射' };
  const detail: KnowledgeCandidateDetail = { revision, history: { storeKind: 'knowledge-item-history', schemaVersion: 3, namespace: 'fixture',
    knowledgeId: revision.knowledgeId, generation: 2, writeHeadRevisionId: revision.revisionId, revisions: [revision], maintenance: [], receipts: [] },
    maintenance: { revisionId: revision.revisionId, choice: 'retain', reason: '愿意维护，未独立验证', actor: { actorKind: 'human', actorId: 'reviewer' }, at },
    reviewStatus: 'pending', tagging: { generation: 0, tags: [] },
    derivedAssociations: { status: 'available', reviewStatus: 'pending', bodyRef, generation: 1, headRevisionId: association.revisionId, revision: association },
    derivedCatalogs: [{ status: 'available', analysisId: analysis.history.analysisId, entityRevisionId: entityRevision.revisionId, currentHeadRevisionId: entityRevision.revisionId,
      snapshotId: source.snapshotId, sourceVersion: source.sourceVersion, entities: [entity], mentions }],
    sources: [{ status: 'available', window: { ...source, sourcePath: '/fixture-only', sourceKind: 'codex', projectionVersion: 'knowledge-window-v2', capturedAt: at,
      startRecord: 0, endRecord: 0, excerpts, records: [{ recordIndex: 0, raw: '原始记录夹具' }], limitations: ['仅选定消息'], origin: { threadId: uuid(15), title: '项目接续记录' } } }] };
  const graph: KnowledgeGraph = { projectionKind: 'knowledge-graph', schemaVersion: 1, scope: { knowledgeIds: [revision.knowledgeId], includeHistory: false },
    coverage: { status: 'available', gaps: [] }, nodes: [
      { nodeKind: 'knowledge', nodeId: 'knowledge-current', bodyRef, current: true, title: revision.title, choice: 'retain', reviewStatus: 'pending', revisedAt: at,
        revisionReason: '首次保存', segments: revision.content.segments, association: { status: 'available', reviewStatus: 'pending', revisionId: association.revisionId, bodyRef, issues: [] } },
      { ...entity, nodeKind: 'entity', nodeId: 'entity-window-1', analysisId: analysis.history.analysisId, entityRevisionId: entityRevision.revisionId, current: true },
      { nodeKind: 'source', nodeId: 'source-window-1', ...source, status: 'available', origin: { threadId: uuid(15), title: '项目接续记录' }, limitations: ['仅选定消息'] },
    ], edges: [
      { edgeKind: 'segment_entity', edgeId: 'mapping-current', from: 'knowledge-current', to: 'entity-window-1', current: true, projectionRevisionId: association.revisionId,
        segmentId: 's1', mentionIds: [mentions[0].mentionId], reviewStatus: 'pending', catalogCurrent: true, mentions: [mentions[0]] },
      ...mentions.map(mention => ({ edgeKind: 'entity_mention' as const, edgeId: `mention-${mention.mentionId}`, from: 'entity-window-1', to: 'source-window-1', current: true,
        mentionId: mention.mentionId, selection: mention.selection, basis: mention.basis, rationale: mention.rationale, positionStatus: 'matched' as const })),
      { edgeKind: 'source_evidence', edgeId: 'source-evidence', from: 'knowledge-current', to: 'source-window-1', current: true, segmentId: 's1', evidence: revision.content.segments[0].evidence[0], positionStatus: 'matched' },
    ] };
  const catalog: KnowledgeLibraryKnowledge = { objects: [], rows: [{ knowledgeId: revision.knowledgeId, revisionId: revision.revisionId,
    bodyDigest: revision.bodyDigest, generation: 2, title: revision.title, knowledgeKind: 'fact', reviewStatus: 'pending', choice: 'retain', revisedAt: at, objects: [] }] };
  return { detail, graph, analysis, catalog, mentions, source };
}
function absentReviews(detail: KnowledgeCandidateDetail): KnowledgeReviewStatus {
  const { knowledgeId, revisionId, bodyDigest } = detail.revision;
  const sources = [...new Map<string, KnowledgeReviewStatus['sources'][number]>(detail.revision.content.segments.flatMap(segment => segment.evidence).map(evidence => [`${evidence.source.snapshotId}/${evidence.source.sourceVersion}`, { ...evidence.source, status: 'available' as const }] as const)).values()];
  return { storageStatus: 'absent', bodyRef: { knowledgeId, revisionId, bodyDigest }, generation: 0, headEventId: null, sources, history: null,
    content: { status: 'not_reviewed', events: [] }, coverage: { status: 'not_reviewed', projectionRevisionId: detail.derivedAssociations.revision?.revisionId ?? null,
      events: [], decisions: detail.revision.content.segments.map(segment => ({ segmentId: segment.segmentId, status: 'unknown', opinions: [] })) }, usage: [] };
}
function crowdedGraph() {
  const data = fixture(), entity = data.graph.nodes.find(node => node.nodeKind === 'entity')!;
  const mapping = data.graph.edges.find(edge => edge.edgeKind === 'segment_entity')!;
  for (let index = 1; index < 17; index++) {
    const nodeId = `entity-window-${index + 1}`;
    data.graph.nodes.push({ ...entity, nodeId });
    data.graph.edges.push({ ...mapping, edgeId: `mapping-${index + 1}`, to: nodeId });
  }
  return data;
}
/** JSDOM has no layout: model SVG transforms and canvas scrolling at the DOM boundary. */
function graphViewport(width = 600, height = 400) {
  const size = { width, height }, observers: { callback: () => void; disconnect: ReturnType<typeof vi.fn>; observe: ReturnType<typeof vi.fn> }[] = [];
  const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('knowledge-network-canvas') ? size.width : 0; });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('knowledge-network-canvas') ? size.height : 0; });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.classList.contains('knowledge-network-canvas')) return rect(100, 200, size.width, size.height);
    if (this.classList.contains('knowledge-network-node') && size.width && size.height) {
      const canvas = this.closest<HTMLElement>('.knowledge-network-canvas')!;
      const [, x, y] = /translate\((\d+) (\d+)\)/.exec(this.getAttribute('transform')!)!;
      return rect(100 + Number(x) - 96 - canvas.scrollLeft, 200 + Number(y) - 26 - canvas.scrollTop, 192, 52);
    }
    return rect(0, 0, 0, 0);
  });
  vi.stubGlobal('ResizeObserver', class {
    observe = vi.fn(); disconnect = vi.fn();
    constructor(callback: () => void) { observers.push({ callback, observe: this.observe, disconnect: this.disconnect }); }
  });
  return { size, observers, resize: () => act(() => { observers.forEach(observer => observer.callback()); }) };
}
function expectVisibleInCanvas(node: Element, canvas: HTMLElement) {
  const bounds = node.getBoundingClientRect(), viewport = canvas.getBoundingClientRect();
  expect(bounds.top).toBeGreaterThanOrEqual(viewport.top); expect(bounds.bottom).toBeLessThanOrEqual(viewport.bottom);
  expect(bounds.left).toBeGreaterThanOrEqual(viewport.left); expect(bounds.right).toBeLessThanOrEqual(viewport.right);
}
function wrapper({ children }: PropsWithChildren) { return <ConfigProvider theme={{ token: { motion: false } }}>{children}</ConfigProvider>; }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }));
  const computed = window.getComputedStyle.bind(window); vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computed(element));
  window.history.replaceState(null, '', '/knowledge/library');
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('knowledge graph browsing and evidence', () => {
  it('reveals the current knowledge in a tall neighborhood without scrolling the page or changing selection', () => {
    const { graph, detail } = crowdedGraph(), viewport = graphViewport(280), choose = vi.fn();
    const pageScroll = vi.spyOn(window, 'scrollTo');
    render(<KnowledgeGraphView graph={graph} lang="zh" activeKnowledgeId={detail.revision.knowledgeId} selectedId="mapping-current" scope="current" includeHistory={false} onScope={vi.fn()} onHistory={vi.fn()} onSelect={choose}/>);
    const canvas = screen.getByLabelText('可滚动图谱画布'), node = screen.getByRole('button', { name: /^知识：保存可核对的项目认识/ });
    expect(canvas.scrollTop).toBeGreaterThan(0); expect(canvas.scrollLeft).toBeGreaterThan(0);
    expectVisibleInCanvas(node, canvas);
    expect(screen.getByRole('combobox', { name: '选择图谱关联' })).toHaveProperty('value', 'mapping-current');
    expect(choose).not.toHaveBeenCalled(); expect(pageScroll).not.toHaveBeenCalled(); expect(viewport.observers).toHaveLength(0);
  });

  it('preserves manual scrolling through selection and projection refreshes, and reveals explicit knowledge, revision and scope changes', () => {
    const { graph, detail } = crowdedGraph(); graphViewport();
    const knowledge = graph.nodes.find(node => node.nodeKind === 'knowledge')!;
    if (knowledge.nodeKind !== 'knowledge') throw new Error('Missing knowledge fixture');
    graph.nodes.push({ ...knowledge, nodeId: 'knowledge-other', title: '另一份知识', bodyRef: { ...knowledge.bodyRef, knowledgeId: uuid(80) } },
      { ...knowledge, nodeId: 'knowledge-history', title: '原知识的历史修订', current: false, bodyRef: { ...knowledge.bodyRef, revisionId: uuid(81) } });
    const props = { graph, lang: 'zh' as const, activeKnowledgeId: detail.revision.knowledgeId, scope: 'filtered' as const, includeHistory: false, onScope: vi.fn(), onHistory: vi.fn(), onSelect: vi.fn() };
    const view = render(<KnowledgeGraphView {...props}/>), canvas = screen.getByLabelText('可滚动图谱画布');
    canvas.scrollTop = 0;
    view.rerender(<KnowledgeGraphView {...props} selectedId="mapping-current" lang="en" graph={structuredClone(graph)}/>);
    expect(canvas.scrollTop).toBe(0);
    view.rerender(<KnowledgeGraphView {...props} activeKnowledgeId={uuid(80)}/>);
    expectVisibleInCanvas(screen.getByRole('button', { name: /^知识：另一份知识/ }), canvas);
    canvas.scrollTop = 0;
    view.rerender(<KnowledgeGraphView {...props} activeRevisionId={uuid(81)}/>);
    expectVisibleInCanvas(screen.getByRole('button', { name: /^知识：原知识的历史修订/ }), canvas);
    view.rerender(<KnowledgeGraphView {...props}/>);
    canvas.scrollTop = 0;
    view.rerender(<KnowledgeGraphView {...props} scope="current"/>);
    expectVisibleInCanvas(screen.getByRole('button', { name: /^知识：保存可核对的项目认识/ }), canvas);
    canvas.scrollTop = 0;
    view.rerender(<KnowledgeGraphView {...props} scope="current" includeHistory/>);
    expectVisibleInCanvas(screen.getByRole('button', { name: /^知识：保存可核对的项目认识/ }), canvas);
  });

  it('waits for a hidden canvas to become visible and stops observing after its first reveal', () => {
    const { graph, detail } = crowdedGraph(), viewport = graphViewport(280, 0);
    const view = render(<KnowledgeGraphView graph={graph} lang="zh" activeKnowledgeId={detail.revision.knowledgeId} scope="current" includeHistory={false} onScope={vi.fn()} onHistory={vi.fn()} onSelect={vi.fn()}/>);
    const canvas = screen.getByLabelText('可滚动图谱画布');
    expect(canvas.scrollTop).toBe(0); expect(viewport.observers).toHaveLength(1);
    const observer = viewport.observers[0]; expect(observer.observe).toHaveBeenCalledWith(canvas);
    viewport.resize(); expect(observer.disconnect).not.toHaveBeenCalled();
    viewport.size.height = 400; viewport.resize();
    expectVisibleInCanvas(screen.getByRole('button', { name: /^知识：保存可核对的项目认识/ }), canvas);
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
    canvas.scrollTop = 0; viewport.resize(); expect(canvas.scrollTop).toBe(0);
    view.unmount(); expect(observer.disconnect).toHaveBeenCalledTimes(2);
  });

  it('disconnects a pending reveal on view change and unmount, and ignores already queued observer callbacks', () => {
    const { graph, detail } = crowdedGraph(), viewport = graphViewport(600, 0);
    const props = { graph, lang: 'zh' as const, activeKnowledgeId: detail.revision.knowledgeId, scope: 'current' as const, includeHistory: false, onScope: vi.fn(), onHistory: vi.fn(), onSelect: vi.fn() };
    const view = render(<KnowledgeGraphView {...props}/>), canvas = screen.getByLabelText('可滚动图谱画布');
    view.rerender(<KnowledgeGraphView {...props} scope="filtered"/>);
    expect(viewport.observers[0].disconnect).toHaveBeenCalledOnce(); expect(viewport.observers).toHaveLength(2);
    viewport.size.height = 400;
    act(() => viewport.observers[0].callback()); expect(canvas.scrollTop).toBe(0);
    view.unmount(); expect(viewport.observers[1].disconnect).toHaveBeenCalledOnce();
    viewport.resize(); expect(canvas.scrollTop).toBe(0);
  });

  it('keeps manual scrolling when library selection pins the same current revision through an edge or entity', async () => {
    const data = crowdedGraph(), calls: Record<string, unknown>[] = []; graphViewport();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const call = JSON.parse(String(init.body)); calls.push(call);
      const value = call.operation === 'knowledge' ? data.catalog : call.operation === 'graph' ? data.graph
        : call.operation === 'review-status' ? absentReviews(data.detail) : data.detail;
      return new Response(JSON.stringify(value), { status: 200 });
    }));
    render(<KnowledgeLibrary lang="zh" initialWorkspace="/same-graph-body" knowledgeId={data.detail.revision.knowledgeId} initialView="graph"/>, { wrapper });
    const canvas = await screen.findByLabelText('可滚动图谱画布');
    expectVisibleInCanvas(screen.getByRole('button', { name: /^知识：保存可核对的项目认识/ }), canvas);
    expect(new URLSearchParams(window.location.search).has('revision')).toBe(false);
    canvas.scrollTop = 0; canvas.scrollLeft = 20;
    fireEvent.change(screen.getByRole('combobox', { name: '选择图谱关联' }), { target: { value: 'mapping-current' } });
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('revision')).toBe(data.detail.revision.revisionId));
    expect(screen.getByLabelText('可滚动图谱画布')).toBe(canvas); expect(canvas.scrollTop).toBe(0); expect(canvas.scrollLeft).toBe(20);
    expect(calls.filter(call => call.operation === 'show').at(-1)).toMatchObject({ id: data.detail.revision.knowledgeId, revision: data.detail.revision.revisionId });
    fireEvent.keyDown(screen.getAllByRole('button', { name: /^实体：Alpha/ })[0], { key: 'Enter' });
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('selection')).toBe('entity-window-1'));
    expect(screen.getByRole('combobox', { name: '选择图谱节点' })).toHaveProperty('value', 'entity-window-1');
    expect(canvas.scrollTop).toBe(0); expect(canvas.scrollLeft).toBe(20);
  });

  it('retains the mounted canvas and manual scroll while library and graph refreshes finish at different times', async () => {
    const data = crowdedGraph(); graphViewport();
    let delayed = false;
    const pending = new Map<string, (response: Response) => void>();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const call = JSON.parse(String(init.body));
      if (delayed && ['knowledge', 'graph'].includes(call.operation)) return new Promise<Response>(resolve => pending.set(call.operation, resolve));
      const value = call.operation === 'knowledge' ? data.catalog : call.operation === 'graph' ? data.graph
        : call.operation === 'review-status' ? absentReviews(data.detail) : data.detail;
      return new Response(JSON.stringify(value), { status: 200 });
    }));
    render(<KnowledgeLibrary lang="zh" initialWorkspace="/refresh-graph" knowledgeId={data.detail.revision.knowledgeId} initialView="graph" initialGraphSelection="mapping-current"/>, { wrapper });
    const canvas = await screen.findByLabelText('可滚动图谱画布'), directory = screen.getByRole('complementary', { name: '知识图谱目录' });
    await waitFor(() => expect(directory.getAttribute('aria-busy')).toBe('false'));
    canvas.scrollTop = 0; canvas.scrollLeft = 20; delayed = true;
    fireEvent.click(screen.getByRole('button', { name: /^刷\s*新$/ }));
    await waitFor(() => { expect(pending.has('knowledge')).toBe(true); expect(pending.has('graph')).toBe(true); });
    expect(directory.getAttribute('aria-busy')).toBe('true'); expect(screen.getByText('正在刷新图谱，当前显示上次读取的关联。')).toBeTruthy();
    expect(screen.getByLabelText('可滚动图谱画布')).toBe(canvas); expect(canvas.scrollTop).toBe(0);
    await act(async () => pending.get('graph')!(new Response(JSON.stringify(structuredClone(data.graph)), { status: 200 })));
    expect(directory.getAttribute('aria-busy')).toBe('true'); expect(screen.getByLabelText('可滚动图谱画布')).toBe(canvas); expect(canvas.scrollTop).toBe(0);
    await act(async () => pending.get('knowledge')!(new Response(JSON.stringify(data.catalog), { status: 200 })));
    await waitFor(() => expect(directory.getAttribute('aria-busy')).toBe('false'));
    expect(screen.queryByText('正在刷新图谱，当前显示上次读取的关联。')).toBeNull();
    expect(screen.getByLabelText('可滚动图谱画布')).toBe(canvas); expect(canvas.scrollTop).toBe(0); expect(canvas.scrollLeft).toBe(20);
    expect(screen.getByRole('combobox', { name: '选择图谱关联' })).toHaveProperty('value', 'mapping-current');
  });

  it('removes stale graph content after a failed refresh or an empty catalog, and keeps graph retry usable', async () => {
    const data = crowdedGraph(); graphViewport();
    let failGraph = false, emptyCatalog = false;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const call = JSON.parse(String(init.body));
      if (call.operation === 'graph' && failGraph) return new Response(JSON.stringify({ error: 'knowledge_request_failed' }), { status: 500 });
      const value = call.operation === 'knowledge' ? emptyCatalog ? { objects: [], rows: [] } : data.catalog
        : call.operation === 'graph' ? call.knowledgeIds.length ? data.graph : { ...data.graph, scope: { knowledgeIds: [], includeHistory: false }, nodes: [], edges: [] }
          : call.operation === 'review-status' ? absentReviews(data.detail) : data.detail;
      return new Response(JSON.stringify(value), { status: 200 });
    }));
    render(<KnowledgeLibrary lang="zh" initialWorkspace="/failed-graph-refresh" knowledgeId={data.detail.revision.knowledgeId} initialView="graph"/>, { wrapper });
    await screen.findByLabelText('可滚动图谱画布');
    failGraph = true; fireEvent.click(screen.getByRole('button', { name: /^刷\s*新$/ }));
    const retry = await screen.findByRole('button', { name: '重新读取图谱' });
    expect(screen.queryByLabelText('可滚动图谱画布')).toBeNull();
    failGraph = false; fireEvent.click(retry);
    const canvas = await screen.findByLabelText('可滚动图谱画布');
    expectVisibleInCanvas(screen.getByRole('button', { name: /^知识：保存可核对的项目认识/ }), canvas);
    emptyCatalog = true; fireEvent.click(screen.getByRole('button', { name: /^刷\s*新$/ }));
    await screen.findByText('当前筛选没有可浏览的知识。');
    expect(screen.queryByLabelText('可滚动图谱画布')).toBeNull(); expect(screen.queryByRole('button', { name: /^知识：保存可核对的项目认识/ })).toBeNull();
  });

  it('opens a retrieved historical body and exact evidence even after the catalog head changes', async () => {
    const data = fixture(), calls: Record<string, unknown>[] = [];
    const latest = structuredClone(data.detail); latest.revision.revisionId = uuid(200); latest.history.writeHeadRevisionId = uuid(200);
    latest.revision.content.segments[0].text = 'A newer revision is not the returned search snapshot.';
    const catalog = structuredClone(data.catalog); catalog.rows[0].revisionId = latest.revision.revisionId;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const call = JSON.parse(String(init.body)); calls.push(call);
      let value: unknown;
      if (call.operation === 'knowledge') value = catalog;
      else if (call.operation === 'retrieve') value = { projectionKind: 'knowledge-body-segments', schemaVersion: 2,
        rankingPolicyId: 'knowledge-body-literal-topic-priority/v3', omitted: { oversizedSegments: 0, budgetSegments: 0 },
        knowledge: [{ bodyRef: data.detail.derivedAssociations.bodyRef, generation: 1, title: data.detail.revision.title, choice: 'retain', reviewStatus: 'pending',
          segmentScope: { returned: 1, total: 1 }, derivedAssociations: data.detail.derivedAssociations }],
        sources: [{ ...data.source, status: 'available', sourceKind: 'codex' }],
        items: [{ knowledge: 0, segmentIndex: 0, segment: data.detail.revision.content.segments[0], evidenceChecks: [{ evidenceIndex: 0, source: 0, positionStatus: 'matched' }] }] };
      else if (call.operation === 'review-status') value = absentReviews(data.detail);
      else if (call.operation === 'show') value = call.revision === data.detail.revision.revisionId ? data.detail : latest;
      else throw new Error(`Unexpected operation ${call.operation}`);
      return new Response(JSON.stringify(value), { status: 200 });
    }));
    const mounted = render(<KnowledgeLibrary lang="en" initialWorkspace="/task-snapshot" initialView="task"/>, { wrapper });
    fireEvent.change(await screen.findByRole('textbox', { name: 'Question for the current task' }), { target: { value: 'When does Alpha apply?' } });
    expect(document.querySelector('.knowledge-workbench')?.classList.contains('knowledge-directory-open')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Find applicable knowledge' }));
    await screen.findByRole('button', { name: 'Open complete content' });
    fireEvent.click(screen.getByRole('button', { name: 'Open complete content' }));
    await waitFor(() => expect(document.querySelector('.knowledge-reader .knowledge-segment-text')?.textContent).toBe(data.detail.revision.content.segments[0].text));
    expect(calls.filter(call => call.operation === 'show')).toEqual([expect.objectContaining({ id: data.detail.revision.knowledgeId, revision: data.detail.revision.revisionId })]);
    expect(new URLSearchParams(window.location.search).get('revision')).toBe(data.detail.revision.revisionId);
    expect(new URLSearchParams(window.location.search).get('view')).toBe('task');
    fireEvent.click(screen.getByText('Inspect evidence and exact revision'));
    fireEvent.click(screen.getByRole('button', { name: 'Open exact evidence' }));
    await waitFor(() => expect(document.querySelector('.knowledge-reader pre.knowledge-source mark')?.textContent).toBe('Alpha'));
    const params = new URLSearchParams(window.location.search);
    expect(params.get('revision')).toBe(data.detail.revision.revisionId); expect(params.get('segment')).toBe('s1');
    expect(JSON.parse(params.get('evidence')!)).toEqual({ ...data.source, evidenceRef: 'record-1', start: 6, end: 11 });
    mounted.unmount();
    render(<KnowledgeLibrary lang="en" initialWorkspace="/task-snapshot" initialView="task" knowledgeId={data.detail.revision.knowledgeId}
      initialKnowledgeRevision={params.get('revision')!} initialReaderTab="evidence" initialSegmentId="s1"
      initialEvidence={JSON.parse(params.get('evidence')!)}/>, { wrapper });
    await waitFor(() => expect(document.querySelector('.knowledge-reader pre.knowledge-source mark')?.textContent).toBe('Alpha'));
    expect(document.querySelector('.knowledge-workbench')?.classList.contains('knowledge-directory-open')).toBe(false);
    await screen.findByText(/Content review: Not reviewed/);
    expect(calls.some(call => call.operation === 'review-status')).toBe(true);
    expect(calls.every(call => ['knowledge', 'retrieve', 'show', 'review-status'].includes(String(call.operation)))).toBe(true);
  });

  it('keeps failed and replacement projection records readable after a correction', () => {
    const { graph, detail } = fixture();
    const node = graph.nodes.find(node => node.nodeKind === 'knowledge');
    if (!node || node.nodeKind !== 'knowledge') throw new Error('Missing knowledge fixture');
    node.associationHistory = [
      { revisionId: uuid(80), bodyRef: node.bodyRef, status: 'failed', reviewStatus: 'pending', issues: ['duplicate_mention_position'], revisedAt: at, revisionReason: '原目录拒收仍保留' },
      { revisionId: uuid(81), parentRevisionId: uuid(80), bodyRef: node.bodyRef, status: 'available', reviewStatus: 'pending', issues: [], revisedAt: at, revisionReason: '明确核对来源后补足映射' },
    ];
    render(<KnowledgeGraphInspection graph={graph} selectedId={node.nodeId} detail={detail} loading={false} workspace="/isolated" lang="zh" onLocate={vi.fn()} onEntity={vi.fn()} onMapping={vi.fn()} onKnowledge={vi.fn()}/>);
    fireEvent.click(screen.getByText('关联修订历史'));
    expect(screen.getByText(/原目录拒收仍保留/)).toBeTruthy();
    expect(screen.getByText(/明确核对来源后补足映射/)).toBeTruthy();
    expect(screen.getAllByText(uuid(80)).length).toBeGreaterThan(0);
    expect(screen.getByText(uuid(81))).toBeTruthy();
  });
  it('keeps failed, stale and same-name window identities selectable, with keyboard equivalents and exact owner callbacks', () => {
    const { graph, detail } = fixture(), choose = vi.fn();
    const knowledge = graph.nodes.find(node => node.nodeKind === 'knowledge')!;
    const entity = graph.nodes.find(node => node.nodeKind === 'entity')!;
    if (knowledge.nodeKind !== 'knowledge' || entity.nodeKind !== 'entity') throw new Error('Invalid fixture');
    graph.nodes.push({ ...entity, nodeId: 'entity-other-window', analysisId: uuid(70), entityId: uuid(71) },
      { ...knowledge, nodeId: 'knowledge-failed', title: '关联失败但正文可读', bodyRef: { ...knowledge.bodyRef, knowledgeId: uuid(72) }, association: { status: 'failed', reviewStatus: 'pending', issues: [] } },
      { ...knowledge, nodeId: 'knowledge-stale', title: '正文更新但旧关联保留', bodyRef: { ...knowledge.bodyRef, knowledgeId: uuid(73) }, association: { status: 'stale', reviewStatus: 'pending', issues: [] } });
    graph.coverage = { status: 'unavailable', gaps: [{ gapKind: 'association_failed', detail: 'A saved association is incomplete.' }] };
    render(<KnowledgeGraphView graph={graph} lang="zh" activeKnowledgeId={detail.revision.knowledgeId} scope="filtered" includeHistory={false} onScope={vi.fn()} onHistory={vi.fn()} onSelect={choose}/>);
    expect(screen.getByRole('button', { name: /知识：关联失败但正文可读/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /知识：正文更新但旧关联保留/ })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^实体：Alpha/ })).toHaveLength(2);
    expect(screen.getByRole('status').textContent).toContain('覆盖不完整');
    fireEvent.keyDown(screen.getByRole('button', { name: /知识：关联失败但正文可读/ }), { key: 'Enter' });
    expect(choose).toHaveBeenLastCalledWith('knowledge-failed', expect.objectContaining({ knowledgeId: uuid(72) }));
    fireEvent.change(screen.getByRole('combobox', { name: '选择图谱关联' }), { target: { value: 'mapping-current' } });
    expect(choose).toHaveBeenLastCalledWith('mapping-current', { knowledgeId: detail.revision.knowledgeId, revisionId: detail.revision.revisionId });
    expect(screen.getByRole('group', { name: '知识、实体和来源的关联图' }).tagName).toBe('svg');
  });

  it('opens the exact repeated source span, keeps source text escaped, and carries entity/revision context into correction', () => {
    const { graph, detail, analysis } = fixture(), locate = vi.fn(), entity = vi.fn(), mapping = vi.fn();
    render(<KnowledgeGraphInspection graph={graph} selectedId="source-evidence" detail={detail} loading={false} workspace="/isolated" lang="zh" onLocate={locate} onEntity={entity} onMapping={mapping} onKnowledge={vi.fn()}/>);
    fireEvent.click(screen.getByText('展开这处依据的完整原文'));
    expect(document.querySelector('.knowledge-network-citation mark')?.textContent).toBe('Alpha');
    expect(document.querySelector('.knowledge-network-citation pre')?.textContent).toBe('Alpha；Alpha\n<script>来源原文</script>');
    expect(document.querySelector('.knowledge-network-citation script')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '在阅读器回查依据' }));
    expect(locate).toHaveBeenLastCalledWith(expect.objectContaining({ tab: 'evidence', segmentId: 's1', evidence: expect.objectContaining({ start: 6, end: 11 }) }));
    cleanup();
    render(<KnowledgeGraphInspection graph={graph} selectedId="mapping-current" detail={detail} loading={false} workspace="/isolated" lang="zh" onLocate={locate} onEntity={entity} onMapping={mapping} onKnowledge={vi.fn()}/>);
    fireEvent.click(screen.getByRole('button', { name: '核对／纠正此实体' }));
    expect(entity).toHaveBeenCalledWith({ analysisId: analysis.history.analysisId, entityRevisionId: analysis.revision.revisionId, entityId: analysis.revision.entities[0].entityId });
    fireEvent.click(screen.getByRole('button', { name: '纠正段落映射' }));
    expect(mapping).toHaveBeenCalledWith({ analysisId: analysis.history.analysisId, entityRevisionId: analysis.revision.revisionId });
  });

  it('distinguishes an unloaded historical source from unavailable evidence', () => {
    const { graph, detail } = fixture(); detail.sources = [];
    render(<KnowledgeGraphInspection graph={graph} selectedId="source-evidence" detail={detail} loading={false} workspace="/isolated" lang="zh" onLocate={vi.fn()} onEntity={vi.fn()} onMapping={vi.fn()} onKnowledge={vi.fn()}/>);
    expect(screen.getByText('此来源原文尚未载入当前正文；可先打开对应的精确知识修订。')).toBeTruthy();
    expect(screen.queryByText('原文不可用，不能完整核对。')).toBeNull();
  });

  it('keeps collection rationale, exact mention evidence, identity candidates and revision lineage distinct', () => {
    const { graph, detail } = fixture(), entity = graph.nodes.find(node => node.nodeKind === 'entity')!;
    if (entity.nodeKind !== 'entity') throw new Error('Invalid fixture');
    graph.nodes.push({ ...entity, nodeId: 'member', entityId: uuid(61), label: '集合成员' });
    graph.edges.push({ edgeKind: 'collection', edgeId: 'collection-link', from: entity.nodeId, to: 'member', current: true,
      mentionIds: [uuid(5)], rationale: '仅有这一处原文支持部分成员 <script>', completeness: 'partial' },
    { edgeKind: 'possible_identity', edgeId: 'identity-candidate', from: entity.nodeId, to: 'member', current: true },
    { edgeKind: 'revision_parent', edgeId: 'entity-lineage', from: entity.nodeId, to: 'member', current: false, revisionDomain: 'entity' });
    const props = { graph, detail, loading: false, workspace: '/isolated', lang: 'zh' as const, onLocate: vi.fn(), onEntity: vi.fn(), onMapping: vi.fn(), onKnowledge: vi.fn() };
    const view = render(<KnowledgeGraphInspection {...props} selectedId="collection-link"/>);
    expect(screen.getByText('仅有这一处原文支持部分成员 <script>')).toBeTruthy();
    expect(screen.getByText(/仅部分成员已知/).textContent).toContain('集合知识不会自动归属每个成员');
    expect(screen.getByText('首次名称', { exact: false })).toBeTruthy();
    expect(document.querySelector('.knowledge-network-inspection script')).toBeNull();
    view.rerender(<KnowledgeGraphInspection {...props} selectedId="identity-candidate"/>);
    expect(screen.getByText('这只是可能对应的候选，不确认二者为同一对象。')).toBeTruthy();
    view.rerender(<KnowledgeGraphInspection {...props} selectedId="entity-lineage"/>);
    expect(screen.getByText('仅表示修订前后沿袭，不是知识关系或身份确认。')).toBeTruthy();
  });

  it('walks from graph evidence to explicit mapping save and reopens the readback with URL filters and unchanged canonical content', async () => {
    const data = fixture(); let persisted = structuredClone(data.detail), persistedGraph = structuredClone(data.graph);
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const call = JSON.parse(String(init.body)) as Record<string, unknown>; calls.push(call);
      let value: unknown;
      if (call.operation === 'knowledge') value = data.catalog;
      else if (call.operation === 'graph') value = persistedGraph;
      else if (call.operation === 'show') value = persisted;
      else if (call.operation === 'review-status') value = absentReviews(persisted);
      else if (call.operation === 'entities') value = data.analysis;
      else if (call.operation === 'association-catalogs') value = { bodyRef: persisted.derivedAssociations.bodyRef, unavailableAnalyses: 0,
        sources: [{ ...data.source, status: 'available' }], catalogs: [{ analysisId: data.analysis.history.analysisId, ...data.source,
          writeHeadRevisionId: data.analysis.revision.revisionId, sourceSummary: { title: '项目接续记录', sourceKind: 'codex', excerptCount: 1, firstRecordIndex: 0, lastRecordIndex: 0 },
          revisions: [{ revisionId: data.analysis.revision.revisionId, revisionReason: '核对窗口内身份', revisedAt: at, entityCount: 1, mentionCount: 2 }] }] };
      else if (call.operation === 'apply-associations') {
        persisted = structuredClone(persisted);
        persisted.derivedAssociations.generation = 2; persisted.derivedAssociations.headRevisionId = uuid(20);
        persisted.derivedAssociations.revision = { ...persisted.derivedAssociations.revision!, revisionId: uuid(20), parentRevisionId: uuid(9), revisionReason: String(call.reason),
          segmentEntityRefs: [{ segmentId: 's1', analysisId: data.analysis.history.analysisId, entityRevisionId: data.analysis.revision.revisionId, entityId: uuid(4), mentionIds: [uuid(5), uuid(6)] }] };
        persistedGraph = structuredClone(persistedGraph);
        const mapping = persistedGraph.edges.find(edge => edge.edgeKind === 'segment_entity')!;
        if (mapping.edgeKind === 'segment_entity') { mapping.edgeId = 'mapping-corrected'; mapping.projectionRevisionId = uuid(20); mapping.mentionIds = [uuid(5), uuid(6)]; mapping.mentions = data.mentions; }
        value = persisted;
      } else throw new Error(`Unexpected operation: ${call.operation}`);
      return new Response(JSON.stringify(value), { status: 200 });
    }));
    const view = render(<KnowledgeLibrary lang="zh" initialWorkspace="/isolated" knowledgeId={data.detail.revision.knowledgeId} initialView="graph" initialGraphScope="filtered" initialChoice="retain"/>, { wrapper });
    const graphLinks = await screen.findByRole('combobox', { name: '选择图谱关联' });
    fireEvent.change(graphLinks, { target: { value: 'mapping-current' } });
    await waitFor(() => expect(screen.getByRole('button', { name: '纠正段落映射' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '纠正段落映射' }));
    await screen.findByRole('combobox', { name: '明确选择实体修订' });
    expect(screen.queryByRole('textbox', { name: '实体分析 ID' })).toBeNull();
    const group = screen.getByRole('group', { name: `段落 1 / ${uuid(4)}` });
    fireEvent.click(within(group).getAllByRole('checkbox')[1]);
    fireEvent.change(screen.getByRole('textbox', { name: '映射修改理由' }), { target: { value: '核对同一消息中第二次准确提及' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /^本次只保存实体映射/ }));
    fireEvent.click(screen.getByRole('button', { name: '保存待核对映射' }));
    await waitFor(() => expect(calls.filter(call => call.operation === 'apply-associations')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '映射修改理由' })).toBeNull());
    expect(persisted.revision).toEqual(data.detail.revision); expect(persisted.maintenance).toEqual(data.detail.maintenance);
    expect(calls.find(call => call.operation === 'apply-associations')).toMatchObject({ revision: data.detail.revision.revisionId, bodyDigest: data.detail.revision.bodyDigest, generation: 1,
      draft: { catalogRefs: [{ analysisId: data.analysis.history.analysisId, entityRevisionId: data.analysis.revision.revisionId }], segmentEntityRefs: [{ segmentId: 's1', analysisId: data.analysis.history.analysisId, entityRevisionId: data.analysis.revision.revisionId, entityId: uuid(4), mentionIds: [uuid(5), uuid(6)] }] } });
    await waitFor(() => expect(document.querySelector(`.knowledge-reader [data-mention-id="${uuid(6)}"]`)).not.toBeNull());
    fireEvent.click(within(document.querySelector<HTMLElement>(`.knowledge-reader [data-mention-id="${uuid(6)}"]`)!).getByRole('button', { name: '回查这处提及的原文' }));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('section')).toBe('evidence'));
    const params = new URLSearchParams(window.location.search);
    expect(params.get('view')).toBe('graph'); expect(params.get('scope')).toBe('filtered'); expect(params.get('choice')).toBe('retain');
    expect(JSON.parse(params.get('catalog')!)).toEqual({ analysisId: data.analysis.history.analysisId, entityRevisionId: data.analysis.revision.revisionId });
    expect(params.get('mention')).toBe(uuid(6)); expect(params.get('segment')).toBe('s1');
    expect(JSON.parse(params.get('evidence')!)).toEqual({ ...data.source, evidenceRef: 'record-1', start: 6, end: 11 });
    view.unmount();
    render(<KnowledgeLibrary lang="zh" initialWorkspace={params.get('workspace')!} knowledgeId={params.get('knowledge')!} initialKnowledgeRevision={params.get('revision')!}
      initialView="graph" initialGraphScope="filtered" initialGraphSelection={params.get('selection')!} initialChoice="retain" initialReaderTab="evidence"
      initialSegmentId={params.get('segment')!} initialMentionId={params.get('mention')!} initialCatalogRef={JSON.parse(params.get('catalog')!)} initialEvidence={JSON.parse(params.get('evidence')!)}/>, { wrapper });
    await screen.findByRole('combobox', { name: '选择图谱节点' });
    const reader = await screen.findByRole('navigation', { name: '知识阅读视图' });
    const article = reader.closest<HTMLElement>('article')!;
    await waitFor(() => expect(within(article).getByText('推断 · 第二次名称，保持精确位置')).toBeTruthy());
    const identitySummary = within(article).getByText('精确依据身份');
    const identity = identitySummary.closest<HTMLDetailsElement>('details')!;
    expect(identity.open).toBe(false);
    expect(within(article).getByText('推断 · 第二次名称，保持精确位置').closest('details')).toBeNull();
    expect(within(article).getByText('记录 0 · user · 来源时间未知').closest('details')).toBeNull();
    const marked = article.querySelector('pre.knowledge-source mark')!;
    expect(marked.textContent).toBe('Alpha'); expect(marked.previousSibling?.textContent).toBe('Alpha；');
    expect(marked.closest('details')).toBeNull();
    expect(article.querySelector('pre.knowledge-source')?.textContent).toBe('Alpha；Alpha\n<script>来源原文</script>');
    fireEvent.click(identitySummary);
    expect(identity.open).toBe(true);
    expect(identity.textContent).toContain(data.source.snapshotId); expect(identity.textContent).toContain(data.source.sourceVersion);
    expect(identity.textContent).toContain('record-1'); expect(identity.textContent).toContain('6–11');
    expect(within(identity).getByText(uuid(6))).toBeTruthy();
    fireEvent.click(within(article).getByRole('button', { name: '返回对应正文段落' }));
    expect(article.querySelector('[data-segment-id="s1"][data-focused="true"]')?.textContent).toContain(data.detail.revision.content.segments[0].text);
    expect(calls.filter(call => call.operation === 'apply-associations')).toHaveLength(1);
    await screen.findByText(/内容复核：尚未复核/);
    expect(calls.some(call => call.operation === 'review-status')).toBe(true);
    expect(calls.every(call => ['knowledge', 'graph', 'show', 'review-status', 'association-catalogs', 'entities', 'apply-associations'].includes(String(call.operation)))).toBe(true);
  });

  it('starts at content with a visible recovery notice for invalid evidence links, then clears it on an explicit new location', async () => {
    const { catalog, detail, source } = fixture();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const call = JSON.parse(String(init.body));
      return new Response(JSON.stringify(call.operation === 'knowledge' ? catalog : call.operation === 'review-status' ? absentReviews(detail) : detail), { status: 200 });
    }));
    render(<KnowledgeLibrary lang="zh" initialWorkspace="/isolated" knowledgeId={detail.revision.knowledgeId} initialReaderTab="evidence" initialSegmentId="bad-segment"
      initialMentionId="bad-mention" initialEvidence={{ ...source, evidenceRef: 'bad-record', start: 0, end: 1 }} initialReaderSelectionInvalid/>, { wrapper });
    expect(screen.getByText('未能恢复指定的精确依据。已回到正文；请重新选择段落、提及或来源。')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: '核对来源' }));
    expect(screen.queryByText('未能恢复指定的精确依据。已回到正文；请重新选择段落、提及或来源。')).toBeNull();
    expect(screen.getByRole('button', { name: '依据' }).getAttribute('aria-pressed')).toBe('true');
    expect(new URLSearchParams(window.location.search).get('mention')).toBeNull();
  });

  it('preserves typed relation attribution through graph evidence, URL reopen and return to the exact segment when canonical evidence shares the same span', async () => {
    const { detail, graph, catalog, source } = fixture();
    const interpretation = '关系中的有条件归因，不能替代正文来源说法';
    const evidence = { ...detail.revision.content.segments[0].evidence[0], basis: 'inference' as const, interpretation };
    detail.derivedAssociations.revision!.typedRelations = [{ relationId: 'relation-same-span', segmentIds: ['s1'], subject: { analysisId: uuid(7), entityRevisionId: uuid(8), entityId: uuid(4) },
      relation: '只在选定条件下适用', modality: 'descriptive', polarity: 'positive', evidence: [evidence], issues: [] }];
    graph.edges.push({ edgeKind: 'typed_relation', edgeId: 'typed-relation', from: 'entity-window-1', to: 'knowledge-current', current: true,
      knowledgeNodeId: 'knowledge-current', projectionRevisionId: uuid(9), reviewStatus: 'pending', catalogCurrent: true, relationId: 'relation-same-span',
      relation: '只在选定条件下适用', segmentIds: ['s1'], modality: 'descriptive', polarity: 'positive', evidence: [evidence], issues: [] });
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const call = JSON.parse(String(init.body)); calls.push(call.operation);
      const value = call.operation === 'knowledge' ? catalog : call.operation === 'graph' ? graph : call.operation === 'show' ? detail : call.operation === 'review-status' ? absentReviews(detail) : undefined;
      if (!value) throw new Error(`Unexpected operation: ${call.operation}`);
      return new Response(JSON.stringify(value), { status: 200 });
    }));
    const view = render(<KnowledgeLibrary lang="zh" initialWorkspace="/isolated" knowledgeId={detail.revision.knowledgeId} initialView="graph"
      initialGraphSelection="typed-relation" initialChoice="retain"/>, { wrapper });
    fireEvent.click(await screen.findByRole('button', { name: '在阅读器回查依据' }));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('relation')).toBe('relation-same-span'));
    const params = new URLSearchParams(window.location.search);
    expect(params.get('section')).toBe('evidence'); expect(params.get('segment')).toBe('s1'); expect(params.get('mention')).toBeNull();
    expect(JSON.parse(params.get('evidence')!)).toEqual({ ...source, evidenceRef: 'record-1', start: 6, end: 11 });
    const before = (await screen.findByRole('navigation', { name: '知识阅读视图' })).closest<HTMLElement>('article')!;
    expect(within(before).getByText(`推断 · ${interpretation}`)).toBeTruthy();
    view.unmount();
    render(<KnowledgeLibrary lang="zh" initialWorkspace={params.get('workspace')!} knowledgeId={params.get('knowledge')!} initialView="graph"
      initialGraphSelection={params.get('selection')!} initialChoice="retain" initialReaderTab="evidence" initialSegmentId={params.get('segment')!}
      initialRelationId={params.get('relation')!} initialEvidence={JSON.parse(params.get('evidence')!)}/>, { wrapper });
    const article = (await screen.findByRole('navigation', { name: '知识阅读视图' })).closest<HTMLElement>('article')!;
    expect(within(article).getByText(`推断 · ${interpretation}`)).toBeTruthy();
    expect(within(article).queryByText('来源中的说法', { exact: false })).toBeNull();
    const identitySummary = within(article).getByText('精确依据身份');
    const identity = identitySummary.closest<HTMLDetailsElement>('details')!;
    expect(identity.open).toBe(false);
    expect(within(article).getByText(`推断 · ${interpretation}`).closest('details')).toBeNull();
    const marked = article.querySelector('pre.knowledge-source mark')!;
    expect(marked.textContent).toBe('Alpha'); expect(marked.previousSibling?.textContent).toBe('Alpha；');
    expect(marked.closest('details')).toBeNull();
    fireEvent.click(identitySummary);
    expect(identity.open).toBe(true);
    expect(identity.textContent).toContain(source.snapshotId); expect(identity.textContent).toContain(source.sourceVersion);
    expect(identity.textContent).toContain('record-1'); expect(identity.textContent).toContain('6–11');
    expect(within(identity).getByText('relation-same-span')).toBeTruthy();
    fireEvent.click(within(article).getByRole('button', { name: '返回对应正文段落' }));
    expect(article.querySelector('[data-segment-id="s1"][data-focused="true"]')?.textContent).toContain(detail.revision.content.segments[0].text);
    await screen.findByText(/内容复核：尚未复核/);
    expect(calls).toContain('review-status');
    expect(calls.every(operation => ['knowledge', 'graph', 'show', 'review-status'].includes(operation))).toBe(true);
  });

  it('keeps mismatched original text and unavailable-source quotations outside the folded exact identity', () => {
    const { detail, source } = fixture();
    const available = detail.sources[0];
    if (available.status !== 'available') throw new Error('Missing available source fixture');
    available.window.excerpts[0].text = '来源后来包含的不同原话，不能当作已匹配引文。';
    const selection = { tab: 'evidence' as const, segmentId: 's1', evidence: { ...source, evidenceRef: 'record-1', start: 6, end: 11 } };
    const props = { detail, selection, onRevision: vi.fn(), onRetry: vi.fn() };
    const view = render(<KnowledgeReader {...props} lang="zh"/>, { wrapper });
    const identity = screen.getByText('精确依据身份').closest<HTMLDetailsElement>('details')!;
    expect(identity.open).toBe(false);
    const original = document.querySelector('pre.knowledge-source')!;
    expect(original.textContent).toBe(available.window.excerpts[0].text); expect(original.closest('details')).toBeNull();
    expect(screen.getByText('保存的引文与此快照位置不匹配，不能当作已核对；原文与保存引文分别保留。').closest('details')).toBeNull();
    expect(document.querySelector('blockquote')?.textContent).toBe('Alpha');
    expect(document.querySelector('blockquote')?.closest('details')).toBeNull();
    view.rerender(<KnowledgeReader {...props} detail={{ ...detail, sources: [] }} lang="en"/>);
    const unavailableIdentity = screen.getByText('Exact evidence identity').closest<HTMLDetailsElement>('details')!;
    expect(unavailableIdentity.open).toBe(false);
    expect(screen.getByText('This source is unavailable. Saved quotations remain readable, but full evidence cannot be checked.').closest('details')).toBeNull();
    expect(document.querySelector('blockquote')?.textContent).toBe('Alpha');
    expect(document.querySelector('blockquote')?.closest('details')).toBeNull();
    expect(document.querySelector('pre.knowledge-source')).toBeNull();
    fireEvent.click(screen.getByText('Exact evidence identity'));
    expect(unavailableIdentity.open).toBe(true);
    expect(unavailableIdentity.textContent).toContain(source.snapshotId); expect(unavailableIdentity.textContent).toContain(source.sourceVersion);
    expect(unavailableIdentity.textContent).toContain('record-1'); expect(unavailableIdentity.textContent).toContain('6–11');
  });
});
