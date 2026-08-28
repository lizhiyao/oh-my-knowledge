/**
 * 全仓 user-facing markdown 的 `omk <cmd>` 引用 grep gate。
 *
 * issue #109 立项时点名漂移过的剧情(`omk bench run` → `eval`、`improve` → `evolve`、
 * `omk export` 下线后仍被 README/SKILL.md 引用)就是「真实命令树重构后,docs 跟不上」
 * 的典型 sample。PR #120 给 SKILL.md frontmatter argument-hint 加了 vitest gate,
 * 但 SKILL.md body 36 处 cmd refs、quickstart-skill-eval.md 的 26 处、roadmap.md
 * 等仍裸跑没保护。
 *
 * 本测试 scan 全仓 user-facing markdown,把 `omk <cmd>` 第一 token 跟 oclif Config
 * 真值集合比对,任何 stale / typo / removed 命令都会被拦。真值来自
 * `getTopLevelIds(Config.load)`(scripts/build-docs.ts 已经收口为单一派生函数),
 * oclif Command 文件目录是唯一真值源。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '@oclif/core';
import { getTopLevelIds } from '../../scripts/build-docs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');

// scan 范围:user-facing markdown(README / SKILL / docs / agent prompt / 贡献者指南)。
// 测量学 fixture(test/__snapshots__)、生成文件(dist/)、依赖(node_modules/)不进。
const SCAN_DIRS = [
  'docs',
  '.agents/skills/omk',
];
const SCAN_FILES = [
  'README.md',
  'README.zh.md',
  'SKILL.md',
  'CONTRIBUTING.md',
  'AGENTS.md',
];

// 命令引用必须是「机读形态」:fenced code block(```)内 或 inline code(反引号)。
// 英文叙述里 `omk asks the AI...` / `omk runtime 匹配...` / `Use omk to ...`
// 的 prose 形式不在校验范围 — 那种是名词短语,不是命令调用。
//
// 两条正则:
//   INLINE_CODE_CMD:`omk <cmd>` 必须紧跟反引号(inline code 起始)
//   FENCED_CMD:在 ``` ... ``` 内的任意 `omk <cmd>`；`$omk ...` 是 Skill 调用，
//   不属于 CLI 命令引用。
const INLINE_CODE_CMD = /`omk\s+([a-z][a-z-]*)/g;
const FENCED_CMD = /(?<![\w$-])omk\s+([a-z][a-z-]*)/g;

interface Violation {
  file: string;
  line: number;
  token: string;
  context: string;
}

function collectMarkdownFiles(): string[] {
  const out: string[] = [];
  for (const rel of SCAN_FILES) {
    out.push(join(PROJECT_ROOT, rel));
  }
  for (const rel of SCAN_DIRS) {
    walkMarkdown(join(PROJECT_ROOT, rel), out);
  }
  return out;
}

function walkMarkdown(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = String(entry.name);
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    if (entry.isDirectory()) {
      walkMarkdown(full, out);
    } else if (entry.isFile() && name.endsWith('.md')) {
      out.push(full);
    }
  }
}

describe('markdown `omk <cmd>` 引用 grep gate', () => {
  it('全仓 user-facing markdown 里的 `omk <cmd>` 第一 token 必须是真实 oclif top-level 命令', async () => {
    const config = await Config.load({ root: PROJECT_ROOT });
    const truth = new Set(getTopLevelIds(config));

    const files = collectMarkdownFiles();
    const violations: Violation[] = [];

    for (const abs of files) {
      let text: string;
      try {
        text = readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n');
      let inFence = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (/^\s*```/.test(line)) {
          inFence = !inFence;
          continue;
        }
        // fenced code block 里的 shell 注释行(# 开头)不算命令引用 — bash 注释里
        // 的 prose 跟 markdown 散文是同一性质,不应 strict 校验。
        if (inFence && /^\s*#/.test(line)) continue;
        const regex = inFence ? FENCED_CMD : INLINE_CODE_CMD;
        regex.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = regex.exec(line)) !== null) {
          const token = m[1]!;
          if (!truth.has(token)) {
            violations.push({
              file: relative(PROJECT_ROOT, abs),
              line: i + 1,
              token,
              context: line.trim().slice(0, 120),
            });
          }
        }
      }
    }

    if (violations.length > 0) {
      const dump = violations
        .map((v) => `  ${v.file}:${v.line}  'omk ${v.token}'  | ${v.context}`)
        .join('\n');
      assert.fail(
        `发现 ${violations.length} 处未知 / stale omk 命令引用\n` +
        `(allowlist: ${[...truth].sort().join(', ')}):\n${dump}\n\n` +
        `修法:改 markdown 里的命令引用,或者(如果该命令确实应该存在)加 ` +
        `src/cli/commands/<cmd>.ts 后重新 yarn build。`,
      );
    }
  }, 30000);
});

// ---- flag-drift gate ------------------------------------------------------
// 同一类「文档跟不上代码」漂移的另一面:命令名对了,但 flag 名是 stale/typo
// (如 `--skip-preflight` 实为 `--skip-doctor`、`--debias-length` 实为
// `--no-debias-length`、`--artifact-kind` 根本不是 flag)。真值是 oclif 全部
// 命令(含 `eval gold` / `observe` 子命令)的 flag 名并集 + help/version。
//
// 只校验出现在 `omk ...` 调用里的 flag:prose 里描述 codex 的 `--ephemeral`、
// git 的 `--pretty`、claude 的 `--disallowedTools` 等不在 omk 调用上,天然排除。
// 整文件跳过清单(如某文档故意描述尚未实现的 flag)放这里;当前为空。
const FLAG_SCAN_EXCLUDE = new Set<string>([
]);

// omk 调用形态:用户向的 `omk <cmd>`,以及 dev 文档里的 `node dist/cli/index.js <cmd>`。
const OMK_INVOCATION = /(?<![\w$-])(?:omk|index\.js)\s+[a-z][a-z-]*/;
const FLAG_TOKEN = /--([a-z][a-z0-9-]*)/g;

