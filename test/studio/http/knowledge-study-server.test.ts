import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReportServer } from '../../../src/studio/http/report-server.js';
import { inspectExtractionStudy } from '../../../src/knowledge/application/study-inspection.js';
import { runExtractionStudySlot } from '../../../src/knowledge/application/study-runner.js';
import { nativeStudyFixture } from '../../knowledge/extraction-study-fixtures.js';

const trusted = vi.hoisted(() => ({ host: {} as Record<string, string> }));
vi.mock('../../../src/knowledge/adapters/study-host.js', () => ({ extractionStudyHostIdentity: () => trusted.host }));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('portable study HTTP inspection', () => {
  it('uses the shared native replay before workspace resolution and returns no raw transport or filesystem projection', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'omk-study-http-'))); roots.push(root);
    const f = nativeStudyFixture(root), plan = f.prepare(); trusted.host = f.ports.identity();
    f.files.create(plan, f.corpusRaw, f.configurationRaw);
    for (const slot of plan.slots) await runExtractionStudySlot(f.ports, { plan, corpus: f.corpus, slotId: slot.slotId });
    const evidence = f.files.evidence(plan), expected = inspectExtractionStudy({ evidence });
    const directories = vi.fn(() => { throw new Error('PRIVATE-DIRECTORY-SENTINEL: active settings are broken'); });
    const server = createReportServer({ port: 0, analysesDir: directories, doctorsDir: directories, observationsDir: join(root, 'observations') });
    const base = await server.start();
    try {
      const response = await fetch(`${base}/api/knowledge/study`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ evidence }) });
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
      const body = await response.json();
      expect(body).toEqual(expected); expect(directories).not.toHaveBeenCalled();
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(root); expect(serialized).not.toContain('rawOutput'); expect(serialized).not.toContain('maxOutcomeJsonBytes');
      expect(f.effects).toHaveBeenCalledTimes(2);
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
      const overLegacyLimit = { evidence: 'PRIVATE-STUDY-SENTINEL'.repeat(60_000) };
      const study = await send('study', overLegacyLimit);
      expect(study.status).toBe(400); expect(await study.json()).toEqual({ error: 'knowledge_study_evidence_invalid' });
      const ordinary = await send('candidates', overLegacyLimit);
      expect(ordinary.status).toBe(413); expect(await ordinary.json()).toEqual({ error: 'request_body_too_large' });
    } finally { await server.stop(); }
  });
});
