import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { buildObservationInboxReport, saveObservationInboxReport } from '../../../src/observability/inbox/index.js';
import { createKnowledgeQuery } from '../../../src/studio/application/knowledge-query.js';
import { loadKnowledgePage } from '../../../src/studio/http/knowledge-page.js';

describe('Studio inbox cache source', () => {
  it('observes new reports in reports/ without a restart or cache reset', () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-studio-inbox-cache-'));
    try {
      const source = new URL('../../fixtures/codex-knowledge-debugger-failure.jsonl', import.meta.url).pathname;
      const report = buildObservationInboxReport(source);
      const observations = join(root, 'inbox');
      const query = createKnowledgeQuery({ analysesDir:join(root, 'health'), doctorsDir:join(root, 'doctor'), observationsDir:observations });
      const build = () => query.read();
      for (const [index, name] of ['first', 'second'].entries()) {
        report.meta.generatedAt = `2026-09-01T00:00:0${index}.000Z`;
        if (report.experience) report.experience.generatedAt = report.meta.generatedAt;
        report.diagnostics = {
          schemaVersion: 1, generatedAt: report.meta.generatedAt,
          sourceCoverage: { observe: true, doctor: false, eval: false },
          bySkill: { [name]: [{
            id: name, stableKey: name, skillName: name, type: 'definition_gap', signal: 'coverage-gap',
            title: name, severity: 'high', audience: 'skill-author', lifecycle: 'detected',
            scope: { primary: 'skill', refs: { skillName: name } }, occurrences: [], occurrenceCount: 0,
          }] },
        };
        saveObservationInboxReport(report, observations);
        const indexView = build();
        assert.equal(indexView.diagnosticsBySkill.has(name), true);
        const page = loadKnowledgePage(query, '/knowledge', 'zh');
        assert.equal(page?.pageKind, 'index');
        if (page?.pageKind === 'index') assert.deepEqual(page.summary, indexView.summary);
        indexView.diagnosticsBySkill.clear();
        assert.equal(build().diagnosticsBySkill.has(name), true);
        if (index > 0) assert.equal(indexView.diagnosticsBySkill.has('first'), false);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
