import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeDraftSchema } from '../../src/knowledge/contracts.js';
import { KnowledgeDraftSchema as FrozenTypedDraftSchema } from '../../src/knowledge/measurement/typed-contracts.js';
import { executeLocalExtractionStudy } from '../../src/knowledge/application/study-local.js';
import type { ExecutorArchiveProducer } from '../../src/executors/contracts/archive.js';
import { draft } from './fixtures.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
describe('frozen typed measurement boundary', () => {
  it('keeps the original measurement DTO valid without restoring it as canonical body data', () => {
    const legacy = draft(); expect(FrozenTypedDraftSchema.parse(legacy)).toEqual(legacy);
    expect(KnowledgeDraftSchema.safeParse(legacy).success).toBe(false);
  });
  it('rejects old typed bench generation before producer access, file reads or slot claims', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-unsupported-study-')); roots.push(root);
    const access = vi.fn(() => { throw new Error('Producer must not be inspected or configured.'); });
    const producer = new Proxy({} as ExecutorArchiveProducer, { get: access });
    const result = await executeLocalExtractionStudy({ command: 'run', values: { '--workspace': join(root, 'absent-workspace'), '--study': join(root, 'absent-study') },
      repository: root, runnerFile: join(root, 'missing-runner'), producer });
    expect(result).toMatchObject({ errorCode: 'knowledge_study_generation_unsupported', modelCallsByThisCommand: 0, qualityConclusion: 'not_evaluated', exitCode: 1 });
    expect('message' in result && result.message).toContain('observe knowledge generate'); expect(access).not.toHaveBeenCalled();
    expect(existsSync(join(root, 'absent-workspace'))).toBe(false); expect(existsSync(join(root, 'absent-study'))).toBe(false);
  });
});
