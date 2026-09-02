/**
 * 架构边界守门:用静态扫描固化「哪个 layer 可以 import 哪个 layer」。
 *
 * 历史背景:src/ 内层级关系靠 CR 记忆维护,被反向 import 拉穿过多次:
 *   - observability 反向 driving diagnosis(已修)
 *   - Studio application / catalog 散落在交付层与 workflow(已修)
 *   - Studio presentation 直接 import observability 内部(已 facade 化)
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
const EVALUATION_CORE_DIR = join(SRC_DIR, 'eval-core');
const EVALUATION_CORE_DIR_NORMALIZED = EVALUATION_CORE_DIR.replace(/\\/g, '/');
const RUNTIME_ADAPTERS_DIR = join(
  SRC_DIR,
  'eval-workflows',
  'runtime-adapter',
  'adapters',
);

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
    from: 'eval-core/',
    to: 'measurement-artifacts/',
    reason: 'Evaluation Core vNext 是纯计算内核，不依赖文件命名、目录布局或产物发现。',
  },
  {
    from: 'eval-core/',
    to: 'shared/statistics/',
    reason: 'Evaluation Core vNext 的 Analysis 自持统计语义，不反向依赖应用层兼容工具。',
  },
  {
    from: 'eval-core/',
    to: 'eval-workflows/',
    reason: 'Evaluation Core vNext 是宿主无关内核，不依赖旧 workflow 装配层。',
  },
  {
    from: 'eval-core/',
    to: 'cli/',
    reason: 'Evaluation Core vNext 不得依赖 CLI、配置或命令装配。',
  },
  {
    from: 'eval-core/',
    to: 'executors/',
    reason: 'Contracts 只描述 Runtime identity 与 capability，不依赖具体 executor 实现。',
  },
  {
    from: 'eval-core/',
    to: 'studio/',
    reason: 'Evaluation Core vNext 是纯计算内核，不依赖 Studio 的查询投影、HTTP 或呈现能力。',
  },
  {
    from: 'eval-workflows/',
    to: 'studio/',
    reason: '应用工作流产出事实与存储能力，由 Studio 单向消费；workflow 不反向依赖具体工作台。',
  },
  {
    from: 'artifact-graph/',
    to: 'eval-workflows/',
    reason: 'Artifact Graph 只拥有图 contracts、schema 与领域投影；文件持久化和 Core workflow composition 由 production host 拥有。',
  },
  {
    from: 'executors/',
    to: 'observability/',
    reason: 'Executor 负责 Runtime 与工具结果事实，不得反向依赖由这些事实派生的 Observability 投影。',
  },
  {
    from: 'measurement-artifacts/',
    to: 'observability/',
    reason: 'Measurement Artifacts 只拥有产物命名、目录、索引与定位能力；跨域 prompt 冻结属于 CI 测量治理。',
  },
  {
    from: 'observability/',
    to: 'studio/',
    reason: 'observability 负责采集、分析与复核事实，不依赖 Studio 的应用聚合或呈现。',
  },
  {
    from: 'studio/application/',
    to: 'studio/http/',
    reason: 'Studio application 不依赖 HTTP host；HTTP 交付层只能向内调用应用能力。',
  },
  {
    from: 'studio/application/',
    to: 'studio/presentation/',
    reason: 'Studio application 不依赖 HTML 呈现；presentation 只能消费应用结果与 view-model。',
  },
  {
    from: 'studio/presentation/',
    to: 'studio/http/',
    reason: 'Studio presentation 是无 HTTP 状态的纯呈现层，不依赖请求、响应或 server 生命周期。',
  },
  {
    from: 'shared/',
    to: 'artifact-graph/',
    reason: 'shared 是跨领域叶子依赖；Artifact Graph parser 由 artifact-graph 领域拥有。',
  },
  {
    from: 'shared/',
    to: 'diagnosis/',
    reason: 'shared 是跨领域叶子依赖；Diagnosis parser 由 diagnosis 领域拥有。',
  },
  {
    from: 'shared/',
    to: 'knowledge-artifacts/',
    reason: 'shared 是跨领域叶子依赖；Artifact、Skill、Doctor、Authoring 与 Governance 均由 knowledge-artifacts 领域拥有。',
  },
  {
    from: 'shared/',
    to: 'measurement-artifacts/',
    reason: 'shared 是跨领域叶子依赖；run id 分配依赖产物命名策略，应由 measurement-artifacts 拥有。',
  },
  {
    from: 'shared/',
    to: 'executors/',
    reason: 'shared 是跨领域叶子依赖；执行结果校验与工具状态解释由 executors 拥有。',
  },
  {
    from: 'shared/',
    to: 'eval-workflows/',
    reason: 'shared 是跨领域叶子依赖；输入编译、评分类适配与工作流装配均由 eval-workflows 拥有。',
  },
  {
    from: 'shared/',
    to: 'observability/',
    reason: 'shared 是跨领域叶子依赖；观测投影与 prompt 编目由上层能力拥有。',
  },
  {
    from: 'studio/presentation/',
    to: 'observability/',
    reason: 'Studio presentation 只能通过 facade 访问 observability，不应直接 import observability 内部实现。facade 见 observability/view-models/index.ts、observability/inbox/view-model.ts、observability/inbox/feedback-projection.ts、observability/skill-health/analyzer.ts。',
    whitelist: [
      'studio/presentation/conversation-renderer.ts::observability/view-models/index.ts',
      'studio/presentation/knowledge-debugger-renderer.ts::observability/view-models/index.ts',
      'studio/presentation/trajectory-evidence.ts::observability/view-models/index.ts',
      // 允许的 facade 访问点(以及它们的 .ts 解析后路径)。
      'studio/presentation/observation-inbox-renderer.ts::observability/inbox/view-model.ts',
      'studio/presentation/observation-inbox/experience-workspace-renderer.ts::observability/inbox/view-model.ts',
      'studio/presentation/observation-inbox/experience-workspace-renderer.ts::observability/inbox/feedback-projection.ts',
      'studio/presentation/observation-inbox/helpers.ts::observability/inbox/feedback-projection.ts',
      'studio/presentation/observation-inbox/metric-renderer.ts::observability/inbox/view-model.ts',
      'studio/presentation/observation-inbox/metric-renderer.ts::observability/inbox/feedback-projection.ts',
      'studio/presentation/observation-inbox/page-renderer.ts::observability/inbox/view-model.ts',
      'studio/presentation/observation-inbox/process-workspace-renderer.ts::observability/inbox/view-model.ts',
      'studio/presentation/observation-inbox/review-renderer.ts::observability/inbox/view-model.ts',
      'studio/presentation/observation-inbox/review-renderer.ts::observability/inbox/feedback-projection.ts',
      'studio/presentation/observation-inbox/reviewer-report.ts::observability/inbox/view-model.ts',
      'studio/presentation/observation-inbox/reviewer-report.ts::observability/inbox/feedback-projection.ts',
      'studio/presentation/observation-inbox/signal-renderer.ts::observability/inbox/view-model.ts',
      'studio/presentation/observation-inbox/skill-chain-renderer.ts::observability/inbox/view-model.ts',
      'studio/presentation/observation-inbox/timeline.ts::observability/inbox/view-model.ts',
      'studio/presentation/observation-inbox/timeline.ts::observability/inbox/feedback-projection.ts',
      'studio/presentation/skill-health-renderer.ts::observability/skill-health/analyzer.ts',
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

function collectSharedLeafViolations(): string[] {
  const sharedDir = join(SRC_DIR, 'shared');
  const violations: string[] = [];
  for (const file of listTsFiles(sharedDir)) {
    const importer = toSrcRelative(file);
    for (const specifier of extractSpecifiers(readFileSync(file, 'utf-8'))) {
      const target = resolveSpecifier(file, specifier);
      if (target === null) continue;
      const targetRelative = toSrcRelative(target);
      if (!targetRelative.startsWith('shared/')) {
        violations.push(`${importer} → ${targetRelative}`);
      }
    }
  }
  return violations;
}

describe('架构边界守门', () => {
  it('Runtime Adapter provider 保持内聚目录与单向 shared 依赖', () => {
    const rootSourceFiles = readdirSync(RUNTIME_ADAPTERS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile()
        && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')))
      .map((entry) => entry.name)
      .sort();
    expect(rootSourceFiles).toEqual(['index.ts']);

    const providers = new Set(['anthropic', 'claude', 'codex', 'custom', 'openai']);
    const violations: string[] = [];
    for (const provider of providers) {
      for (const file of listTsFiles(join(RUNTIME_ADAPTERS_DIR, provider))) {
        for (const specifier of extractSpecifiers(readFileSync(file, 'utf-8'))) {
          const target = resolveSpecifier(file, specifier);
          if (target === null) continue;
          const targetRelative = relative(RUNTIME_ADAPTERS_DIR, target).split(sep).join('/');
          if (targetRelative.startsWith('../')) continue;
          const targetOwner = targetRelative.split('/')[0];
          if (targetRelative === 'index.ts'
              || (providers.has(targetOwner) && targetOwner !== provider)) {
            violations.push(
              `${relative(RUNTIME_ADAPTERS_DIR, file).split(sep).join('/')} → ${targetRelative}`,
            );
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

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
        '修复路径：把共享契约归属到明确领域的 contracts，或抽 facade（运行时）；',
        '若是 P2 known-debt 暂未修,在本测试文件 RULES.whitelist 显式登记并加 TODO。',
      ].join('\n');
      throw new Error(msg);
    }
    expect(violations).toEqual([]);
  });

  it('shared 只依赖自身纯工具与契约', () => {
    const violations = collectSharedLeafViolations();
    if (violations.length > 0) {
      throw new Error([
        `发现 ${violations.length} 处 shared 反向领域依赖：`,
        ...violations.map((violation) => `  ${violation}`),
        '',
        'shared 必须保持为依赖图叶子；把实现迁回领域，或把真正跨域的纯类型下沉到 shared/contracts。',
      ].join('\n'));
    }
    expect(violations).toEqual([]);
  });

  it('工具结果失败语义由 Executor 状态模块拥有', () => {
    const executorStatus = readFileSync(
      join(SRC_DIR, 'executors', 'tool-call-status.ts'),
      'utf-8',
    );
    const observationSignals = readFileSync(
      join(SRC_DIR, 'observability', 'experience', 'text-signals.ts'),
      'utf-8',
    );

    expect(executorStatus).toContain('export function isToolResultFailureText(');
    expect(observationSignals).not.toContain('function isToolResultFailureText(');
  });

  it('Experience 时间线投影由独立模块拥有', () => {
    const facade = readFileSync(join(SRC_DIR, 'observability', 'experience.ts'), 'utf-8');
    const timeline = readFileSync(
      join(SRC_DIR, 'observability', 'experience', 'timeline.ts'),
      'utf-8',
    );

    expect(extractSpecifiers(facade)).toContain('./experience/timeline.js');
    expect(facade).not.toContain('function timelineEventsFromTraceEvent(');
    expect(facade).not.toContain('function buildTimelineWindow(');
    expect(extractSpecifiers(timeline)).not.toContain('../experience.js');
  });

  it('Experience 报告结构与派生事实由独立模块拥有', () => {
    const facade = readFileSync(join(SRC_DIR, 'observability', 'experience.ts'), 'utf-8');
    const reportStructure = readFileSync(
      join(SRC_DIR, 'observability', 'experience', 'report-structure.ts'),
      'utf-8',
    );
    const reportDerivations = readFileSync(
      join(SRC_DIR, 'observability', 'experience', 'report-derivations.ts'),
      'utf-8',
    );

    expect(extractSpecifiers(facade)).toContain('./experience/report-structure.js');
    expect(extractSpecifiers(facade)).toContain('./experience/report-derivations.js');
    expect(facade).not.toContain('function traceTimelinesFromSessions(');
    expect(facade).not.toContain('function scoreForIndicators(');
    expect(extractSpecifiers(reportStructure)).not.toContain('../experience.js');
    expect(extractSpecifiers(reportDerivations)).not.toContain('../experience.js');
  });

  it('Experience 报告编解码与校验由独立模块拥有', () => {
    const facade = readFileSync(join(SRC_DIR, 'observability', 'experience.ts'), 'utf-8');
    const codec = readFileSync(
      join(SRC_DIR, 'observability', 'experience', 'report-codec.ts'),
      'utf-8',
    );
    const valueGuards = readFileSync(
      join(SRC_DIR, 'observability', 'experience', 'report-value-guards.ts'),
      'utf-8',
    );
    const referenceValidator = readFileSync(
      join(SRC_DIR, 'observability', 'experience', 'report-reference-validator.ts'),
      'utf-8',
    );

    expect(extractSpecifiers(facade)).toContain('./experience/report-codec.js');
    expect(facade).not.toContain('function normalizeObservationExperienceReport(');
    expect(facade).not.toContain('function compactObservationExperienceReport(');
    expect(extractSpecifiers(codec)).toContain('./report-value-guards.js');
    expect(extractSpecifiers(codec)).toContain('./report-reference-validator.js');
    expect(extractSpecifiers(valueGuards)).not.toContain('../experience.js');
    expect(extractSpecifiers(referenceValidator)).not.toContain('../experience.js');
  });

  it('Experience 复核清单由独立模块拥有', () => {
    const facade = readFileSync(join(SRC_DIR, 'observability', 'experience.ts'), 'utf-8');
    const checklist = readFileSync(
      join(SRC_DIR, 'observability', 'experience', 'review-checklist.ts'),
      'utf-8',
    );

    expect(extractSpecifiers(facade)).toContain('./experience/review-checklist.js');
    expect(facade).not.toContain('function goalSatisfactionChecklistItems(');
    expect(facade).not.toContain('function expectedToolCheckForSession(');
    expect(extractSpecifiers(checklist)).not.toContain('../experience.js');
  });

  it('Experience 会话故事由独立模块拥有', () => {
    const facade = readFileSync(join(SRC_DIR, 'observability', 'experience.ts'), 'utf-8');
    const sessionStory = readFileSync(
      join(SRC_DIR, 'observability', 'experience', 'session-story.ts'),
      'utf-8',
    );
    const textSignals = readFileSync(
      join(SRC_DIR, 'observability', 'experience', 'text-signals.ts'),
      'utf-8',
    );

    expect(extractSpecifiers(facade)).toContain('./experience/session-story.js');
    expect(facade).not.toContain('function buildSessionStory(');
    expect(facade).not.toContain('function sessionStoryFeedbackSignals(');
    expect(sessionStory).not.toContain("from '../experience.js'");
    expect(facade).not.toContain('const USER_INTERRUPTION_RE =');
    expect(textSignals).toContain('export const USER_INTERRUPTION_RE =');
  });

  it('Experience reviewer report 由独立模块拥有', () => {
    const facade = readFileSync(join(SRC_DIR, 'observability', 'experience.ts'), 'utf-8');
    const reviewerReport = readFileSync(
      join(SRC_DIR, 'observability', 'experience', 'reviewer-report.ts'),
      'utf-8',
    );

    expect(extractSpecifiers(facade)).toContain('./experience/reviewer-report.js');
    expect(facade).not.toContain('function buildReviewerReport(');
    expect(facade).not.toContain('function reviewerFindingsForSession(');
    expect(reviewerReport).not.toContain("from '../experience.js'");
  });

  it('Observation Inbox 浏览器交互脚本与服务端 renderer 分离', () => {
    const pageRenderer = readFileSync(
      join(SRC_DIR, 'studio', 'presentation', 'observation-inbox', 'page-renderer.ts'),
      'utf-8',
    );
    const clientScript = readFileSync(
      join(SRC_DIR, 'studio', 'presentation', 'observation-inbox', 'client-script.ts'),
      'utf-8',
    );

    expect(extractSpecifiers(pageRenderer)).toContain('./client-script.js');
    expect(pageRenderer).not.toContain("var observeSeverityFilter = 'all';");
    expect(extractSpecifiers(clientScript)).not.toContain('../observation-inbox-renderer.js');
  });

  it('Observation Inbox reviewer report 由独立组件拥有', () => {
    const renderer = readFileSync(
      join(SRC_DIR, 'studio', 'presentation', 'observation-inbox-renderer.ts'),
      'utf-8',
    );
    const reviewerReport = readFileSync(
      join(SRC_DIR, 'studio', 'presentation', 'observation-inbox', 'reviewer-report.ts'),
      'utf-8',
    );

    expect(extractSpecifiers(renderer)).toContain('./observation-inbox/reviewer-report.js');
    expect(renderer).not.toContain('const renderReviewerReport =');
    expect(extractSpecifiers(reviewerReport)).not.toContain('../observation-inbox-renderer.js');
  });

  it('Observation Inbox 时间线呈现由独立组件拥有', () => {
    const reviewRenderer = readFileSync(
      join(SRC_DIR, 'studio', 'presentation', 'observation-inbox', 'review-renderer.ts'),
      'utf-8',
    );
    const timeline = readFileSync(
      join(SRC_DIR, 'studio', 'presentation', 'observation-inbox', 'timeline.ts'),
      'utf-8',
    );

    expect(extractSpecifiers(reviewRenderer)).toContain('./timeline.js');
    expect(reviewRenderer).not.toContain('const renderExperienceTimeline =');
    expect(extractSpecifiers(timeline)).not.toContain('../observation-inbox-renderer.js');
  });

  it('Observation Inbox 入口只负责数据准备与 renderer 组合', () => {
    const renderer = readFileSync(
      join(SRC_DIR, 'studio', 'presentation', 'observation-inbox-renderer.ts'),
      'utf-8',
    );
    const rendererSpecifiers = extractSpecifiers(renderer);
    const componentFiles = [
      'experience-workspace-renderer.ts',
      'metric-renderer.ts',
      'page-renderer.ts',
      'process-workspace-renderer.ts',
      'review-renderer.ts',
      'signal-renderer.ts',
      'skill-chain-renderer.ts',
    ];

    expect(renderer.split('\n').length).toBeLessThanOrEqual(200);
    for (const file of componentFiles) {
      expect(rendererSpecifiers).toContain(`./observation-inbox/${file.replace(/\.ts$/u, '.js')}`);
      const component = readFileSync(
        join(SRC_DIR, 'studio', 'presentation', 'observation-inbox', file),
        'utf-8',
      );
      expect(extractSpecifiers(component)).not.toContain('../observation-inbox-renderer.js');
    }
    expect(renderer).not.toContain('<section');
    expect(renderer).not.toContain('const skillGroups =');
    expect(renderer).not.toContain('const experienceTopInsightHtml =');
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
