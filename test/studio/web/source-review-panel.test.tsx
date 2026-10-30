// @vitest-environment jsdom
import { ConfigProvider } from 'antd';
import type { PropsWithChildren } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SourceReviewPanel } from '../../../src/studio/web/components/knowledge/source-review';
import { applySourceLedgerWrite, applySourceCoverageWrite, selectSourceCoverageDecision, sourceCoverageUnresolved } from '../../../src/knowledge/source-review-history.js';
import { sourceReviewRevisionDigest } from '../../../src/knowledge/adapters/source-review-store.js';
import { sourceReviewFixture, reviewActor, reviewDigest } from '../../knowledge/source-review-fixtures.js';
import type { SourceCoverageWrite } from '../../../src/knowledge/source-review.js';

const at = '2026-10-30T00:00:00Z';
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const change = (name: string, value: string) => fireEvent.change(screen.getByRole('textbox', { name }), { target: { value } });
const choose = (name: string, value: string) => fireEvent.change(screen.getByRole('combobox', { name }), { target: { value } });
const saveButton = () => screen.getByRole('button', { name: '保存本次决定' }) as HTMLButtonElement;
function wrapper({ children }: PropsWithChildren) { return <ConfigProvider theme={{ token: { motion: false } }}>{children}</ConfigProvider>; }

