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
  '.claude/skills/omk',
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
//   FENCED_CMD:在 ``` ... ``` 内的任意 `omk <cmd>`(代码块里的全算命令引用)
const INLINE_CODE_CMD = /`omk\s+([a-z][a-z-]*)/g;
const FENCED_CMD = /(?<![\w-])omk\s+([a-z][a-z-]*)/g;

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
        `src/cli/oclif/commands/<cmd>.ts 后重新 yarn build。`,
      );
    }
  }, 30000);
});
