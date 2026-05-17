// scripts/build-docs.ts — 从 oclif Config 渲染若干 markdown 文件的 marker 区段。
//
// 来源:src/cli/oclif/commands/*.ts(双语 description / examples / flags / args)。
//
// 目标(每条一个 Target):
// - commands.md(.claude/skills/omk/references/commands.md):整段 marker 包裹,
//   全命令 fullbody(13 个 oclif command 全输出)。
// - README.md / README.zh.md:per-command flags 模式,每个 H3 顶层命令独立 marker
//   对,内容只输出 flag list(README 已经手写 bash 示例和 prose,不重复)。
//
// 模式:
// - `yarn build:docs`(--write)→ 覆盖所有 target 的 marker 区段
// - `yarn build:docs:check`(--check)→ 比对磁盘内容,任一 target 不一致就 exit 1
//   + print diff(CI 用)
//
// 依赖 dist/ 存在(oclif config.commands 指向 ./dist/src/cli/oclif/commands),
// 跑之前必须先 `yarn build`。

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Config, type Command } from '@oclif/core';

const REPO_ROOT = resolve(process.cwd());

type Lang = 'zh' | 'en';

// inline pickLang — 跟 src/cli/oclif/i18n.ts:36 行为一致。description 是
// `${zh}\n${en}` 形式;zh = 第一行,en = 后续行 join。
function pickLang(text: string | undefined, lang: Lang): string {
  if (!text) return '';
  const parts = text.split(/\r?\n/);
  if (parts.length < 2) return text;
  if (lang === 'zh') return parts[0] ?? '';
  return parts.slice(1).join('\n');
}

interface FlagShape {
  type?: string;
  default?: unknown;
  options?: readonly string[];
  description?: string;
  env?: string;
  required?: boolean;
}

interface ArgShape {
  required?: boolean;
  description?: string;
}

interface ExampleObj {
  description?: string;
  command: string;
}

// ── commands.md(fullbody)渲染 ────────────────────────────────────────────────

function renderUsageLine(cmd: Command.Loadable, bin: string, idDisplay: string): string {
  const pieces = [bin, idDisplay];
  const args = cmd.args ? Object.entries(cmd.args) : [];
  for (const [name, raw] of args) {
    const a = raw as ArgShape;
    pieces.push(a.required ? `<${name}>` : `[${name}]`);
  }
  const flagCount = cmd.flags ? Object.keys(cmd.flags).length : 0;
  if (flagCount > 0) pieces.push('[flags]');
  return pieces.join(' ');
}

function renderArgsZh(cmd: Command.Loadable): string[] {
  const args = cmd.args ? Object.entries(cmd.args) : [];
  if (args.length === 0) return [];
  const out: string[] = ['**参数:**', ''];
  for (const [name, raw] of args) {
    const a = raw as ArgShape;
    const required = a.required ? '必填' : '可选';
    const desc = pickLang(a.description, 'zh');
    out.push(`- \`${name}\`(${required})${desc ? `:${desc}` : ''}`);
  }
  out.push('');
  return out;
}

function renderFlagTypeBracket(f: FlagShape): string {
  if (f.type === 'boolean') return '`boolean`';
  if (f.options && f.options.length > 0) return `\`${f.options.join('|')}\``;
  return '`option`';
}

function renderFlagsZhBullets(cmd: Command.Loadable): string[] {
  const flags = cmd.flags ? Object.entries(cmd.flags) : [];
  if (flags.length === 0) return [];
  const out: string[] = ['**Flags:**', ''];
  const sorted = [...flags].sort(([a], [b]) => a.localeCompare(b));
  for (const [name, raw] of sorted) {
    const f = raw as FlagShape;
    const parts: string[] = [`\`--${name}\``, renderFlagTypeBracket(f)];
    if (f.default !== undefined && f.default !== null && f.default !== false) {
      parts.push(`(默认 \`${String(f.default)}\`)`);
    }
    if (f.env) parts.push(`(env \`${f.env}\`)`);
    const desc = pickLang(f.description, 'zh');
    out.push(`- ${parts.join(' ')}${desc ? `:${desc}` : ''}`);
  }
  out.push('');
  return out;
}

