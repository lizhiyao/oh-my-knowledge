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

  it('SKILL.md ships with Claude Code-compatible frontmatter so the file is deployable as-is', () => {
    execFileSync('node', [CLI, 'bench', 'init', tmpDir], { stdio: 'pipe' });

    const v1Content = readFileSync(join(tmpDir, 'skills', 'code-review-v1', 'SKILL.md'), 'utf-8');
    const v2Content = readFileSync(join(tmpDir, 'skills', 'code-review-v2', 'SKILL.md'), 'utf-8');

    // Frontmatter must be present so a user can drop the file straight into
    // ~/.claude/skills/ for Claude Code without hand-editing. Both `name` and
    // `description` are required by the Claude Code SKILL.md spec.
    assert.ok(v1Content.startsWith('---'), 'v1 has frontmatter delimiter');
    assert.ok(v2Content.startsWith('---'), 'v2 has frontmatter delimiter');

    assert.match(v1Content, /^---\r?\nname:\s*code-review-v1\r?\n/m, 'v1 name matches dir');
    assert.match(v1Content, /^description:\s*\S+/m, 'v1 has description');
    assert.match(v2Content, /^---\r?\nname:\s*code-review-v2\r?\n/m, 'v2 name matches dir');
    assert.match(v2Content, /^description:\s*\S+/m, 'v2 has description');

    // Markdown body is still present after frontmatter so omk evaluation has content to inject.
    assert.match(v1Content, /# Code review v1/, 'v1 markdown body intact');
    assert.match(v2Content, /# Code review v2/, 'v2 markdown body intact');
    assert.match(v2Content, /安全性|健壮性|可维护性|性能/, 'v2 keeps the four-dimension prompt');
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

  it('next-step output explains evaluation injection, cross-executor parity, and the directory-level deploy path', () => {
    const output = execFileSync('node', [CLI, 'bench', 'init', tmpDir], { encoding: 'utf-8' });
    assert.match(output, /code-review-v1\/SKILL\.md/);
    assert.match(output, /code-review-v2\/SKILL\.md/);

    // Evaluation path: omk injects SKILL.md as system prompt uniformly across executors.
    // The note must NOT claim Claude executor goes through native skill auto-discovery,
    // because that's the runtime mechanism (~/.claude/skills/), not omk's eval path.
    assert.match(output, /system prompt|system 注入/);
    assert.match(output, /跨 executor|cross-executor|claude.*codex|codex.*claude/);
    assert.doesNotMatch(output, /Claude executor 走 native skill/);

    // Deploy path: must point at ~/.claude/skills/<name>/ as a directory, not just the file.
    assert.match(output, /~\/\.claude\/skills\/code-review-v1|the whole directory|整个目录|整目录/);
  });
});
