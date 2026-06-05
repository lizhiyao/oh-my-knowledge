/**
 * docs/zh 跨语言悬链 gate(死链构建抓不到的那一类)。
 *
 * VitePress 的 `ignoreDeadLinks:false` 只能拦「目标文件不存在」。但有一类更隐蔽的
 * i18n bug:中文页里的站内相对链接 climb 回了英文根 `docs/`(而不是 `docs/zh/`),
 * 因为同名英文目标 *存在*,死链检查放行 —— 中文用户点进去却落到英文壳。PR #195
 * 把 spec 全量双语化后,每个发布页都有 `docs/zh/<path>` 镜像,这类回跳就是纯 bug。
 *
 * 规则:扫 `docs/zh/**` 的每条站内链接,解析后若落在 `docs/` 根(不在 `docs/zh/`)
 * 且对应的 `docs/zh/<同路径>` 镜像 *存在*,即判违规 —— 应改成中文相对路径。
 *   - 只在「zh 镜像存在」时报错:仅英文版的页面(无 zh 镜像)允许被引,不误伤。
 *   - 例外:明确标注 English 的语言切换链接(link 文案含 English / 英文 / EN),
 *     如 `docs/zh/reference/comparison.md` 顶部的 `[English](../../reference/...)`。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const DOCS_ROOT = join(PROJECT_ROOT, 'docs');
const ZH_ROOT = join(DOCS_ROOT, 'zh');

// zh-facing 入口文件,虽不在 docs/zh/ 下但同样是中文读者入口:它们指向 docs/ 的
// 站内链接若落到英文根而 zh 镜像存在,同样是「中文入口回跳英文壳」回归。
const EXTRA_ZH_FACING_FILES = [join(PROJECT_ROOT, 'README.zh.md')];

const MD_LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g;
// 语言切换链接:link 文案明确指向英文版,允许 climb 回英文根。
const EN_SWITCH = /English|英文|\bEN\b/i;

interface Violation {
  file: string;
  line: number;
  target: string;
  mirror: string;
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
    if (name === 'node_modules' || name === 'dist' || name === '.vitepress') continue;
    const full = join(dir, name);
    if (entry.isDirectory()) walkMarkdown(full, out);
    else if (entry.isFile() && name.endsWith('.md')) out.push(full);
  }
}

function isUnder(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^\.\.[\\/]/.test(rel));
}

// cleanUrls 下链接可省 .md;把解析后的裸路径补全成实际文件,判存在。
function mirrorExists(base: string): boolean {
  for (const cand of [base, `${base}.md`, join(base, 'index.md')]) {
    try {
      if (existsSync(cand) && statSync(cand).isFile()) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

describe('docs/zh 跨语言悬链 gate', () => {
  it('docs/zh 与 zh-facing 入口的站内链接不得 climb 回英文根 docs/(当 zh 镜像存在时)', () => {
    const files: string[] = [];
    walkMarkdown(ZH_ROOT, files);
    for (const f of EXTRA_ZH_FACING_FILES) {
      try {
        if (statSync(f).isFile()) files.push(f);
      } catch {
        /* file absent — skip */
      }
    }

    const violations: Violation[] = [];
    for (const abs of files) {
      const text = readFileSync(abs, 'utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        MD_LINK.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = MD_LINK.exec(line)) !== null) {
          const linkText = m[1]!;
          const raw = m[2]!;
          if (/^(https?:|mailto:|#)/i.test(raw)) continue;
          if (EN_SWITCH.test(linkText)) continue;
          const targetPath = raw.split('#')[0]!.split('?')[0]!;
          if (!targetPath) continue;

          const absTarget = targetPath.startsWith('/')
            ? join(DOCS_ROOT, targetPath.slice(1))
            : resolve(dirname(abs), targetPath);

          // 不在 docs/ 内(如 repo 根 README.zh.md)→ 与镜像无关,跳过。
          if (!isUnder(absTarget, DOCS_ROOT)) continue;
          // 已经在 docs/zh/ 内 → 正确,跳过。
          if (isUnder(absTarget, ZH_ROOT)) continue;

          // 落在英文根:看是否有对应 zh 镜像。
          const relToDocs = relative(DOCS_ROOT, absTarget);
          const mirrorBase = join(ZH_ROOT, relToDocs);
          if (mirrorExists(mirrorBase)) {
            violations.push({
              file: relative(PROJECT_ROOT, abs),
              line: i + 1,
              target: raw,
              mirror: relative(PROJECT_ROOT, mirrorBase),
            });
          }
        }
      }
    }

    if (violations.length > 0) {
      const dump = violations
        .map((v) => `  ${v.file}:${v.line}  -> ${v.target}  (应指向 ${v.mirror})`)
        .join('\n');
      assert.fail(
        `发现 ${violations.length} 处中文页链接 climb 回英文根 docs/(对应 zh 镜像存在):\n${dump}\n\n` +
          `修法:把链接改成中文相对路径(指向 docs/zh/ 下的镜像);` +
          `若确为语言切换链接,link 文案需含 English / 英文 / EN。`,
      );
    }
  });
});