function renderExamplesZh(cmd: Command.Loadable, bin: string): string[] {
  const examples = cmd.examples;
  if (!Array.isArray(examples) || examples.length === 0) return [];
  const out: string[] = ['**示例:**', ''];
  for (const ex of examples) {
    if (typeof ex === 'string') {
      const expanded = ex.replace(/<%= config\.bin %>/g, bin);
      out.push('```bash');
      out.push(expanded);
      out.push('```');
      out.push('');
    } else {
      const exo = ex as ExampleObj;
      const desc = pickLang(exo.description, 'zh');
      const text = exo.command.replace(/<%= config\.bin %>/g, bin);
      if (desc) {
        out.push(`> ${desc}`);
        out.push('');
      }
      out.push('```bash');
      out.push(text);
      out.push('```');
      out.push('');
    }
  }
  return out;
}

function renderCommandFullbody(cmd: Command.Loadable, bin: string): string[] {
  const idDisplay = cmd.id.split(':').join(' ');
  const lines: string[] = [];
  lines.push(`## ${bin} ${idDisplay}`);
  lines.push('');
  const desc = pickLang(cmd.description, 'zh');
  if (desc) {
    lines.push(desc);
    lines.push('');
  }
  lines.push('**用法:**');
  lines.push('');
  lines.push('```bash');
  lines.push(renderUsageLine(cmd, bin, idDisplay));
  lines.push('```');
  lines.push('');
  lines.push(...renderArgsZh(cmd));
  lines.push(...renderFlagsZhBullets(cmd));
  lines.push(...renderExamplesZh(cmd, bin));
  return lines;
}

