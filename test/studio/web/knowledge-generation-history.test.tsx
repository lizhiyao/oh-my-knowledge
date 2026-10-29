// @vitest-environment jsdom
import { ConfigProvider } from 'antd';
import type { PropsWithChildren } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { KnowledgeCandidates } from '../../../src/studio/web/components/knowledge/candidates';
import type { KnowledgeCandidateRun } from '../../../src/studio/view-models/knowledge/knowledge-candidates';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push() {}, replace() {}, refresh() {} }) }));
function wrapper({ children }: PropsWithChildren) { return <ConfigProvider theme={{ token: { motion: false } }}>{children}</ConfigProvider>; }
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }));
  const computed = window.getComputedStyle.bind(window); vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computed(element));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(['zh', 'en'] as const)('keeps older-profile recovery disabled while current prepared writes can resume (%s)', async lang => {
  const old: KnowledgeCandidateRun = { runId: 'older-profile-run', schemaStatus: 'current', status: 'active', bodies: [], phases: [],
    nextAction: 'unsupported', unsupportedReason: 'generation_profile_changed_use_matching_build', archiveChecks: [], archiveVerification: 'not_verified' };
  const current: KnowledgeCandidateRun = { ...old, runId: 'prepared-current-run', nextAction: 'resume_publication', unsupportedReason: undefined };
  const calls: Record<string, unknown>[] = [];
  let resumed = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url === '/api/settings') return json({ effective: { workspace: '/history-fixture', executor: 'openai-api', model: 'fixture' } });
    const body = JSON.parse(String(init.body)); calls.push(body);
    if (url !== '/api/knowledge/candidates') throw new Error(`Unexpected URL: ${url}`);
    if (body.operation === 'list') return json([]);
    if (body.operation === 'runs') return json([old, resumed ? { ...current, status: 'completed', nextAction: 'none' } : current]);
    if (body.operation === 'quality') return json({ projectionKind: 'knowledge-body-admission', schemaVersion: 1, current: [], unsupported: [], unavailable: [], archiveChecks: [], semanticQuality: 'not_assessed' });
    if (body.operation === 'resume' && body.id === current.runId) { resumed = true; return json({ ...current, status: 'completed', nextAction: 'none' }); }
    throw new Error(`Unexpected history operation: ${body.operation}`);
  }));
  render(<KnowledgeCandidates lang={lang}/>, { wrapper });
  fireEvent.click(await screen.findByRole('button', { name: lang === 'zh' ? '查看提炼记录' : 'View extraction history' }));
  const history = await screen.findByRole('dialog', { name: lang === 'zh' ? '提炼记录' : 'Extraction history' });
  const oldRow = within(history).getByText(old.runId).closest('section')!;
  const currentRow = within(history).getByText(current.runId).closest('section')!;
  expect(within(oldRow).getByRole('alert').textContent).toContain(lang === 'zh' ? '此任务使用旧生成协议' : 'This run uses an older generation protocol');
  expect(oldRow.textContent).toContain(lang === 'zh' ? '请使用保留的匹配构建恢复此任务' : 'Recover this run with the preserved matching build');
  expect(oldRow.textContent).toContain(lang === 'zh' ? '不重新解释输出或重新派发' : 'without reinterpreting output or redispatching');
  expect(oldRow.textContent).toContain(lang === 'zh' ? '已准备好的固定写入意图仍可恢复' : 'Already prepared write intents remain recoverable');
  expect(within(currentRow).queryByRole('alert')).toBeNull();
  const resumeName = lang === 'zh' ? '恢复归档或保存' : 'Resume archiving or saving';
  const blocked = within(oldRow).getByRole('button', { name: resumeName });
  expect(blocked.hasAttribute('disabled')).toBe(true); fireEvent.click(blocked);
  expect(calls.some(call => call.operation === 'resume')).toBe(false);
  const enabled = within(currentRow).getByRole('button', { name: resumeName });
  expect(enabled.hasAttribute('disabled')).toBe(false); fireEvent.click(enabled);
  await waitFor(() => expect(calls.filter(call => call.operation === 'resume')).toEqual([{ workspace: '/history-fixture', operation: 'resume', id: current.runId }]));
  await waitFor(() => expect(currentRow.textContent).toContain(lang === 'zh' ? '流程已结束' : 'Workflow ended'));
  expect(within(currentRow).getByRole('button', { name: resumeName }).hasAttribute('disabled')).toBe(true);
  expect(calls.every(call => !['generate', 'continue'].includes(String(call.operation)))).toBe(true);
});
