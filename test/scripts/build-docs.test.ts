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
import { Config } from '@oclif/core';
// 从 build-docs.ts 直接 import 单一来源(避免在 test 里硬编码),让 README codegen
// 跟 SKILL.md frontmatter gate 共用同一份 TOP_LEVEL_IDS。
import { TOP_LEVEL_IDS } from '../../scripts/build-docs.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const COMMANDS_MD = join(PROJECT_ROOT, '.claude/skills/omk/references/commands.md');
const README_EN = join(PROJECT_ROOT, 'README.md');
const README_ZH = join(PROJECT_ROOT, 'README.zh.md');
const SKILL_MD = join(PROJECT_ROOT, 'SKILL.md');
const BUILD_DOCS = join(PROJECT_ROOT, 'dist/scripts/build-docs.js');

const MARKER_START = '<!-- omk:cli:start -->';
const MARKER_END = '<!-- omk:cli:end -->';

function readFlagsBlock(content: string, id: string): string {
  const start = `<!-- omk:cli:${id}:flags:start -->`;
  const end = `<!-- omk:cli:${id}:flags:end -->`;
  const s = content.indexOf(start);
  const e = content.indexOf(end);
  assert.ok(s !== -1 && e !== -1 && e > s, `marker pair for ${id} not found`);
  return content.slice(s + start.length, e);
}

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

  it('README.md has 7 marker pairs for top-level oclif commands', () => {
    const content = readFileSync(README_EN, 'utf8');
    for (const id of TOP_LEVEL_IDS) {
      assert.ok(
        content.includes(`<!-- omk:cli:${id}:flags:start -->`),
        `README.md missing marker start for ${id}`,
      );
      assert.ok(
        content.includes(`<!-- omk:cli:${id}:flags:end -->`),
        `README.md missing marker end for ${id}`,
      );
    }
  });

  it('README.zh.md has 7 marker pairs for top-level oclif commands', () => {
    const content = readFileSync(README_ZH, 'utf8');
    for (const id of TOP_LEVEL_IDS) {
      assert.ok(
        content.includes(`<!-- omk:cli:${id}:flags:start -->`),
        `README.zh.md missing marker start for ${id}`,
      );
      assert.ok(
        content.includes(`<!-- omk:cli:${id}:flags:end -->`),
        `README.zh.md missing marker end for ${id}`,
      );
    }
  });

  it('README.md eval flags block contains English descriptions (en pickLang)', () => {
    const content = readFileSync(README_EN, 'utf8');
    const block = readFlagsBlock(content, 'eval');
    assert.ok(block.includes('--bootstrap-samples'), 'must list --bootstrap-samples');
    assert.ok(block.includes('--judge-models'), 'must list --judge-models');
    // 英文 keyword 出现 → pickLang('en') 工作正确
    assert.ok(/Bootstrap resamples|Judge model/i.test(block), `expected EN descriptions: ${block.slice(0, 400)}`);
    // 中文 description 头部不应出现 — 防止 pickLang 选错语言
    assert.ok(!/被测模型|样本文件路径/.test(block), `zh description leaked into README.md: ${block.slice(0, 400)}`);
    assert.ok(block.includes('For full descriptions:'), 'must include EN help hint footer');
  });

  it('README.zh.md eval flags block contains Chinese descriptions (zh pickLang)', () => {
    const content = readFileSync(README_ZH, 'utf8');
    const block = readFlagsBlock(content, 'eval');
    assert.ok(block.includes('--bootstrap-samples'), 'must list --bootstrap-samples');
    // 中文 keyword 出现
    assert.ok(/被测模型|样本文件路径|评委/.test(block), `expected zh descriptions: ${block.slice(0, 400)}`);
    // 英文 description 不应出现
    assert.ok(!/Bootstrap resamples/.test(block), `en description leaked into README.zh.md: ${block.slice(0, 400)}`);
    assert.ok(block.includes('完整描述见'), 'must include zh help hint footer');
  });

  it('README.md hand-curated prose around eval flags is preserved', () => {
    const content = readFileSync(README_EN, 'utf8');
    // 这些 prose 在 marker 之外,本 codegen 不应触碰
    assert.ok(content.includes('Runs the offline evaluation, applies the verdict gate'), 'eval intro prose missing');
    assert.ok(content.includes('The HTML report has two tabs'), 'HTML report two-tabs prose missing');
    assert.ok(content.includes('Static-only mode'), 'doctor static-only prose missing');
    assert.ok(content.includes('Studio is skill-centric'), 'Studio IA prose missing');
  });

  it('README.zh.md hand-curated prose preserved', () => {
    const content = readFileSync(README_ZH, 'utf8');
    assert.ok(content.includes('运行离线评测'), 'eval intro zh prose missing');
    assert.ok(content.includes('HTML 报告有两个 tab'), 'HTML 报告 tabs zh prose missing');
    assert.ok(content.includes('离线静态模式'), 'doctor static-only zh prose missing');
  });

  it('README.md eval block has flags in alphabetic order', () => {
    const content = readFileSync(README_EN, 'utf8');
    const block = readFlagsBlock(content, 'eval');
    // 抽两个稳定的 flag 名,看出现顺序符合 alphabetic
    const idxBatch = block.indexOf('--batch');
    const idxConcurrency = block.indexOf('--concurrency');
    const idxThreshold = block.indexOf('--threshold');
    assert.ok(idxBatch !== -1 && idxConcurrency !== -1 && idxThreshold !== -1);
    assert.ok(idxBatch < idxConcurrency, '--batch should precede --concurrency');
    assert.ok(idxConcurrency < idxThreshold, '--concurrency should precede --threshold');
  });

  it('TOP_LEVEL_IDS constant matches actual oclif top-level command set (Config.load)', async () => {
    // 动态绑定:Config.load 读 dist/src/cli/oclif/commands/ 真实命令文件,过滤
    // 出顶层命令(id 不含 ':'),跟 scripts/build-docs.ts 导出的 TOP_LEVEL_IDS
    // 严格 set 相等。未来新增 / 删 / 重命名顶层命令时,只改 oclif Command 源忘
    // 改 TOP_LEVEL_IDS 就会被本测试 fail 拦住。
    const config = await Config.load({ root: PROJECT_ROOT });
    const actual = config.commands
      .map((c) => c.id)
      .filter((id) => !id.includes(':'))
      .sort();
    const expected = [...TOP_LEVEL_IDS].sort();
    assert.deepEqual(
      actual,
      expected,
      `TOP_LEVEL_IDS drifted from oclif Config.commands top-level set.\n` +
      `  expected: ${expected.join(', ')}\n` +
      `  actual:   ${actual.join(', ')}`,
    );
  }, 30000);

  it('SKILL.md argument-hint frontmatter matches oclif top-level command set', () => {
    // SKILL.md frontmatter L7 形如:
    //   argument-hint: "<init|doctor|eval|observe|evolve|sample|studio> [options]"
    // 历史上 omk 顶层命令树重构过两次(bench run → eval、improve → evolve、
    // export → sample),每次都靠人工同步这一行。本测试把它锁住:argument-hint
    // 列出的 7 个 id 必须跟 TOP_LEVEL_IDS 严格一致(set 比较,顺序无关)。
    // 未来重命名 / 增删顶层命令时,reviewer 改 oclif Command 文件 → 改
    // TOP_LEVEL_IDS → 本测试逼着同步 SKILL.md。
    const content = readFileSync(SKILL_MD, 'utf8');
    const match = content.match(/^argument-hint:\s*"<([^>]+)>/m);
    assert.ok(match, 'SKILL.md frontmatter must contain argument-hint: "<...>" pattern');
    const listed = match[1]!.split('|').map((s) => s.trim()).filter(Boolean);
    const expected = [...TOP_LEVEL_IDS].sort();
    const actual = [...listed].sort();
    assert.deepEqual(
      actual,
      expected,
      `SKILL.md argument-hint command list drifted from oclif top-level set.\n` +
      `  expected: ${expected.join('|')}\n` +
      `  actual:   ${actual.join('|')}`,
    );
  });
});