function collectOmkFlagNames(config: Config): Set<string> {
  const names = new Set<string>(['help', 'version']);
  for (const cmd of config.commands) {
    for (const name of Object.keys(cmd.flags ?? {})) names.add(name);
  }
  return names;
}

// 只校验命令 token 之后的 flag — `node --watch dist/cli/index.js eval` 里的 `--watch`
// 是 node 的 flag,在 `index.js eval` 之前,不算 omk flag。
function scanInvocationFlags(
  text: string,
  file: string,
  line: number,
  truth: Set<string>,
  out: Violation[],
): void {
  const inv = OMK_INVOCATION.exec(text);
  if (!inv) return;
  const tail = text.slice(inv.index);
  FLAG_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FLAG_TOKEN.exec(tail)) !== null) {
    const name = m[1]!;
    if (!truth.has(name)) {
      out.push({ file, line, token: `--${name}`, context: text.trim().slice(0, 120) });
    }
  }
}

describe('markdown `omk ... --flag` 引用 grep gate', () => {
  it('user-facing markdown 里 omk 调用上的 --flag 必须是真实 oclif flag', async () => {
    const config = await Config.load({ root: PROJECT_ROOT });
    const truth = collectOmkFlagNames(config);

    const files = collectMarkdownFiles();
    const violations: Violation[] = [];

    for (const abs of files) {
      const rel = relative(PROJECT_ROOT, abs);
      if (FLAG_SCAN_EXCLUDE.has(rel)) continue;
      let text: string;
      try {
        text = readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n');
      let inFence = false;
      let buf = '';
      let bufLine = 0;
      const flush = (): void => {
        if (buf) scanInvocationFlags(buf, rel, bufLine, truth, violations);
        buf = '';
      };
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (/^\s*```/.test(line)) {
          flush();
          inFence = !inFence;
          continue;
        }
        if (inFence) {
          // 注释行(非续行中途)不算命令调用
          if (!buf && /^\s*#/.test(line)) continue;
          if (!buf) bufLine = i + 1;
          const continued = /\\\s*$/.test(line);
          buf += (buf ? ' ' : '') + line.replace(/\\\s*$/, '');
          if (!continued) flush();
        } else {
          // 行内 code span:`omk ... --flag`
          const spanRe = /`([^`]*)`/g;
          let s: RegExpExecArray | null;
          while ((s = spanRe.exec(line)) !== null) {
            const span = s[1]!;
            scanInvocationFlags(span, rel, i + 1, truth, violations);
          }
        }
      }
      flush();
    }

    if (violations.length > 0) {
      const dump = violations
        .map((v) => `  ${v.file}:${v.line}  '${v.token}'  | ${v.context}`)
        .join('\n');
      assert.fail(
        `发现 ${violations.length} 处 omk 调用引用了未知 / stale flag\n` +
        `(allowlist 来自 oclif 全部命令 flag 并集):\n${dump}\n\n` +
        `修法:改 markdown 里的 flag 名(或在 src/cli/commands/ 新增该 flag 后 yarn build);` +
        `roadmap 类未来 flag 把文件加进 FLAG_SCAN_EXCLUDE。`,
      );
    }
  }, 30000);
});
