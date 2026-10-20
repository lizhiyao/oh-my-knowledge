// @vitest-environment jsdom
import { act, useState, type PropsWithChildren } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigProvider } from 'antd';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeStudyInspectionDrawer, KnowledgeStudyInspectionView } from '../../../src/studio/web/components/knowledge/study-inspection';
import { KnowledgeCandidates } from '../../../src/studio/web/components/knowledge/candidates';
import type { KnowledgeStudyInspection } from '../../../src/studio/view-models/knowledge/knowledge-study';
import type { ExtractionStudyHost } from '../../../src/knowledge/extraction/study-plan';
import { EXTRACTION_STUDY_INSPECTION_MAX_BYTES } from '../../../src/knowledge/extraction/study-capacity';
import { inspectExtractionStudy } from '../../../src/knowledge/application/study-inspection';
import { nativeStudyEvidenceFixture } from '../../knowledge/extraction-study-fixtures';

const { host } = vi.hoisted(() => ({ host: { value: undefined as ExtractionStudyHost | undefined } }));
vi.mock('../../../src/knowledge/adapters/study-host.js', () => ({ extractionStudyHostIdentity: () => host.value }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push() {}, replace() {}, refresh() {} }) }));
let root: string, inspected: KnowledgeStudyInspection, pending: KnowledgeStudyInspection, aiOnly: KnowledgeStudyInspection;
beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'omk-study-ui-')));
  const fixture = await nativeStudyEvidenceFixture(root, { annotated: true });
  host.value = fixture.ports.identity();
  inspected = inspectExtractionStudy({ evidence: fixture.evidence, authorReceipt: fixture.authorReceipt, referenceReceipt: fixture.referenceReceipt,
    outputReceipt: fixture.outputReceipt, judgeReceipt: fixture.judgeReceipt });
  pending = inspectExtractionStudy({ evidence: fixture.evidence });
  aiOnly = inspectExtractionStudy({ evidence: fixture.evidence, judgeReceipt: fixture.judgeReceipt });
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }));
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computedStyle(element));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function wrapper({ children }: PropsWithChildren) { return <ConfigProvider theme={{ token: { motion: false } }}>{children}</ConfigProvider>; }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function file(value: unknown = {}, name = 'evidence.json') {
  const text = JSON.stringify(value), selected = new File([text], name, { type: 'application/json' });
  Object.defineProperty(selected, 'text', { value: vi.fn(async () => text), configurable: true });
  return selected;
}
function select(selected: File) { fireEvent.change(screen.getByLabelText(/^Study evidence evidence.json/), { target: { files: [selected] } }); }
const inspect = () => fireEvent.click(screen.getByRole('button', { name: 'Inspect evidence' }));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe('portable study inspection presentation', () => {
  it('presents safe source, birth and judgment DTOs with scope limits and no workspace editing affordance', () => {
    const value = structuredClone(inspected), hostile = '<script>unsafe source</script>';
    value.cases[0].source.excerpts[0].text = hostile;
    const html = renderToStaticMarkup(<KnowledgeStudyInspectionView inspection={value} lang="zh"/>);
    expect(html).toContain('独立复核：仅在冻结范围内通过'); expect(html).toContain('这里不评估总体准确率、版本发布资格或改造完成');
    expect(html).toContain('&lt;script&gt;unsafe source&lt;/script&gt;'); expect(html).not.toContain(hostile);
    expect(html).toContain('来源采集时间'); expect(html).toContain('不能作为人工复核耗时');
    expect(html).not.toContain('sourcePath'); expect(html).not.toContain(root); expect(html).not.toContain('native trace');
    expect(html).not.toMatch(/href=|保存新修订|保留此知识|维护决定/);
    render(<KnowledgeStudyInspectionView inspection={inspected} lang="en"/>, { wrapper });
    fireEvent.change(screen.getByLabelText('Case view'), { target: { value: 'birth' } });
    expect(screen.getByRole('heading', { name: 'Birth output' })).toBeTruthy(); expect(screen.getAllByText('Alpha').length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('Arm'), { target: { value: 'candidate' } });
    fireEvent.change(screen.getByLabelText('Case view'), { target: { value: 'review' } });
    expect(screen.getAllByText(/Fictional authored test judgment/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Precision／Recall／F1')).toHaveLength(2);
  });

  it('keeps AI exploration separate from missing independent review and shows missing targets and unknown metrics', () => {
    const html = renderToStaticMarkup(<KnowledgeStudyInspectionView inspection={pending} lang="zh"/>);
    expect(html).toContain('证据不足：仍需复核'); expect(html).toContain('未就绪'); expect(html).not.toContain('独立复核：仅在冻结范围内通过');
    render(<KnowledgeStudyInspectionView inspection={aiOnly} lang="en"/>, { wrapper });
    expect(screen.getByRole('heading', { name: 'Insufficient evidence: review pending' })).toBeTruthy();
    expect(screen.getByText(/AI exploratory review:/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Case view'), { target: { value: 'review' } });
    expect(screen.getByText('Targets still needing review')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Judgment source'), { target: { value: 'judge' } });
    expect(screen.getByText(/authored-agent-judge/)).toBeTruthy();
    expect(screen.getAllByText('Unknown / not assessed').length).toBeGreaterThan(0);
    expect(screen.getByText('Observed critical missed judgments: Unknown / not assessed')).toBeTruthy();
    expect(screen.getByText(`Compared / expected targets: 0／${aiOnly.calibration!.expectedTargets} · Unknown or missing targets: ${aiOnly.calibration!.expectedTargets}`)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Save|Retain|Discard/ })).toBeNull();
  });

  it('preserves observed critical misses with traceable targets when calibration is incomplete', () => {
    const value = structuredClone(inspected), calibration = value.calibration!;
    calibration.ready = false;
    calibration.knownComparedTargets = 0;
    calibration.unknownOrMissingTargets = calibration.expectedTargets;
    calibration.criticalMisses = [{ target: value.review.targets[0], errorCodes: ['identity'], judgeVerdict: 'uncertain', detectionStatus: 'judge_unknown' }];
    render(<KnowledgeStudyInspectionView inspection={value} lang="en"/>, { wrapper });
    expect(screen.getByText('Observed critical missed judgments: 1')).toBeTruthy();
    expect(screen.getByText(/Error classes: identity · Detection status: Judge judgment unknown/)).toBeTruthy();
    expect(screen.getAllByText(new RegExp(value.review.targets[0].itemKind)).length).toBeGreaterThan(0);
    expect(screen.getByText(/Calibration evidence is incomplete/)).toBeTruthy();
  });
});

describe('temporary study upload session', () => {
  it('opens from More without any workspace, aborts on Escape and clears the session when reopened', async () => {
    // rc-util intentionally returns the same portal ID in test mode; use real React IDs for the multi-drawer Escape stack.
    vi.stubEnv('NODE_ENV', 'development');
    const settings = deferred<Response>(), fetcher = vi.fn(() => settings.promise); vi.stubGlobal('fetch', fetcher);
    render(<KnowledgeCandidates lang="en"/>, { wrapper });
    const more = screen.getByRole('button', { name: 'More' }); fireEvent.click(more);
    const entry = await screen.findByRole('menuitem', { name: 'Inspect study evidence' });
    expect(entry.getAttribute('aria-disabled')).not.toBe('true'); fireEvent.click(entry);
    const dialog = await screen.findByRole('dialog', { name: 'Inspect study evidence' });
    select(file()); expect(within(dialog).getByRole('button', { name: 'Inspect evidence' }).hasAttribute('disabled')).toBe(false);
    fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape', keyCode: 27 });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Inspect study evidence' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(more));
    fireEvent.click(screen.getByRole('button', { name: 'More' })); fireEvent.click(await screen.findByRole('menuitem', { name: 'Inspect study evidence' }));
    await screen.findByRole('dialog', { name: 'Inspect study evidence' });
    expect(screen.getByRole('button', { name: 'Inspect evidence' }).hasAttribute('disabled')).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1); // Only the existing settings read; opening inspection has no request.
  });

  it('posts explicit files without workspace and rejects stale reads or responses after replacement, cancellation and close', async () => {
    const responses = [deferred<Response>(), deferred<Response>(), deferred<Response>()], calls: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => { expect(url).toBe('/api/knowledge/study'); calls.push(init); return responses[calls.length - 1].promise; }));
    function Harness() { const [open, setOpen] = useState(true); return <>{open ? <KnowledgeStudyInspectionDrawer lang="en" onClose={() => setOpen(false)}/> : <button onClick={() => setOpen(true)}>Reopen inspection</button>}</>; }
    render(<Harness/>, { wrapper });
    const heldRead = deferred<string>(), first = file(); Object.defineProperty(first, 'text', { value: () => heldRead.promise, configurable: true });
    select(first); inspect(); select(file({ selected: 'replacement' })); await act(async () => heldRead.resolve('{}'));
    expect(calls).toHaveLength(0);
    inspect(); await waitFor(() => expect(calls).toHaveLength(1));
    const sent = JSON.parse(String(calls[0].body)); expect(sent).toEqual({ evidence: { selected: 'replacement' } }); expect(sent.workspace).toBeUndefined();
    select(file({ selected: 'newest' })); expect(calls[0].signal?.aborted).toBe(true);
    inspect(); await waitFor(() => expect(calls).toHaveLength(2));
    const newest = structuredClone(pending); newest.cases[0].source.excerpts[0].text = 'Newest source';
    await act(async () => responses[1].resolve(json(newest))); expect(await screen.findByText('Newest source')).toBeTruthy();
    const stale = structuredClone(pending); stale.cases[0].source.excerpts[0].text = 'Stale source';
    await act(async () => responses[0].resolve(json(stale))); expect(screen.queryByText('Stale source')).toBeNull();
    select(file()); inspect(); await waitFor(() => expect(calls).toHaveLength(3));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel inspection' })); expect(calls[2].signal?.aborted).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await act(async () => responses[2].resolve(json(stale))); expect(screen.queryByText('Stale source')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reopen inspection' }));
    expect(screen.getByRole('button', { name: 'Inspect evidence' }).hasAttribute('disabled')).toBe(true);
  });

  it('checks aggregate file capacity and final JSON UTF-8 capacity before dispatch, and rejects malformed JSON', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    render(<KnowledgeStudyInspectionDrawer lang="en" onClose={() => {}}/>, { wrapper });
    const large = file(); Object.defineProperty(large, 'size', { value: EXTRACTION_STUDY_INSPECTION_MAX_BYTES + 1 });
    select(large); expect(screen.getByRole('alert').textContent).toContain('128 MiB'); expect(screen.getByRole('button', { name: 'Inspect evidence' }).hasAttribute('disabled')).toBe(true);
    expect(large.text).not.toHaveBeenCalled();
    select(file()); const expanded = new Uint8Array(new ArrayBuffer(0));
    Object.defineProperty(expanded, 'byteLength', { value: EXTRACTION_STUDY_INSPECTION_MAX_BYTES + 1 });
    const encode = vi.spyOn(TextEncoder.prototype, 'encode').mockReturnValueOnce(expanded);
    inspect(); await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('128 MiB')); expect(fetcher).not.toHaveBeenCalled();
    encode.mockRestore();
    const invalid = file(); Object.defineProperty(invalid, 'text', { value: async () => '{', configurable: true }); select(invalid); inspect();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('not valid study JSON')); expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['knowledge_study_host_mismatch', 'installation differs'], ['knowledge_study_evidence_invalid', 'identities did not validate'],
    ['knowledge_study_input_invalid', 'not valid study JSON'], ['knowledge_study_capacity_exceeded', '128 MiB'],
    ['request_body_too_large', '128 MiB'], ['unsafe /private/path <script>', 'inspection is unavailable'],
  ])('keeps the selected files and provides bounded recovery for %s', async (code, copy) => {
    const fetcher = vi.fn(async () => json({ error: code }, code.startsWith('unsafe') ? 500 : 400)); vi.stubGlobal('fetch', fetcher);
    render(<KnowledgeStudyInspectionDrawer lang="en" onClose={() => {}}/>, { wrapper }); select(file()); inspect();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(copy));
    expect(screen.getByRole('button', { name: 'Inspect evidence' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('alert').textContent).not.toContain('/private/path');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
