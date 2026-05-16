/**
 * scripts/build-docs.ts 集成测试 — codegen 输出的 commands.md 内容稳定性。
 * 测试策略:
 * - 直接断言已提交的 .claude/skills/omk/references/commands.md(代表 codegen 结果)
 *   的 schema 性质:13 命令 H2 / 关键 flag 存在 / 子命令空格分隔 / `<%= config.bin %>` 已替换
 * - spawn `node dist/scripts/build-docs.js --check` 验证 --check 模式在不漂移时
 *   exit 0,在漂移时 exit 1。走 dist 而非 tsx,因为 tsx 装在 node_modules 时
 *   oclif Config.load 会自动 register tsx loader,把 ajv 等库的 .json 文件
 *   按 JS 解析,破坏 production 行为(详见 PR-D fix commit)。
 * - eval-samples 字段参考段不在 marker 内,codegen 后必须原样保留
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const COMMANDS_MD = join(PROJECT_ROOT, '.claude/skills/omk/references/commands.md');
const BUILD_DOCS = join(PROJECT_ROOT, 'dist/scripts/build-docs.js');

const MARKER_START = '<!-- omk:cli:start -->';
const MARKER_END = '<!-- omk:cli:end -->';

interface ExecError extends Error {
  code?: number;
  stdout: string;
  stderr: string;
}

function readMarkerBody(content: string): string {
  const s = content.indexOf(MARKER_START);
  const e = content.indexOf(MARKER_END);
  assert.ok(s !== -1 && e !== -1 && e > s, 'commands.md must contain markers');
  return content.slice(s + MARKER_START.length, e);
}

describe('scripts/build-docs codegen', () => {
  it('commands.md marker body covers all 13 oclif commands', () => {
    const content = readFileSync(COMMANDS_MD, 'utf8');
    const body = readMarkerBody(content);
    const expectedHeaders = [
      '## omk doctor',
      '## omk eval',
      '## omk eval gold compare',
      '## omk eval gold init',
      '## omk eval gold validate',
      '## omk evolve',
      '## omk init',
      '## omk observe',
      '## omk observe inbox',
      '## omk observe ingest',
      '## omk observe show',
      '## omk sample',
      '## omk studio',
    ];
    for (const h of expectedHeaders) {
      assert.ok(body.includes(`\n${h}\n`), `marker body missing H2 header "${h}"`);
    }
  });

  it('subcommand id (colon-separated internally) renders with spaces', () => {
    const content = readFileSync(COMMANDS_MD, 'utf8');
    // 不应出现 colon-id 风格(`eval:gold:init`)
    assert.ok(!content.includes('omk eval:gold:'), 'should not leak colon-id form');
    assert.ok(content.includes('omk eval gold init'), 'should render eval gold init with spaces');
  });

  it('`<%= config.bin %>` template is fully expanded', () => {
    const content = readFileSync(COMMANDS_MD, 'utf8');
    assert.ok(!content.includes('<%= config.bin %>'), 'template placeholder should be replaced');
  });

  it('flag descriptions are zh-only (no English line leaked through)', () => {
    const content = readFileSync(COMMANDS_MD, 'utf8');
    const body = readMarkerBody(content);
    // 选几个稳定的英文 keyword,出现就说明 pickLang 没切掉:
    // - "Preflight" (doctor.ts en description 头)
    // - "Init in" (init.ts en example description)
    // - "Output language zh|en" (lang flag en description)
    assert.ok(!body.includes('Preflight health checks'), 'doctor en description leaked');
    assert.ok(!body.includes('Init in current directory'), 'init en example leaked');
    assert.ok(!body.includes('Output language zh|en'), 'lang flag en description leaked');
  });

  it('doctor flags include --json --gate --static-only', () => {
    const content = readFileSync(COMMANDS_MD, 'utf8');
    const doctorIdx = content.indexOf('\n## omk doctor\n');
    const nextH2Idx = content.indexOf('\n## omk eval\n', doctorIdx + 1);
    assert.ok(doctorIdx !== -1 && nextH2Idx !== -1);
    const doctorBlock = content.slice(doctorIdx, nextH2Idx);
    assert.ok(doctorBlock.includes('`--json`'), 'doctor must list --json');
    assert.ok(doctorBlock.includes('`--gate`'), 'doctor must list --gate');
    assert.ok(doctorBlock.includes('`--static-only`'), 'doctor must list --static-only');
  });

  it('eval-samples appendix section is preserved outside markers', () => {
    const content = readFileSync(COMMANDS_MD, 'utf8');
    const endIdx = content.indexOf(MARKER_END);
    const tail = content.slice(endIdx + MARKER_END.length);
    assert.ok(tail.includes('## eval-samples 字段参考'), 'appendix must survive codegen');
    assert.ok(tail.includes('`sample_id`'), 'appendix table must survive');
    assert.ok(tail.includes('docs/sample-design-spec.md'), 'appendix link must survive');
  });

  it('--check mode passes on current committed state', async () => {
    const { stdout } = await execFileAsync(
      'node',
      [BUILD_DOCS, '--check'],
      { cwd: PROJECT_ROOT },
    );
    assert.ok(stdout.includes('in sync'), `expected in-sync message: ${stdout}`);
  }, 30000);

  it('--check mode fails on drift and prints diff', async () => {
    const original = readFileSync(COMMANDS_MD, 'utf8');
    // 注入一处明显 drift:在 marker body 里加一行
    const drifted = original.replace(
      MARKER_START,
      `${MARKER_START}\n<!-- DRIFT INJECTED FOR TEST -->`,
    );
    writeFileSync(COMMANDS_MD, drifted, 'utf8');
    try {
      await assert.rejects(
        () => execFileAsync('node', [BUILD_DOCS, '--check'], { cwd: PROJECT_ROOT }),
        (err: unknown) => {
          const e = err as ExecError;
          assert.equal(e.code, 1, `expected exit 1 on drift, got ${e.code}`);
          assert.ok(e.stderr.includes('drifted'), `stderr should mention drift: ${e.stderr.slice(0, 200)}`);
          return true;
        },
      );
    } finally {
      writeFileSync(COMMANDS_MD, original, 'utf8');
    }
  }, 30000);
});
