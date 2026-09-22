/**
 * 架构边界守门：设置与帮助入口（`StudioUtilities`）只有外壳一个渲染方（#1055）。
 *
 * 起因：入口曾经有两处——外壳页头一份、观测工作区自画侧栏里一份，靠 `utilitiesInSidebar`
 * 开关互斥；16 个路由里 2 个在侧栏、14 个在页头，新增页面各选一头，没有静态信号拦得住。
 * #1055 拍板侧栏化外壳：品牌、一级导航、工作区列表与设置入口统一收进外壳左侧栏，
 * `StudioUtilities` 固定在侧栏底部。此后任何页面／工作区组件再自己 import 它，都会让
 * 入口回到双份状态。
 *
 * 口径：
 *  - 判据是 import 声明里出现 `StudioUtilities`（按名导入即意图渲染），文件必须落在
 *    `src/studio/web/components/layout/` 内；定义方 `utilities.tsx` 自身不 import 它。
 *  - 顺手防回潮：`utilitiesInSidebar` 这个开关随 #1055 删除，任何文件再出现这个名字即判红。
 *  - 只扫 `src/studio`；渲染层之外的目录不产出标记。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const STUDIO_DIR = join(REPO_ROOT, 'src', 'studio');
const LAYOUT_DIR = join('src', 'studio', 'web', 'components', 'layout');
const SKIPPED_DIRS = new Set(['.next', 'node_modules', 'dist', 'coverage']);

function listSourceFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIPPED_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) listSourceFiles(path, out);
    else if (entry.endsWith('.tsx') || (entry.endsWith('.ts') && !entry.endsWith('.d.ts'))) out.push(path);
  }
  return out;
}

function displayRepoPath(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join('/');
}

/** 本文件里按名导入 `StudioUtilities` 的 import 声明所在行。 */
function utilitiesImportLines(path: string): number[] {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines: number[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && statement.getText(source).includes('StudioUtilities')) {
      lines.push(source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1);
    }
  }
  return lines;
}

const FIXTURE: Record<string, string> = {
  // 判死：工作区组件又自己 import 了入口。
  'workspace.tsx': `import { StudioUtilities } from '../layout/utilities';\n\nexport function Workspace() { return <StudioUtilities lang="zh"/>; }\n`,
  // 判活：类型同名但不出现在 import 声明里（例如注释、普通标识符）不算。
  'plain.ts': `/** StudioUtilities 由外壳统一渲染。 */\nexport const note = 'StudioUtilities';\n`,
};

let fixtureRoot = '';

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'omk-studio-shell-utilities-'));
  for (const [name, content] of Object.entries(FIXTURE)) {
    const target = join(fixtureRoot, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('设置与帮助入口的唯一渲染方守门', () => {
  it('StudioUtilities 只在 components/layout 内被 import', () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(STUDIO_DIR)) {
      const lines = utilitiesImportLines(file);
      if (lines.length === 0) continue;
      const display = displayRepoPath(file);
      if (display.startsWith(`${LAYOUT_DIR.split(sep).join('/')}/`)) continue;
      offenders.push(...lines.map((line) => `${display}:${line}`));
    }
    expect(offenders, '页面／工作区组件不得自画设置与帮助入口，交给外壳侧栏（#1055）').toEqual([]);
  });

  it('utilitiesInSidebar 开关不回流', () => {
    const offenders = listSourceFiles(STUDIO_DIR)
      .filter((file) => readFileSync(file, 'utf8').includes('utilitiesInSidebar'))
      .map(displayRepoPath);
    expect(offenders, '入口位置不再按页开关，#1055 已统一进外壳侧栏').toEqual([]);
  });

  it('控制组：工作区 import 入口判死，同名文本判活', () => {
    expect(utilitiesImportLines(join(fixtureRoot, 'workspace.tsx'))).toEqual([1]);
    expect(utilitiesImportLines(join(fixtureRoot, 'plain.ts'))).toEqual([]);
  });
});
