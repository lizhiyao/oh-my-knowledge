import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { detectLegacyEvaluationLayouts } from '../../../src/evidence/storage/legacy-eval-layout.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omk-legacy-eval-layout-'));
  roots.push(root);
  return root;
}

describe('legacy evaluation layout detection', () => {
  it('finds top-level JSON files in current and pre-Core roots without parsing them', async () => {
    const root = await temporaryRoot();
    const current = join(root, '.omk', 'eval');
    const legacy = join(root, '.omk', 'reports');
    await mkdir(join(current, 'run-valid'), { recursive: true });
    await mkdir(legacy, { recursive: true });
    await writeFile(join(current, 'old.report.json'), '{not-json', 'utf8');
    await writeFile(join(current, 'readme.txt'), 'ignored', 'utf8');
    await writeFile(join(legacy, 'older.json'), '{}', 'utf8');
    await writeFile(join(legacy, 'write.json.tmp.1'), '{}', 'utf8');

    const findings = await detectLegacyEvaluationLayouts({
      evalDirectories: [current],
      legacyReportsDirectories: [legacy],
    });

    assert.deepEqual(findings, [{
      layoutKind: 'flat-files-in-eval-directory',
      directory: current,
      fileCount: 1,
    }, {
      layoutKind: 'legacy-reports-directory',
      directory: legacy,
      fileCount: 1,
    }]);
    assert.ok(Object.isFrozen(findings));
    assert.ok(findings.every(Object.isFrozen));
  });

  it('deduplicates roots and ignores missing, empty, nested, and temporary artifacts', async () => {
    const root = await temporaryRoot();
    const current = join(root, 'eval');
    await mkdir(join(current, 'run-1'), { recursive: true });
    await writeFile(join(current, 'run-1', 'report.json'), '{}', 'utf8');
    await writeFile(join(current, '.write.json.tmp.1'), '{}', 'utf8');

    assert.deepEqual(await detectLegacyEvaluationLayouts({
      evalDirectories: [current, current],
      legacyReportsDirectories: [join(root, 'missing')],
    }), []);
  });
});
