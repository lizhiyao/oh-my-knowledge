/**
 * 架构边界守门:用静态扫描固化「哪个 layer 可以 import 哪个 layer」。
 *
 * 历史背景:src/ 内层级关系靠 CR 记忆维护,被反向 import 拉穿过多次:
 *   - observability 反向 driving diagnosis(已修)
 *   - types 反向看业务实现(已修)
 *   - renderer 直接 import observability 内部(已 facade 化)
 * 这个测试把每一条「已修的方向」锁死,新增反向 import 会在 PR 阶段挂掉。
 *
 * 规则形态:每条规则声明 from / to / 可选 whitelist + 注解。匹配 src-relative
 * 路径前缀。静态 import 与 dynamic import('xxx') 都覆盖。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, normalize, sep, dirname } from 'node:path';
import ts from 'typescript';

const REPO_ROOT = join(__dirname, '..', '..');
const SRC_DIR = join(REPO_ROOT, 'src');
const EVALUATION_CORE_DIR = join(SRC_DIR, 'evaluation-core');
const EVALUATION_CORE_DIR_NORMALIZED = EVALUATION_CORE_DIR.replace(/\\/g, '/');

interface ForbiddenRule {
  /** 源 layer 前缀(src-relative,以 `/` 结尾的目录或具体文件路径前缀)。 */
  from: string;
  /** 目标 layer 前缀,同上。匹配后即视为违例,除非命中 whitelist。 */
  to: string;
  /** 说明这条规则存在的原因(挂掉时给 reviewer 看)。 */
  reason: string;
  /** 例外白名单。元素格式:`<importer-src-relative>::<resolved-target-src-relative>`。
   *  importer 必须 from 前缀,target 必须 to 前缀,但这一对组合不计为违例。
   *  专用于「P2 待修但 P1.3 不阻塞」的 known-debt。 */
  whitelist?: string[];
}

