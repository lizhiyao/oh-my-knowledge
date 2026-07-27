import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIsolationWarnings } from '../../src/eval-workflows/evaluation-pipeline.js';
import type { Artifact } from '../../src/types/index.js';

function mkArtifact(name: string, kind: Artifact['kind'] = 'baseline'): Artifact {
  return {
    name,
    kind,
    source: kind === 'baseline' ? 'baseline' : 'inline',
    content: kind === 'baseline' ? null : 'sys',
    experimentRole: 'control',
  };
}

describe('buildIsolationWarnings', () => {
  it('strictBaseline=undefined(default true)→ 不出 warning(默认就是干净的)', () => {
    const w = buildIsolationWarnings([mkArtifact('baseline')], undefined, {
      executorName: 'claude',
    });
    assert.deepEqual(w, []);
  });

  it('strictBaseline=true 显式传 → 不出 warning', () => {
    const w = buildIsolationWarnings([mkArtifact('baseline')], true, {
      executorName: 'claude',
    });
    assert.deepEqual(w, []);
  });

  it('strictBaseline=false + 没 baseline-kind variant → 不出 warning(无受害对象)', () => {
    const w = buildIsolationWarnings([mkArtifact('treatment', 'skill')], false, {
      executorName: 'claude',
    });
    assert.deepEqual(w, []);
  });

  it('显式 allowedSkills=[] 的 baseline 不会误报未隔离', () => {
    const baseline = { ...mkArtifact('baseline'), allowedSkills: [] };
    const w = buildIsolationWarnings([baseline], false, {
      executorName: 'claude',
    });
    assert.deepEqual(w, []);
  });

  it('Codex 检查 AGENTS/Codex skill 根并输出英文警告', () => {
    const home = mkdtempSync(join(tmpdir(), 'omk-isolation-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'omk-isolation-cwd-'));
    try {
      mkdirSync(join(home, '.agents', 'skills', 'example'), { recursive: true });
      const w = buildIsolationWarnings([mkArtifact('baseline')], false, {
        executorName: 'codex',
        lang: 'en',
        homeDir: home,
        cwd,
      });
      assert.equal(w.length, 1);
      assert.match(w[0], /discoverable by codex/);
      assert.match(w[0], /~\/\.agents\/skills/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