/** Authored UI projections exercise command custody and interactions, not semantic acceptance. */
function fixture(empty = false) {
  const f = sourceReviewFixture();
  f.ledger.data.items[0].statement = '<img src=x onerror=alert(1)> is untrusted source wording.';
  const { digest: _ledgerDigest, ...ledgerContent } = f.ledger; void _ledgerDigest;
  f.ledger.digest = sourceReviewRevisionDigest(ledgerContent); f.ledgerRef.digest = f.ledger.digest;
  if (empty) {
    f.coverage.data.bodyRefs = [];
    f.coverage.data.checks = f.coverage.data.checks.filter(check => check.target.targetKind !== 'body_segment');
    f.coverage.data.checks.forEach(check => { check.status = 'omitted'; check.bodyEvidence = []; });
  }
  const { digest: _digest, ...content } = f.coverage; void _digest;
  f.coverage.digest = sourceReviewRevisionDigest(content); f.coverageRef.digest = f.coverage.digest;
  const ledgerHistory = applySourceLedgerWrite(undefined, f.ledgerCommand, reviewActor, 'fixture', reviewDigest(), at);
  let history = applySourceCoverageWrite(undefined, f.coverageCommand, reviewActor, 'fixture', reviewDigest(), at);
  let sourceStatus: 'available' | 'unavailable' = 'available', ledgerAvailable = true, failAfterCommit = false, rejectConflict = false;
  const writes: SourceCoverageWrite[] = [], operations: string[] = [];
  const status = () => ({ history, revision: f.coverage, ref: f.coverageRef,
    decision: selectSourceCoverageDecision(history, f.coverageRef),
    sources: f.coverage.data.manifest.sources.map(({ sourceRef }) => ({ sourceRef, status: sourceStatus })),
    bodies: f.coverage.data.bodyRefs.map(bodyRef => ({ bodyRef, status: 'available' as const })),
    originalVerification: 'not_verified' as const, ledgerStatus: ledgerAvailable ? 'available' as const : 'unavailable' as const, unresolvedIds: ledgerAvailable ? sourceCoverageUnresolved(f.coverage.data, f.ledger.data) : null });
  const ledger = () => ({ history: ledgerHistory, revision: f.ledger, ref: f.ledgerRef, sources: status().sources, originalVerification: 'not_verified' as const });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe('/api/knowledge/candidates');
    const payload = JSON.parse(String(init?.body)) as { operation: string; command?: SourceCoverageWrite };
    operations.push(payload.operation);
    if (payload.operation === 'source-ledger') return ledgerAvailable ? response(ledger()) : response({ error: 'knowledge_request_failed' }, 500);
    if (payload.operation === 'source-coverage-status') return response(status());
    if (payload.operation !== 'review-source-coverage' || !payload.command) throw new Error('Unexpected model or UI request.');
    const command = payload.command; writes.push(command);
    if (rejectConflict) return response({ error: 'knowledge_conflict' }, 409);
    history = applySourceCoverageWrite(history, command, reviewActor, 'fixture', reviewDigest('c'), at);
    if (failAfterCommit) { failAfterCommit = false; throw new Error('Authored lost acknowledgement after commit.'); }
    return response(history.receipts.at(-1));
  }));
  const presetDecision = () => {
    const command = f.decision();
    command.decision.bodyRefs = structuredClone(f.coverage.data.bodyRefs);
    command.decision.dispositions = (status().unresolvedIds ?? []).map(unresolvedId => ({ unresolvedId, disposition: 'accepted_limit', reason: 'Explicit authored UI limitation.' }));
    history = applySourceCoverageWrite(history, command, reviewActor, 'fixture', reviewDigest('c'), at);
    return command;
  };
  return { f, status, writes, operations, presetDecision, hideSources: () => { sourceStatus = 'unavailable'; }, hideLedger: () => { ledgerAvailable = false; },
    loseAcknowledgement: () => { failAfterCommit = true; }, conflict: () => { rejectConflict = true; } };
}
async function fillDecision(f: ReturnType<typeof fixture>) {
  await screen.findByRole('combobox', { name: '本次来源决定' });
  choose('本次来源决定', 'proceed_with_limits');
  change('来源决定理由', 'I inspected the exact selected input and preserved its limits.');
  change('保留的限制', 'This is an authored UI review, not verified truth.');
  for (const id of f.status().unresolvedIds ?? []) {
    choose(`问题 ${id} 的处置`, 'accepted_limit');
    change(`问题 ${id} 的理由`, 'Preserve the bounded uncertainty without inventing a value.');
  }
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }));
  const computed = window.getComputedStyle.bind(window); vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computed(element));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('explicit source review panel', () => {
  it('shows pending units and unknowns, records every disposition, then requires a separate prepare click', async () => {
    const f = fixture(), prepare = vi.fn();
    const mounted = render(<SourceReviewPanel workspace="/source-review" coverageRef={f.f.coverageRef} onProceed={prepare}/>, { wrapper });
    await screen.findByRole('combobox', { name: '本次来源决定' });
    expect(screen.getByText('具体事实值仍未知。')).toBeTruthy();
    expect(screen.getByText(/尚待判断/)).toBeTruthy();
    expect(mounted.container.querySelector('img')).toBeNull();
    expect(saveButton().disabled).toBe(true);
    expect(screen.queryByRole('button', { name: '按此意见准备关联' })).toBeNull();
    await fillDecision(f); expect(saveButton().disabled).toBe(false); fireEvent.click(saveButton());
    const prepareButton = await screen.findByRole('button', { name: '按此意见准备关联' });
    expect(f.writes).toHaveLength(1); const command = f.writes[0];
    if (command.commandKind !== 'record_decision') throw new Error('Expected an actual decision.');
    expect(command.decision.dispositions.map(value => value.unresolvedId)).toEqual(f.status().unresolvedIds);
    expect(command).not.toHaveProperty('actor'); expect(command.decision).not.toHaveProperty('actor');
    expect(prepare).not.toHaveBeenCalled(); fireEvent.click(prepareButton);
    expect(prepare).toHaveBeenCalledWith({ coverageRef: f.f.coverageRef, sourceSetId: f.f.coverage.data.manifest.sourceSetId,
      ledgerRef: f.f.ledgerRef, bodyRefs: f.f.coverage.data.bodyRefs, eventId: command.requestId });
    expect(f.operations.every(value => ['source-ledger', 'source-coverage-status', 'review-source-coverage'].includes(value))).toBe(true);
  });
  it('locks an unknown write and confirms the exact saved event without posting again', async () => {
    const f = fixture(), prepare = vi.fn(); f.loseAcknowledgement();
    render(<SourceReviewPanel workspace="/lost-receipt" coverageRef={f.f.coverageRef} onProceed={prepare}/>, { wrapper });
    await fillDecision(f); fireEvent.click(saveButton());
    await screen.findByText('保存结果未知。草稿已锁定，请核对回执；不会自动重发。');
    const requestId = f.writes[0].requestId;
    expect(saveButton().disabled).toBe(true); expect((screen.getByRole('textbox', { name: '来源决定理由' }) as HTMLTextAreaElement).readOnly).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '核对本次回执' }));
    await screen.findByRole('button', { name: '按此意见准备关联' });
    expect(f.writes).toHaveLength(1); expect(f.writes[0].requestId).toBe(requestId); expect(prepare).not.toHaveBeenCalled();
  });
  it('preserves a conflicting draft and stops stale resubmission', async () => {
    const f = fixture(); f.conflict();
    render(<SourceReviewPanel workspace="/conflict" coverageRef={f.f.coverageRef}/>, { wrapper });
    await fillDecision(f); const writtenReason = (screen.getByRole('textbox', { name: '来源决定理由' }) as HTMLTextAreaElement).value;
    fireEvent.click(saveButton());
    await screen.findByText('记录已有更新，草稿与原基线已保留。请关闭面板后重新核对，不会重发。');
    expect((screen.getByRole('textbox', { name: '来源决定理由' }) as HTMLTextAreaElement).value).toBe(writtenReason);
    expect(saveButton().disabled).toBe(true); fireEvent.click(saveButton()); expect(f.writes).toHaveLength(1);
  });
  it('keeps zero-body omissions visible and allows explicit revocation while sources are unavailable', async () => {
    const f = fixture(true), prior = f.presetDecision(), prepare = vi.fn(); f.hideSources(); f.hideLedger();
    render(<SourceReviewPanel workspace="/no-content" coverageRef={f.f.coverageRef} onProceed={prepare}/>, { wrapper });
    await screen.findByText('本轮没有保存正文，来源遗漏仍须核对。');
    expect(screen.queryByRole('button', { name: '按此意见准备关联' })).toBeNull();
    expect(screen.getByText(/未决项状态未知，不能保存新决定。/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '按此意见结束本轮（无正文）' }) as HTMLButtonElement).disabled).toBe(true);
    expect(saveButton().disabled).toBe(true);
    choose('来源复核操作', 'revoke'); choose('要撤销的意见', prior.requestId); change('来源决定理由', 'Withdraw this prior opinion while the source is unavailable.');
    expect(saveButton().disabled).toBe(false); fireEvent.click(saveButton());
    await waitFor(() => expect(f.status().decision.status).toBe('not_reviewed'));
    expect(f.writes).toHaveLength(1); expect(f.writes[0]).toMatchObject({ commandKind: 'revoke_decision', targetEventId: prior.requestId,
      expectedGeneration: 2, expectedHeadEventId: prior.requestId });
    expect(prepare).not.toHaveBeenCalled();
  });
});
