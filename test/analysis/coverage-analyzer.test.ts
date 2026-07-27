import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildFullKnowledgeIndex,
  buildKnowledgeIndex,
  computeCoverage,
  extractReferencedPaths,
  normalizeKnowledgePath,
} from '../../src/analysis/coverage-analyzer.js';
import type { ResultEntry, ToolCallInfo, VariantResult } from '../../src/types/index.js';

function variantWithRead(filePath: string): VariantResult {
  return {
    ok: true,
    durationMs: 1,
    durationApiMs: 1,
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    execCostUSD: 0,
    judgeCostUSD: 0,
    costUSD: 0,
    numTurns: 1,
    outputPreview: 'done',
    toolCalls: [{
      tool: 'Read',
      input: { file_path: filePath },
      output: 'done',
      success: true,
    }],
  };
}

function variantWithTool(toolCall: ToolCallInfo): VariantResult {
  return {
    ...variantWithRead('unused'),
    toolCalls: [toolCall],
  };
}

describe('source-neutral knowledge coverage', () => {
  it('indexes neutral and provider-compatible instruction roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-coverage-roots-'));
    try {
      mkdirSync(join(root, '.agents', 'skills', 'neutral'), { recursive: true });
      mkdirSync(join(root, '.claude', 'knowledge'), { recursive: true });
      mkdirSync(join(root, '.codex', 'skills', 'codex'), { recursive: true });
      mkdirSync(join(root, '.gemini', 'skills', 'gemini'), { recursive: true });
      writeFileSync(join(root, '.agents', 'skills', 'neutral', 'SKILL.md'), '# neutral');
      writeFileSync(join(root, '.claude', 'knowledge', 'legacy.md'), '# legacy');
      writeFileSync(join(root, '.codex', 'skills', 'codex', 'SKILL.md'), '# codex');
      writeFileSync(join(root, '.gemini', 'skills', 'gemini', 'SKILL.md'), '# gemini');
      writeFileSync(join(root, 'AGENTS.md'), '# agents');
      writeFileSync(join(root, 'CLAUDE.md'), '# claude');

      const paths = buildKnowledgeIndex(root).entries.map((entry) => entry.path);
      assert.deepEqual(paths, [
        '.agents/skills/neutral/SKILL.md',
        '.claude/knowledge/legacy.md',
        '.codex/skills/codex/SKILL.md',
        '.gemini/skills/gemini/SKILL.md',
        'AGENTS.md',
        'CLAUDE.md',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('counts a symlinked skill tree only once', () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-coverage-symlink-'));
    try {
      const neutral = join(root, '.agents', 'skills', 'shared');
      mkdirSync(neutral, { recursive: true });
      mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
      writeFileSync(join(neutral, 'SKILL.md'), '# shared');
      symlinkSync(neutral, join(root, '.claude', 'skills', 'shared'), 'dir');

      const index = buildKnowledgeIndex(root);
      assert.equal(index.entries.length, 1);
      assert.equal(index.entries[0].path, '.agents/skills/shared/SKILL.md');
      assert.deepEqual(index.entries[0].aliases, ['.claude/skills/shared/SKILL.md']);

      const results: ResultEntry[] = [{
        sample_id: 's1',
        variants: {
          treatment: variantWithRead(join(root, '.claude', 'skills', 'shared', 'SKILL.md')),
        },
      }];
      const coverage = computeCoverage(results, 'treatment', index, root);
      assert.equal(coverage.filesTotal, 1);
      assert.equal(coverage.filesCovered, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('discovers local artifact references but rejects paths outside the root', () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-coverage-refs-'));
    try {
      mkdirSync(join(root, 'references'), { recursive: true });
      writeFileSync(join(root, 'references', 'guide.md'), '# guide');
      const content = [
        '[guide](references/guide.md)',
        '[outside](../outside.md)',
      ].join('\n');

      assert.deepEqual(
        extractReferencedPaths(content).sort(),
        ['../outside.md', 'references/guide.md'],
      );
      const paths = buildFullKnowledgeIndex(content, root).entries.map((entry) => entry.path);
      assert.deepEqual(paths, ['references/guide.md']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not count a suffix-colliding filename as accessed', () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-coverage-match-'));
    try {
      const results: ResultEntry[] = [{
        sample_id: 's1',
        variants: {
          treatment: variantWithRead(join(root, 'references', 'notfoo.md')),
        },
      }];
      const coverage = computeCoverage(results, 'treatment', {
        entries: [{ path: 'foo.md', type: 'other' }],
        totalFiles: 1,
        totalLines: 0,
      }, root);

      assert.equal(coverage.filesCovered, 0);
      assert.equal(coverage.entries[0].accessed, false);
      assert.equal(
        normalizeKnowledgePath(join(root, 'references', 'foo.md'), root),
        'references/foo.md',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('counts successful Codex shell reads but not failed reads', () => {
    const index = {
      entries: [{ path: '.agents/skills/review/SKILL.md', type: 'other' as const }],
      totalFiles: 1,
      totalLines: 0,
    };
    const successful: ResultEntry[] = [{
      sample_id: 's1',
      variants: {
        treatment: variantWithTool({
          tool: 'Bash',
          sourceTool: 'command_execution',
          input: { command: "sed -n '1,20p' .agents/skills/review/SKILL.md" },
          output: '# review',
          status: 'success',
          statusSource: 'runtime',
          success: true,
        }),
      },
    }];
    const failed: ResultEntry[] = [{
      sample_id: 's1',
      variants: {
        treatment: variantWithTool({
          tool: 'Read',
          input: { file_path: '.agents/skills/review/SKILL.md' },
          output: 'not found',
          status: 'failure',
          statusSource: 'runtime',
          success: false,
        }),
      },
    }];

    assert.equal(computeCoverage(successful, 'treatment', index).filesCovered, 1);
    assert.equal(computeCoverage(failed, 'treatment', index).filesCovered, 0);
  });
});