const RULES: ForbiddenRule[] = [
  {
    from: 'evaluation-core/',
    to: 'measurement-artifacts/',
    reason: 'Evaluation Core vNext 是纯计算内核，不依赖文件命名、目录布局或产物发现。',
  },
  {
    from: 'evaluation-core/',
    to: 'preflight/',
    reason: 'Evaluation Core vNext 是宿主无关内核，不依赖宿主环境与依赖探测。',
  },
  {
    from: 'evaluation-core/',
    to: 'shared/statistics/',
    reason: 'Evaluation Core vNext 的 Analysis 自持统计语义，不反向依赖应用层兼容工具。',
  },
  {
    from: 'evaluation-core/',
    to: 'eval-workflows/',
    reason: 'Evaluation Core vNext 是宿主无关内核，不依赖旧 workflow 装配层。',
  },
  {
    from: 'evaluation-core/',
    to: 'types/',
    reason: 'Evaluation Core vNext 拥有独立 wire contracts，不复用历史 public schema 或领域 DTO。',
  },
  {
    from: 'evaluation-core/',
    to: 'cli/',
    reason: 'Evaluation Core vNext 不得依赖 CLI、配置或命令装配。',
  },
  {
    from: 'evaluation-core/',
    to: 'executors/',
    reason: 'Contracts 只描述 Runtime identity 与 capability，不依赖具体 executor 实现。',
  },
  {
    from: 'evaluation-core/',
    to: 'grading/',
    reason: 'Evaluation Core vNext 的 Evaluator／Metric 契约不复用旧 grading pipeline。',
  },
  {
    from: 'evaluation-core/',
    to: 'server/',
    reason: 'Evaluation Core vNext 不依赖持久化、HTTP 或 Studio host。',
  },
  {
    from: 'evaluation-core/',
    to: 'renderer/',
    reason: 'Bundle 是事实契约，Report renderer 属于宿主物化视图。',
  },
  {
    from: 'types/',
    to: 'eval-workflows/',
    reason: 'types/ 是底层契约层,不应反向 import eval-workflows。',
  },
  {
    from: 'types/',
    to: 'cli/',
    reason: 'types/ 不应反向 import CLI 装配层。',
  },
  {
    from: 'types/',
    to: 'observability/',
    reason: 'types/ 不应反向 import observability。observability schema 应下沉到 types/(已部分完成,见 types/diagnosis.ts)。',
  },
  {
    from: 'types/',
    to: 'diagnosis/',
    reason: 'types/ 不应反向 import diagnosis(已切除,见 types/diagnosis.ts)。',
  },
  {
    from: 'types/',
    to: 'renderer/',
    reason: 'types/ 不应反向 import renderer(视图层)。',
  },
  {
    from: 'types/',
    to: 'server/',
    reason: 'types/ 不应反向 import server。',
  },
  {
    from: 'types/',
    to: 'doctor/',
    reason: 'types/ 不应反向 import doctor 实现层。',
  },
  {
    from: 'types/',
    to: 'grading/',
    reason: 'types/ 不应反向 import grading。',
  },
  {
    from: 'observability/',
    to: 'diagnosis/',
    reason: 'observability 是 diagnosis 的下游消费者,不应反向 driving diagnosis(见 commit 4d38ca6 之前的层级倒置)。如需共用类型,放 src/types/diagnosis.ts。',
  },
  {
    from: 'renderer/',
    to: 'server/',
    reason: 'renderer 是视图层,不应 import server。server 内部类型应抽到 types/ 给两边共享。',
  },
  {
    from: 'renderer/',
    to: 'observability/',
    reason: 'renderer 只能通过 facade 访问 observability,不应直接 import observability 内部实现。facade 见 observability/inbox-view-model.ts、observability/feedback-projection.ts、observability/skill-health-analyzer.ts。',
    whitelist: [
      // 允许的 facade 访问点(以及它们的 .ts 解析后路径)。
      'renderer/observation-inbox-renderer.ts::observability/inbox-view-model.ts',
      'renderer/observation-inbox-renderer.ts::observability/feedback-projection.ts',
      'renderer/observation-inbox/helpers.ts::observability/feedback-projection.ts',
      'renderer/skill-health-renderer.ts::observability/skill-health-analyzer.ts',
    ],
  },
];

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const fp = join(dir, entry);
    const st = statSync(fp);
    if (st.isDirectory()) {
      listTsFiles(fp, out);
    } else if (st.isFile() && (entry.endsWith('.ts') || entry.endsWith('.tsx')) && !entry.endsWith('.d.ts')) {
      out.push(fp);
    }
  }
  return out;
}

const IMPORT_RE = /(?:^|\s|;)import\s+(?:type\s+)?(?:[\w*{}\s,]+from\s+)?['"]([^'"]+)['"]/g;
const REEXPORT_RE = /(?:^|\s|;)export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

function extractSpecifiers(content: string): string[] {
  const specs = new Set<string>();
  for (const m of content.matchAll(IMPORT_RE)) specs.add(m[1]);
  for (const m of content.matchAll(REEXPORT_RE)) specs.add(m[1]);
  for (const m of content.matchAll(DYNAMIC_RE)) specs.add(m[1]);
  return [...specs];
}

function resolveSpecifier(importerAbs: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const target = normalize(join(dirname(importerAbs), spec));
  // 把 .js 解析回 .ts(项目用显式 .js 后缀的 ESM)
  return target.replace(/\.js$/, '.ts').replace(/\\/g, '/');
}

function toSrcRelative(absPath: string): string {
  return relative(SRC_DIR, absPath).split(sep).join('/');
}

interface Violation {
  importer: string;
  target: string;
  ruleFrom: string;
  ruleTo: string;
  reason: string;
}

