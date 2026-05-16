// scripts/build-docs.ts — 从 oclif Config 渲染 commands.md 的 marker 区段。
//
// 来源:src/cli/oclif/commands/*.ts(双语 description / examples / flags / args)。
// 目标:.claude/skills/omk/references/commands.md 的 <!-- omk:cli:start --> ... <!-- omk:cli:end --> 之间。
//
// 模式:
// - `yarn build:docs`(--write)→ 直接覆盖 marker 区段
// - `yarn build:docs:check`(--check)→ 比对磁盘内容,不一致 exit 1 + print diff(CI 用)
//
// 依赖 dist/ 存在(oclif config.commands 指向 ./dist/src/cli/oclif/commands),
// 跑之前必须先 `yarn build`。

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Config, type Command } from '@oclif/core';

const REPO_ROOT = resolve(process.cwd());
const COMMANDS_MD = resolve(REPO_ROOT, '.claude/skills/omk/references/commands.md');
const MARKER_START = '<!-- omk:cli:start -->';
const MARKER_END = '<!-- omk:cli:end -->';

// inline pickLang — 跟 src/cli/oclif/i18n.ts:36 行为一致,zh = `${zh}\n${en}` 首行。
// 本 script 是 build-time 工具,不进 npm 包;inline 避免引入 dist/ 路径 import 依赖。
function pickZh(text: string | undefined): string {
  if (!text) return '';
  const parts = text.split(/\r?\n/);
  if (parts.length < 2) return text;
  return parts[0] ?? '';
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

function renderArgs(cmd: Command.Loadable): string[] {
  const args = cmd.args ? Object.entries(cmd.args) : [];
  if (args.length === 0) return [];
  const out: string[] = ['**参数:**', ''];
  for (const [name, raw] of args) {
    const a = raw as ArgShape;
    const required = a.required ? '必填' : '可选';
    const desc = pickZh(a.description);
    out.push(`- \`${name}\`(${required})${desc ? `:${desc}` : ''}`);
  }
  out.push('');
  return out;
}

function renderFlagType(f: FlagShape): string {
  if (f.type === 'boolean') return '`boolean`';
  if (f.options && f.options.length > 0) return `\`${f.options.join('|')}\``;
  return '`option`';
}

function renderFlags(cmd: Command.Loadable): string[] {
  const flags = cmd.flags ? Object.entries(cmd.flags) : [];
  if (flags.length === 0) return [];
  const out: string[] = ['**Flags:**', ''];
  const sorted = [...flags].sort(([a], [b]) => a.localeCompare(b));
  for (const [name, raw] of sorted) {
    const f = raw as FlagShape;
    const parts: string[] = [`\`--${name}\``, renderFlagType(f)];
    if (f.default !== undefined && f.default !== null && f.default !== false) {
      parts.push(`(默认 \`${String(f.default)}\`)`);
    }
    if (f.env) parts.push(`(env \`${f.env}\`)`);
    const desc = pickZh(f.description);
    out.push(`- ${parts.join(' ')}${desc ? `:${desc}` : ''}`);
  }
  out.push('');
  return out;
}

function renderExamples(cmd: Command.Loadable, bin: string): string[] {
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
      const desc = pickZh(exo.description);
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

function renderCommand(cmd: Command.Loadable, bin: string): string[] {
  const idDisplay = cmd.id.split(':').join(' ');
  const lines: string[] = [];
  lines.push(`## ${bin} ${idDisplay}`);
  lines.push('');
  const desc = pickZh(cmd.description);
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
  lines.push(...renderArgs(cmd));
  lines.push(...renderFlags(cmd));
  lines.push(...renderExamples(cmd, bin));
  return lines;
}

async function generate(): Promise<string> {
  const config = await Config.load({ root: REPO_ROOT });
  const cmds = [...config.commands].sort((a, b) => a.id.localeCompare(b.id));
  const lines: string[] = [];
  lines.push('<!-- 此段由 scripts/build-docs.ts 从 src/cli/oclif/commands/ 自动生成。');
  lines.push('     改 CLI 后跑 `yarn build:docs` 同步,CI `yarn build:docs:check` 会拦截 drift。-->');
  lines.push('');
  for (const cmd of cmds) {
    lines.push(...renderCommand(cmd, config.bin));
  }
  // 去掉尾部多余空行,后面 compose 会自己加换行。
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

interface Split {
  pre: string;
  post: string;
}

function splitFile(content: string): Split | null {
  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return null;
  const pre = content.slice(0, startIdx + MARKER_START.length);
  const post = content.slice(endIdx);
  return { pre, post };
}

function compose(pre: string, body: string, post: string): string {
  return `${pre}\n${body}\n${post}`;
}

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

async function main(): Promise<void> {
  const mode = process.argv.includes('--check') ? 'check' : 'write';
  const current = readFileSync(COMMANDS_MD, 'utf8');
  const split = splitFile(current);
  if (!split) {
    process.stderr.write(
      `[build-docs] commands.md missing markers (${MARKER_START} / ${MARKER_END}).\n`,
    );
    process.stderr.write(`Add markers to ${COMMANDS_MD} before running.\n`);
    process.exit(2);
  }
  const body = await generate();
  const next = compose(split.pre, body, split.post);

  if (mode === 'check') {
    if (next === current) {
      process.stdout.write('[build-docs] commands.md is in sync with oclif source.\n');
      return;
    }
    process.stderr.write(
      '[build-docs] commands.md drifted from oclif source. Run `yarn build:docs` to regenerate.\n',
    );
    process.stderr.write('---\n');
    process.stderr.write(diffPreview(next, current));
    process.stderr.write('\n');
    process.exit(1);
  }

  if (next === current) {
    process.stdout.write('[build-docs] commands.md already up to date.\n');
    return;
  }
  writeFileSync(COMMANDS_MD, next, 'utf8');
  process.stdout.write(`[build-docs] wrote ${COMMANDS_MD}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
