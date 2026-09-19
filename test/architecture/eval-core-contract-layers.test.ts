import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * #978 第 2 项：`eval-core/contracts/` 只放**声明**（wire schema、身份、摘要、符合性判定所需的形状），
 * 符合性判定与统计决策本身归 `eval-core/verify/`。
 *
 * 为什么按「函数体行数」而不是按目录归属来守：契约层确实需要小段计算（规范化序、摘要、schema
 * 内的唯一性 refine），这些留在 contracts 是对的；出问题的是把上千行的判定算法写在契约文件里——
 * 那时契约 diff 分不出「字段语义变了」还是「算法变了」，版本化门禁就没了着力点。
 *
 * 表里的数字是**现存债务**的上界：搬家只允许让函数变短，新增超过 60 行的函数（未登记文件里的
 * 任何函数）一律红。每搬走一块就把对应条目删掉，删完即达标。
 */
const CONTRACT_ALGORITHM_BUDGET: Readonly<Record<string, number>> = {
  'contracts/analysis-bundle.ts': 149,
  'contracts/budget.ts': 159,
  'contracts/digests.ts': 110,
  'contracts/evaluation-bundle.ts': 292,
  'contracts/evaluation-report.ts': 99,
  'contracts/execution-bundle.ts': 233,
  'contracts/execution-facts.ts': 120,
  'contracts/execution-identities.ts': 142,
  'contracts/json.ts': 65,
  'contracts/series.ts': 171,
};

/** 未登记的契约文件允许的单个函数体上限：超过它说明有新算法写进了声明层。 */
const UNLISTED_FUNCTION_BUDGET = 60;

const CONTRACTS_DIR = 'src/eval-core/contracts';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

function longestFunctionBody(filePath: string): { lines: number; name: string } {
  const source = ts.createSourceFile(
    filePath,
    readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.ESNext,
    true,
  );
  const lineAt = (position: number) => source.getLineAndCharacterOfPosition(position).line + 1;
  let best = { lines: 0, name: '' };
  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node)
      || ts.isFunctionExpression(node)
      || ts.isArrowFunction(node)
    ) {
      const lines = lineAt(node.getEnd() - 1) - lineAt(node.getStart(source)) + 1;
      const name = ts.isFunctionDeclaration(node) && node.name
        ? node.name.getText(source)
        : '(anonymous)';
      if (lines > best.lines) best = { lines, name };
    }
    node.forEachChild(visit);
  };
  source.forEachChild(visit);
  return best;
}

describe('eval-core 契约层与判定层的归属', () => {
  const files = sourceFiles(CONTRACTS_DIR);

  it('契约层不得引用判定层（判定只能依赖声明，不能反向）', () => {
    const offenders = files.filter((filePath) => {
      const text = readFileSync(filePath, 'utf8');
      return /from '[^']*\/verify\/[^']*'/.test(text)
        || /from '\.\.\/verify(\/index\.js)?'/.test(text)
        || /require\('[^']*\/verify\/[^']*'\)/.test(text);
    });
    expect(offenders.map((f) => relative('src/eval-core', f))).toEqual([]);
  });

  it('契约文件里的函数体不得超过已登记的上界', () => {
    const overBudget: string[] = [];
    for (const filePath of files) {
      const key = relative('src/eval-core', filePath).replaceAll('\\', '/');
      const budget = CONTRACT_ALGORITHM_BUDGET[key] ?? UNLISTED_FUNCTION_BUDGET;
      const longest = longestFunctionBody(filePath);
      if (longest.lines > budget) {
        overBudget.push(`${key}: ${longest.name} 有 ${longest.lines} 行，上界 ${budget}`);
      }
    }
    expect(overBudget).toEqual([]);
  });

  it('已登记的上界必须对应真实存在的超长函数，搬家完成后要删掉条目', () => {
    const stale = Object.entries(CONTRACT_ALGORITHM_BUDGET)
      .filter(([key, budget]) => {
        const longest = longestFunctionBody(join('src/eval-core', key));
        return longest.lines <= UNLISTED_FUNCTION_BUDGET || longest.lines > budget;
      })
      .map(([key, budget]) => `${key}（登记 ${budget}）`);
    expect(stale).toEqual([]);
  });

  it('判定层可以引用契约层，且 comparability 的判定确实已经在那里', () => {
    const verifyDir = 'src/eval-core/verify';
    const moved = sourceFiles(verifyDir).map((f) => relative('src/eval-core', f));
    expect(moved).toContain('verify/comparability.ts');
    const importsContracts = readFileSync(join(verifyDir, 'comparability.ts'), 'utf8')
      .includes("from '../contracts/comparability.js'");
    expect(importsContracts).toBe(true);
    expect(longestFunctionBody('src/eval-core/contracts/comparability.ts').lines)
      .toBeLessThanOrEqual(UNLISTED_FUNCTION_BUDGET);
  });
});
