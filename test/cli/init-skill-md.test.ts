import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveArtifacts } from '../../src/inputs/skill-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI = join(__dirname, '..', '..', 'dist', 'src', 'cli', 'index.js');

describe('omk bench init produces directory-skill SKILL.md layout', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'omk-init-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates two directory-skill variants under skills/', () => {
    execFileSync('node', [CLI, 'bench', 'init', tmpDir], { stdio: 'pipe' });

    assert.ok(existsSync(join(tmpDir, 'skills', 'code-review-v1')), 'v1 skill dir');
    assert.ok(existsSync(join(tmpDir, 'skills', 'code-review-v2')), 'v2 skill dir');
    assert.ok(statSync(join(tmpDir, 'skills', 'code-review-v1')).isDirectory(), 'v1 is a dir');

    assert.ok(existsSync(join(tmpDir, 'skills', 'code-review-v1', 'SKILL.md')), 'v1 SKILL.md');
    assert.ok(existsSync(join(tmpDir, 'skills', 'code-review-v2', 'SKILL.md')), 'v2 SKILL.md');
    assert.ok(existsSync(join(tmpDir, 'eval-samples.json')), 'eval-samples.json');

    // Old flat layout must not coexist (would collide with directory-skill discovery).
    assert.ok(!existsSync(join(tmpDir, 'skills', 'v1.md')), 'no flat v1.md');
    assert.ok(!existsSync(join(tmpDir, 'skills', 'v2.md')), 'no flat v2.md');
  });

  it('SKILL.md is plain markdown without frontmatter (omk convention)', () => {
    execFileSync('node', [CLI, 'bench', 'init', tmpDir], { stdio: 'pipe' });

    const v1Content = readFileSync(join(tmpDir, 'skills', 'code-review-v1', 'SKILL.md'), 'utf-8');
    const v2Content = readFileSync(join(tmpDir, 'skills', 'code-review-v2', 'SKILL.md'), 'utf-8');

    // No YAML frontmatter delimiter at file head — frontmatter would leak into the
    // injected system prompt because omk's loader currently only parses `preflight:`
    // and otherwise returns content unchanged.
    assert.ok(!v1Content.startsWith('---'), 'v1 has no frontmatter');
    assert.ok(!v2Content.startsWith('---'), 'v2 has no frontmatter');

    assert.match(v1Content, /^# Code review v1/, 'v1 starts with markdown title');
    assert.match(v2Content, /^# Code review v2/, 'v2 starts with markdown title');
    assert.match(v2Content, /安全性|健壮性|可维护性|性能/, 'v2 has the four-dimension prompt');
  });

  it('skill loader resolves the produced layout as directory-skill artifacts', () => {
    execFileSync('node', [CLI, 'bench', 'init', tmpDir], { stdio: 'pipe' });

    const artifacts = resolveArtifacts(
      join(tmpDir, 'skills'),
      ['code-review-v1', 'code-review-v2'],
    );

    assert.equal(artifacts.length, 2);
    for (const a of artifacts) {
      assert.equal(a.kind, 'skill');
      assert.equal(a.source, 'variant-name');
      assert.ok(a.skillRoot, 'directory-skill should set skillRoot');
      assert.ok(a.locator?.endsWith('SKILL.md'), 'locator points at SKILL.md');
      assert.ok(a.content && a.content.length > 0, 'content non-empty');
    }
  });

  it('next-step output mentions the new SKILL.md path and codex fallback note', () => {
    const output = execFileSync('node', [CLI, 'bench', 'init', tmpDir], { encoding: 'utf-8' });
    assert.match(output, /code-review-v1\/SKILL\.md/);
    assert.match(output, /code-review-v2\/SKILL\.md/);
    // codex fallback hint must appear in the default-language output (zh) so
    // newcomers running on a codex-class executor see why frontmatter doesn't apply.
    assert.match(output, /Codex|codex/);
    assert.match(output, /native skill|fallback|拼接|prompt 头部/);
  });
});