function generateFullbody(config: Config): string {
  const cmds = [...config.commands].sort((a, b) => a.id.localeCompare(b.id));
  const lines: string[] = [];
  lines.push('<!-- 此段由 scripts/build-docs.ts 从 src/cli/oclif/commands/ 自动生成。');
  lines.push('     改 CLI 后跑 `yarn build:docs` 同步,CI `yarn build:docs:check` 会拦截 drift。-->');
  lines.push('');
  for (const cmd of cmds) {
    lines.push(...renderCommandFullbody(cmd, config.bin));
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

// ── README.md / README.zh.md(per-cmd-flags)渲染 ─────────────────────────────

function renderFlagTypeAngle(f: FlagShape): string {
  if (f.type === 'boolean') return '';
  if (f.options && f.options.length > 0) return `<${f.options.join('|')}>`;
  return '<value>';
}

// README ```text``` 风格:每行一个 flag,padding 对齐,描述用 pickLang 切 lang。
// 输出格式:
//   --flag-name <type>     description
function renderFlagsBlock(cmd: Command.Loadable, bin: string, lang: Lang): string {
  const flags = cmd.flags ? Object.entries(cmd.flags) : [];
  if (flags.length === 0) {
    const noFlagLine = lang === 'zh'
      ? `(\`${bin} ${cmd.id.split(':').join(' ')}\` 无 flag)`
      : `(\`${bin} ${cmd.id.split(':').join(' ')}\` has no flags)`;
    const helpHint = lang === 'zh'
      ? `完整描述见 \`${bin} ${cmd.id.split(':').join(' ')} --help\`。`
      : `For full descriptions: \`${bin} ${cmd.id.split(':').join(' ')} --help\`.`;
    return [noFlagLine, '', helpHint].join('\n');
  }
  const sorted = [...flags].sort(([a], [b]) => a.localeCompare(b));
  const labels = sorted.map(([name, raw]) => {
    const f = raw as FlagShape;
    const typePart = renderFlagTypeAngle(f);
    return typePart ? `--${name} ${typePart}` : `--${name}`;
  });
  const labelWidth = Math.max(...labels.map((l) => l.length));
  const padTo = Math.min(labelWidth, 30) + 2;
  const flagsLabel = lang === 'zh' ? '**Flags:**' : '**Flags:**';
  const helpHint = lang === 'zh'
    ? `完整描述见 \`${bin} ${cmd.id.split(':').join(' ')} --help\`。`
    : `For full descriptions: \`${bin} ${cmd.id.split(':').join(' ')} --help\`.`;

  const lines: string[] = [];
  lines.push(flagsLabel);
  lines.push('');
  lines.push('```text');
  for (let i = 0; i < sorted.length; i++) {
    const [, raw] = sorted[i]!;
    const f = raw as FlagShape;
    const label = labels[i]!;
    const desc = pickLang(f.description, lang);
    const padded = label.padEnd(padTo, ' ');
    lines.push(`  ${padded}${desc}`);
  }
  lines.push('```');
  lines.push('');
  lines.push(helpHint);
  return lines.join('\n');
}

// ── 目标 / marker 定义 ─────────────────────────────────────────────────────────

interface FullbodyTarget {
  mode: 'fullbody';
  file: string;
  markerStart: string;
  markerEnd: string;
}

interface PerCmdFlagsTarget {
  mode: 'per-cmd-flags';
  file: string;
  lang: Lang;
  // 哪些 oclif top-level id 在 README 里出现。注:eval 是 top-level,eval gold *
  // 是 sub-sub,不在 README 展开;observe 是 top-level,observe inbox/ingest/show
  // 是 sub,也不在 README 展开。集合定义在 TOP_LEVEL_IDS,test/scripts/
  // build-docs.test.ts 用 Config.load 动态校验该集合等于 oclif 实际顶层命令集,
  // 防止漏更新。
  topLevelIds: readonly string[];
}

type Target = FullbodyTarget | PerCmdFlagsTarget;

/**
 * omk 顶层命令 id 列表(README per-cmd-flags + SKILL.md argument-hint 共用)。
 * 此常量是单一来源,oclif 顶层命令集真值在 src/cli/oclif/commands/ 文件目录,
 * test 跑 Config.load 动态校验两者一致。
 */
export const TOP_LEVEL_IDS = [
  'init',
  'doctor',
  'eval',
  'observe',
  'evolve',
  'sample',
  'studio',
] as const;

const TARGETS: Target[] = [
  {
    mode: 'fullbody',
    file: '.claude/skills/omk/references/commands.md',
    markerStart: '<!-- omk:cli:start -->',
    markerEnd: '<!-- omk:cli:end -->',
  },
  {
    mode: 'per-cmd-flags',
    file: 'README.md',
    lang: 'en',
    topLevelIds: TOP_LEVEL_IDS,
  },
  {
    mode: 'per-cmd-flags',
    file: 'README.zh.md',
    lang: 'zh',
    topLevelIds: TOP_LEVEL_IDS,
  },
];

// ── marker 区段定位 + 替换 ─────────────────────────────────────────────────────

interface Split {
  pre: string;
  post: string;
}

function splitOnMarker(content: string, markerStart: string, markerEnd: string): Split | null {
  const startIdx = content.indexOf(markerStart);
  if (startIdx === -1) return null;
  // 找 startIdx 之后的最近 markerEnd,避免文档别处出现 markerEnd 字面量时静默错位。
  const endIdx = content.indexOf(markerEnd, startIdx + markerStart.length);
  if (endIdx === -1) return null;
  // 防御 marker 重复:出现 ≥ 2 个 start 表示文档结构有问题,直接拒绝(优于乱配对)。
  const dupStart = content.indexOf(markerStart, startIdx + markerStart.length);
  if (dupStart !== -1 && dupStart < endIdx) return null;
  const pre = content.slice(0, startIdx + markerStart.length);
  const post = content.slice(endIdx);
  return { pre, post };
}

function composeFullbody(content: string, body: string, target: FullbodyTarget): { next: string; error?: string } {
  const split = splitOnMarker(content, target.markerStart, target.markerEnd);
  if (!split) {
    return { next: content, error: `missing markers ${target.markerStart} / ${target.markerEnd}` };
  }
  const next = `${split.pre}\n${body}\n${split.post}`;
  return { next };
}

function flagsMarkerStart(id: string): string {
  return `<!-- omk:cli:${id}:flags:start -->`;
}
function flagsMarkerEnd(id: string): string {
  return `<!-- omk:cli:${id}:flags:end -->`;
}

function composePerCmdFlags(
  content: string,
  config: Config,
  target: PerCmdFlagsTarget,
): { next: string; missing: string[] } {
  let next = content;
  const missing: string[] = [];
  for (const id of target.topLevelIds) {
    const cmd = config.commands.find((c) => c.id === id);
    if (!cmd) {
      missing.push(`oclif command not found: ${id}`);
      continue;
    }
    const start = flagsMarkerStart(id);
    const end = flagsMarkerEnd(id);
    const split = splitOnMarker(next, start, end);
    if (!split) {
      missing.push(`missing marker pair for ${id} (${start} / ${end})`);
      continue;
    }
    const body = renderFlagsBlock(cmd, config.bin, target.lang);
    next = `${split.pre}\n\n${body}\n\n${split.post}`;
  }
  return { next, missing };
}

// ── diff print ────────────────────────────────────────────────────────────────

function diffPreview(expected: string, actual: string): string {
  const eLines = expected.split('\n');
  const aLines = actual.split('\n');
  const max = Math.max(eLines.length, aLines.length);
  const out: string[] = [];
  let shown = 0;
  for (let i = 0; i < max; i++) {
    if (eLines[i] !== aLines[i]) {
      out.push(`L${i + 1}:`);
      out.push(`  - actual:   ${JSON.stringify(aLines[i])}`);
      out.push(`  + expected: ${JSON.stringify(eLines[i])}`);
      shown++;
      if (shown >= 20) {
        out.push('...(diff truncated, run `yarn build:docs` to see full update)');
        break;
      }
    }
  }
  return out.join('\n');
}

// ── 主循环 ────────────────────────────────────────────────────────────────────

interface TargetResult {
  file: string;
  current: string;
  next: string;
  missingMarkers: string[];
}

async function generateAll(): Promise<TargetResult[]> {
  const config = await Config.load({ root: REPO_ROOT });
  const results: TargetResult[] = [];
  for (const target of TARGETS) {
    const absPath = resolve(REPO_ROOT, target.file);
    const current = readFileSync(absPath, 'utf8');
    if (target.mode === 'fullbody') {
      const body = generateFullbody(config);
      const { next, error } = composeFullbody(current, body, target);
      results.push({
        file: target.file,
        current,
        next,
        missingMarkers: error ? [error] : [],
      });
    } else {
      const { next, missing } = composePerCmdFlags(current, config, target);
      results.push({
        file: target.file,
        current,
        next,
        missingMarkers: missing,
      });
    }
  }
  return results;
}

async function main(): Promise<void> {
  const mode = process.argv.includes('--check') ? 'check' : 'write';
  const results = await generateAll();

  // 任一 target 缺 marker 就 hard exit 2,提示用户手补
  const missingByFile = results.filter((r) => r.missingMarkers.length > 0);
  if (missingByFile.length > 0) {
    process.stderr.write('[build-docs] missing markers:\n');
    for (const r of missingByFile) {
      for (const m of r.missingMarkers) {
        process.stderr.write(`  ${r.file}: ${m}\n`);
      }
    }
    process.stderr.write('Add the marker pair(s) and re-run.\n');
    process.exit(2);
  }

  if (mode === 'check') {
    const drifted = results.filter((r) => r.next !== r.current);
    if (drifted.length === 0) {
      process.stdout.write('[build-docs] all targets in sync with oclif source.\n');
      return;
    }
    process.stderr.write(
      '[build-docs] drifted from oclif source. Run `yarn build:docs` to regenerate.\n',
    );
    for (const r of drifted) {
      process.stderr.write(`\n--- ${r.file} ---\n`);
      process.stderr.write(diffPreview(r.next, r.current));
      process.stderr.write('\n');
    }
    process.exit(1);
  }

  let wrote = 0;
  for (const r of results) {
    if (r.next === r.current) continue;
    writeFileSync(resolve(REPO_ROOT, r.file), r.next, 'utf8');
    process.stdout.write(`[build-docs] wrote ${r.file}\n`);
    wrote++;
  }
  if (wrote === 0) {
    process.stdout.write('[build-docs] all targets already up to date.\n');
  }
}

// 只在直接 `node dist/scripts/build-docs.js ...` 跑时进 main();被 test 当 module
// import 时不跑(test 只要 TOP_LEVEL_IDS 常量)。
const isMain = process.argv[1] && /build-docs\.js$/.test(process.argv[1]);
if (isMain) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
