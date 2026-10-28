import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReportServer } from '../../../src/studio/http/report-server.js';
import { inspectExtractionStudy } from '../../../src/knowledge/application/study-inspection.js';
import * as inspectionService from '../../../src/knowledge/application/study-inspection-service.js';
import { parseExtractionStudyInspectionBody } from '../../../src/knowledge/adapters/study-inspection-input.js';
import { ExtractionStudyInspectionError } from '../../../src/knowledge/adapters/study-inspection-errors.js';
import { nativeStudyFixture } from '../../knowledge/extraction-study-fixtures.js';
import { request } from '../../helpers/http-request.js';

const trusted = vi.hoisted(() => ({ host: {} as Record<string, string> }));
vi.mock('../../../src/knowledge/adapters/study-host.js', () => ({ extractionStudyHostIdentity: () => trusted.host }));
// Source HTTP wiring uses an authored checker host; independent built tests exercise the fixed worker.
beforeEach(() => {
  vi.spyOn(inspectionService, 'reserveExtractionStudyInspection').mockImplementation(() => ({
    inspect: async input => {
      if (input.inputKind !== 'bytes') throw new Error('HTTP must supply bytes, never local paths.');
      return inspectExtractionStudy(parseExtractionStudyInspectionBody(new Uint8Array(input.bytes)));
    }, release: vi.fn(),
  }));
});
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('portable study HTTP inspection', () => {
  it('uses the shared native replay before workspace resolution and returns no raw transport or filesystem projection', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'omk-study-http-'))); roots.push(root);
    const f = nativeStudyFixture(root), plan = f.prepare(); trusted.host = f.ports.identity();
    f.files.create(plan, f.corpusRaw, f.configurationRaw);
    for (const slot of plan.slots) await f.archiveSlot(plan, slot.slotId);
    const evidence = f.files.evidence(plan), expected = inspectExtractionStudy({ evidence });
    const directories = vi.fn(() => { throw new Error('PRIVATE-DIRECTORY-SENTINEL: active settings are broken'); });
    const server = createReportServer({ port: 0, analysesDir: directories, doctorsDir: directories, observationsDir: join(root, 'observations') });
    const base = await server.start();
    try {
      const response = await fetch(`${base}/api/knowledge/study`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ evidence }) });
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
      const body = await response.json();
      expect(body).toEqual(expected); expect(directories).not.toHaveBeenCalled();
      expect(body).toMatchObject({ inspectionVersion: 'omk-extraction-study-inspection/v2',
        review: { reportVersion: 'omk-extraction-study-review/v2' }, analysis: { analysisVersion: 'omk-extraction-study-analysis/v2' } });
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(root); expect(serialized).not.toContain('rawOutput'); expect(serialized).not.toContain('maxOutcomeJsonBytes');
      expect(f.effects).toHaveBeenCalledTimes(2);
    } finally { await server.stop(); }
  });

  it('rejects busy before reading an unfinished body and cancels active inspection on disconnect and stop', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'omk-study-http-worker-'))); roots.push(root);
    const server = createReportServer({ port: 0, analysesDir: join(root, 'analyses'), doctorsDir: join(root, 'doctors'), observationsDir: join(root, 'observations') });
    const base = await server.start();
    try {
      vi.mocked(inspectionService.reserveExtractionStudyInspection).mockImplementationOnce(() => { throw new ExtractionStudyInspectionError('knowledge_study_busy'); });
      const busy = await request(`${base}/api/knowledge/study`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: 'PRIVATE-UNFINISHED-BODY', endBody: false });
      expect(busy.status).toBe(503); expect(busy.requestEnded).toBe(false); expect(busy.headers.connection).toBe('close');
      expect(JSON.parse(busy.body)).toMatchObject({ error: 'knowledge_study_busy', message: expect.stringMatching(/重试|retry/) });
      expect(busy.body).not.toContain('PRIVATE-UNFINISHED-BODY');
      let observed: AbortSignal | undefined;
      const release = vi.fn();
      vi.mocked(inspectionService.reserveExtractionStudyInspection).mockImplementationOnce(signal => {
        observed = signal;
        return { release, inspect: () => new Promise((_, reject) => signal!.addEventListener('abort', () => reject(new ExtractionStudyInspectionError('knowledge_study_unavailable')), { once: true })) };
      });
      const controller = new AbortController();
      const pending = fetch(`${base}/api/knowledge/study`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: controller.signal });
      const rejected = pending.catch(() => undefined);
      await vi.waitFor(() => expect(observed).toBeDefined()); controller.abort();
      await rejected; await vi.waitFor(() => expect((observed as AbortSignal | undefined)?.aborted).toBe(true)); await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
      observed = undefined;
      vi.mocked(inspectionService.reserveExtractionStudyInspection).mockImplementationOnce(signal => {
        observed = signal;
        return { release, inspect: () => new Promise((_, reject) => signal!.addEventListener('abort', () => reject(new ExtractionStudyInspectionError('knowledge_study_unavailable')), { once: true })) };
      });
      const stopped = fetch(`${base}/api/knowledge/study`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined);
      await vi.waitFor(() => expect(observed).toBeDefined()); await server.stop(); await stopped;
      expect((observed as AbortSignal | undefined)?.aborted).toBe(true); expect(release).toHaveBeenCalledTimes(2);
    } finally { await server.stop(); }
  });

  it('keeps method, same-origin, independent capacity and finite error contracts without opening workspace data', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'omk-study-http-errors-'))); roots.push(root);
    const server = createReportServer({ port: 0, analysesDir: join(root, 'analyses'), doctorsDir: join(root, 'doctors'), observationsDir: join(root, 'observations') });
    const base = await server.start();
    const send = (resource: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/knowledge/${resource}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    try {
      const wrongMethod = await fetch(`${base}/api/knowledge/study`);
      expect(wrongMethod.status).toBe(405); expect(wrongMethod.headers.get('allow')).toBe('POST');
      const untrusted = await send('study', {}, { origin: 'https://untrusted.invalid' });
      expect(untrusted.status).toBe(403); expect(await untrusted.json()).toEqual({ error: 'mutation_not_trusted' });
      const suppliedTrust = await send('study', { evidence: {}, nativeVerified: true, status: 'accepted_within_scope', sourcePath: '/PRIVATE-STUDY-SENTINEL' });
      expect(suppliedTrust.status).toBe(400); expect(await suppliedTrust.json()).toEqual({ error: 'knowledge_study_input_invalid' });
      const overLegacyLimit = { evidence: 'PRIVATE-STUDY-SENTINEL'.padEnd(1024 * 1024, 'x') };
      const study = await send('study', overLegacyLimit);
      expect(study.status).toBe(400); expect(await study.json()).toEqual({ error: 'knowledge_study_evidence_invalid' });
      // Leave the request open just beyond the ordinary cap to verify rejection before client EOF.
      const ordinary = await request(`${base}/api/knowledge/candidates`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(overLegacyLimit), endBody: false,
      });
      expect(ordinary.status).toBe(413); expect(JSON.parse(ordinary.body)).toEqual({ error: 'request_body_too_large' });
      expect(ordinary.requestEnded).toBe(false); expect(ordinary.headers.connection).toBe('close');
    } finally { await server.stop(); }
  });
});