function collectViolations(): Violation[] {
  const files = listTsFiles(SRC_DIR);
  const violations: Violation[] = [];
  for (const file of files) {
    const importerRel = toSrcRelative(file);
    const content = readFileSync(file, 'utf-8');
    const specs = extractSpecifiers(content);
    for (const spec of specs) {
      const resolvedAbs = resolveSpecifier(file, spec);
      if (!resolvedAbs) continue;
      const targetRel = toSrcRelative(resolvedAbs);
      for (const rule of RULES) {
        if (!importerRel.startsWith(rule.from)) continue;
        if (!targetRel.startsWith(rule.to)) continue;
        const whitelistKey = `${importerRel}::${targetRel}`;
        if (rule.whitelist?.includes(whitelistKey)) continue;
        violations.push({
          importer: importerRel,
          target: targetRel,
          ruleFrom: rule.from,
          ruleTo: rule.to,
          reason: rule.reason,
        });
      }
    }
  }
  return violations;
}

interface CoreCapabilityViolation {
  file: string;
  detail: string;
}

const ALLOWED_CORE_EXTERNAL_IMPORTS = new Set(['zod', 'node:crypto']);
const FORBIDDEN_HOST_GLOBALS = new Set([
  'process',
  'console',
  'globalThis',
  'window',
  'document',
  'navigator',
  'localStorage',
  'sessionStorage',
  'fetch',
  'WebSocket',
  'EventSource',
  'XMLHttpRequest',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'queueMicrotask',
  'require',
  'eval',
  'Function',
  'Deno',
  'Bun',
]);

function moduleSpecifier(node: ts.Node): ts.Expression | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return node.moduleSpecifier;
  }
  if (ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return node.arguments[0];
  }
  return undefined;
}

function isPropertyName(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  return (ts.isPropertyAccessExpression(parent) && parent.name === identifier)
    || ((ts.isPropertyAssignment(parent)
      || ts.isMethodDeclaration(parent)
      || ts.isPropertyDeclaration(parent)
      || ts.isPropertySignature(parent)) && parent.name === identifier);
}

function isLocallyDeclared(
  identifier: ts.Identifier,
  checker: ts.TypeChecker,
  source: ts.SourceFile,
): boolean {
  return checker.getSymbolAtLocation(identifier)?.declarations?.some(
    (declaration) => declaration.getSourceFile() === source,
  ) ?? false;
}

