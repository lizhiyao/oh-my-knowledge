import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Deliberately narrow: Markdown can also be a runtime prompt, skill or generated contract.
// 治理文档只维护单语言（双语副本会造出本仓正在治的那种漂移），改文不改行为，与根规则同档。
const rules = new Set([
  'AGENTS.md', 'CLAUDE.md', 'CODE_REVIEW.md', 'CONTRIBUTING.md',
  'SECURITY.md', 'PRODUCT.md', 'schemas/README.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
]);
// 模块级维护文档（`src/<域>/README.md`）与根规则文件同档：只有叙述与链接，没有构建、打包与行为面，
// 治理测试加空白检查即够。`docs/.vitepress/**`、生成物与任何非 `README.md` 的 `src/**` Markdown
// （提示词、技能、契约样本）都不在此列，仍走完整门禁。
const moduleDoc = /^src\/.+\/README\.md$/;
const isRulesSurface = (path) => rules.has(path) || moduleDoc.test(path);
const generated = new Set([
  'docs/reference/cli.md', 'docs/zh/reference/cli.md',
  'docs/specs/cli-evaluation-input-compilation.md', 'docs/zh/specs/cli-evaluation-input-compilation.md',
]);

export function classifyPaths(paths) {
  if (!paths.length) return 'full';
  let scope = 'rules';
  for (const path of paths) {
    if (isRulesSurface(path)) continue;
    if (generated.has(path)) return 'full';
    if (path === 'README.md' || path === 'README.zh.md'
      || /^docs\/(?!\.)(?:[^/.][^/]*\/)*[^/]+\.md$/.test(path)) {
      scope = 'docs';
    } else return 'full';
  }
  return scope;
}

export function detectScope(base, head, cwd = process.cwd()) {
  // Only immutable commit identities from the event; never interpret refs as options.
  if (![base, head].every(value => /^[a-f0-9]{40}$/.test(value ?? '') && !/^0+$/.test(value))) return 'full';
  try {
    // No rename detection: moving source into a docs path must retain the deleted source path.
    const output = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', base, head, '--'],
      { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return classifyPaths(output.split('\0').filter(Boolean));
  } catch { return 'full'; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const scope = detectScope(process.env.CI_BASE_SHA, process.env.CI_HEAD_SHA);
  console.log(`CI scope: ${scope}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `scope=${scope}\n`);
}