function collectEvaluationCoreCapabilityViolations(): CoreCapabilityViolation[] {
  const violations: CoreCapabilityViolation[] = [];
  const files = listTsFiles(EVALUATION_CORE_DIR);
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.Node16,
    moduleResolution: ts.ModuleResolutionKind.Node16,
    types: ['node'],
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  for (const file of files) {
    const fileName = toSrcRelative(file);
    const source = program.getSourceFile(file);
    if (source === undefined) throw new Error(`无法解析 Evaluation Core 源文件：${fileName}`);
    const report = (detail: string): void => {
      violations.push({ file: fileName, detail });
    };
    const visit = (node: ts.Node): void => {
      const specifier = moduleSpecifier(node);
      if (specifier !== undefined) {
        if (!ts.isStringLiteralLike(specifier)) {
          report('使用了非字面量 dynamic import，无法证明依赖闭包。');
        } else if (specifier.text.startsWith('.')) {
          const resolved = resolveSpecifier(file, specifier.text);
          if (resolved === null
              || (!resolved.startsWith(`${EVALUATION_CORE_DIR_NORMALIZED}/`)
                && resolved !== EVALUATION_CORE_DIR_NORMALIZED)) {
            report(`跨出 Evaluation Core 的依赖：${specifier.text}`);
          }
        } else if (!ALLOWED_CORE_EXTERNAL_IMPORTS.has(specifier.text)) {
          report(`未获准的外部依赖：${specifier.text}`);
        } else if (specifier.text === 'node:crypto') {
          if (!ts.isImportDeclaration(node)
              || node.importClause?.name !== undefined
              || node.importClause?.namedBindings === undefined
              || !ts.isNamedImports(node.importClause.namedBindings)
              || node.importClause.namedBindings.elements.some((element) => (
                (element.propertyName?.text ?? element.name.text) !== 'createHash'
              ))) {
            report('node:crypto 只允许具名导入确定性的 createHash。');
          }
        }
      }

      if (ts.isIdentifier(node)
          && FORBIDDEN_HOST_GLOBALS.has(node.text)
          && !isPropertyName(node)
          && !isLocallyDeclared(node, checker, source)) {
        report(`访问了宿主全局能力：${node.text}`);
      }
      if (ts.isPropertyAccessExpression(node)) {
        const owner = node.expression.getText(source);
        const member = node.name.text;
        if ((owner === 'Date' && member === 'now')
            || (owner === 'Math' && member === 'random')
            || (owner === 'performance' && member === 'now')
            || (owner === 'crypto' && ['getRandomValues', 'randomUUID'].includes(member))) {
          report(`访问了非确定性宿主能力：${owner}.${member}`);
        }
      }
      if (ts.isCallExpression(node)
          && ts.isIdentifier(node.expression)
          && node.expression.text === 'Date') {
        report('访问了隐式 wall clock：Date()');
      }
      if (ts.isNewExpression(node)
          && ts.isIdentifier(node.expression)
          && node.expression.text === 'Date'
          && (node.arguments === undefined || node.arguments.length === 0)) {
        report('访问了隐式 wall clock：new Date()');
      }
      if (ts.isMetaProperty(node)
          && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
        report('访问了宿主模块位置：import.meta');
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return violations;
}

describe('架构边界守门', () => {
  it('禁止反向 / 跨层 import(规则集见本文件 RULES)', () => {
    const violations = collectViolations();
    if (violations.length > 0) {
      const lines = violations.map((v) =>
        `  ${v.importer} → ${v.target}\n    规则:${v.ruleFrom} ✗→ ${v.ruleTo}\n    原因:${v.reason}`
      );
      const msg = [
        `发现 ${violations.length} 处 import 违反架构边界:`,
        ...lines,
        '',
        '修复路径:把目标符号挪到 types/(纯类型)或抽 facade(运行时);',
        '若是 P2 known-debt 暂未修,在本测试文件 RULES.whitelist 显式登记并加 TODO。',
      ].join('\n');
      throw new Error(msg);
    }
    expect(violations).toEqual([]);
  });

  it('whitelist 不能腐烂:每条 whitelist 都对应一条真实存在的 import', () => {
    const files = listTsFiles(SRC_DIR);
    const realEdges = new Set<string>();
    for (const file of files) {
      const importerRel = toSrcRelative(file);
      const content = readFileSync(file, 'utf-8');
      for (const spec of extractSpecifiers(content)) {
        const resolvedAbs = resolveSpecifier(file, spec);
        if (!resolvedAbs) continue;
        const targetRel = toSrcRelative(resolvedAbs);
        realEdges.add(`${importerRel}::${targetRel}`);
      }
    }
    const dead: string[] = [];
    for (const rule of RULES) {
      for (const entry of rule.whitelist ?? []) {
        if (!realEdges.has(entry)) dead.push(`${rule.from} → ${rule.to}: ${entry}`);
      }
    }
    if (dead.length > 0) {
      throw new Error(`whitelist 中有 ${dead.length} 条不再对应真实 import,请清理:\n${dead.join('\n')}`);
    }
    expect(dead).toEqual([]);
  });

  it('Evaluation Core 只依赖内部模块、Zod 和确定性哈希', () => {
    const violations = collectEvaluationCoreCapabilityViolations();
    if (violations.length > 0) {
      throw new Error([
        `发现 ${violations.length} 处 Evaluation Core 宿主能力越界：`,
        ...violations.map((violation) => `  ${violation.file}：${violation.detail}`),
        '',
        'Core 必须通过显式注入的 port 获得时间、文件、网络、环境和外部 Runtime 能力。',
      ].join('\n'));
    }
    expect(violations).toEqual([]);
  });
});
