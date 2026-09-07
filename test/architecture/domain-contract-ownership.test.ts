import { readFileSync as readTraceSchemaSource } from 'node:fs';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const PURE_DOMAIN_TYPE_FILES = [
  'src/observability/analysis/contracts.ts',
  'src/evidence/graph/contracts.ts',
  'src/diagnosis/contracts.ts',
  'src/knowledge-artifacts/doctor/contracts.ts',
  'src/executors/preflight/contracts.ts',
  'src/knowledge-artifacts/governance/contracts.ts',
  'src/knowledge-artifacts/skills/contracts.ts',
  'src/knowledge-artifacts/contracts.ts',
  'src/eval-workflows/inputs/contracts/assertion.ts',
  'src/eval-workflows/inputs/contracts/config.ts',
  'src/executors/contracts/mock.ts',
  'src/eval-workflows/inputs/contracts/sample.ts',
  'src/eval-workflows/inputs/contracts/variant.ts',
  'src/eval-workflows/instruments/contracts/config.ts',
  'src/eval-workflows/inputs/contracts/assertion-kind.ts',
  'src/shared/language.ts',
  'src/executors/contracts/trace-source.ts',
  'src/studio/view-models/index.ts',
  'src/studio/view-models/insight.ts',
  'src/studio/view-models/skill-index.ts',
  'src/executors/contracts/trace.ts',
  'src/executors/contracts/ports.ts',
  'src/executors/contracts/result.ts',
  'src/executors/contracts/runtime.ts',
  'src/observability/contracts/trace.ts',
  'src/observability/contracts/review.ts',
  'src/observability/contracts/problem-patterns.ts',
  'src/observability/contracts/skill-chain-advisories.ts',
  'src/observability/contracts/inbox.ts',
  'src/observability/contracts/experience.ts',
  'src/observability/contracts/skill-chain.ts',
  'src/observability/view-models/index.ts',
  'src/observability/view-models/conversation.ts',
  'src/observability/view-models/knowledge-debugger.ts',
] as const;

const PURE_DOMAIN_TYPE_FILE_SET = new Set<string>(PURE_DOMAIN_TYPE_FILES);

const EXPERIENCE_ENUM_SCHEMA_FILE = 'src/observability/contracts/experience-enums.ts';
const EXPERIENCE_ENUM_TYPE_IMPORTS = new Set([
  'zod', './experience-enums.js', './experience-evidence-schema.js',
]);

const EXPERIENCE_EVIDENCE_ENUM_IMPORTS = [
  'ExperienceAssistiveInferenceCautionCodeSchema',
  'ExperienceAssistiveInferenceCodeSchema',
  'ExperienceAssistiveInferenceConfidenceSchema',
  'ExperienceChecklistContributionSchema',
  'ExperienceChecklistItemStatusSchema',
  'ExperienceEpisodeArtifactKindSchema',
  'ExperienceEpisodeBoundaryReasonSchema',
  'ExperienceEpisodeRoleSchema',
  'ExperienceEvidenceKindSchema',
  'ExperienceFeedbackAttributionReasonSchema',
  'ExperienceFeedbackAttributionRoleSchema',
  'ExperienceFeedbackSignalTypeSchema',
  'ExperienceGoalSliceReasonCodeSchema',
  'ExperienceOrchestrationEdgeKindSchema',
  'ExperienceOrchestrationEdgeStatusSchema',
  'ExperienceOutcomeClosureSchema',
  'ExperienceParentReasonSchema',
  'ExperienceReviewBasisCodeSchema',
  'ExperienceReviewPrioritySchema',
  'ExperienceReviewerReportFindingLevelSchema',
  'ExperienceReviewerReportFindingSourceSchema',
  'ExperienceReviewerReportScopeSchema',
  'ExperienceReviewerReportStepStatusSchema',
  'ExperienceRuleFindingCodeSchema',
  'ExperienceRuleFindingLevelSchema',
  'ExperienceRuntimeSkillTypeSchema',
  'ExperienceRuntimeSkillTypeSourceSchema',
  'ExperienceSessionStoryAnswerKeySchema',
  'ExperienceSessionStoryNodeKindSchema',
  'ExperienceSessionStorySkillRoleSchema',
  'ExperienceTurnStatusSchema',
  'TaskWindowBasisSchema',
];

function isDeclarativeEvidenceSchemaModule(source: ts.SourceFile, profile: {
  imports: ReadonlyArray<readonly [string, string]>;
  schemas: readonly string[];
  requiredSchema: string;
} = {
  imports: [
    ['zod', 'z'],
    ['./experience-enums.js', [...EXPERIENCE_EVIDENCE_ENUM_IMPORTS].sort().join(',')],
    ['../../executors/contracts/trace-source-schema.js', 'TraceSourceKindSchema'],
    ['./trace-metadata-schema.js', 'TraceSourceMetadataSchema'],
    ['../../executors/contracts/tool-call-status-schema.js', 'ToolCallStatusSchema'],
  ],
  schemas: [...EXPERIENCE_EVIDENCE_ENUM_IMPORTS, 'TraceSourceKindSchema', 'TraceSourceMetadataSchema', 'ToolCallStatusSchema'],
  requiredSchema: 'ExperienceEvidenceRefSchema',
}): boolean {
  const imports = new Map(profile.imports);
  const seenImports = new Set<string>();
  const schemas = new Set(profile.schemas);
  function expression(node: ts.Expression): boolean {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'omit') {
      const mask = node.arguments[0];
      return node.arguments.length === 1 && expression(node.expression.expression)
        && ts.isObjectLiteralExpression(mask)
        && mask.properties.every((property) => ts.isPropertyAssignment(property)
          && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
          && property.initializer.kind === ts.SyntaxKind.TrueKeyword);
    }

    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'exclude') {
      const values = node.arguments[0];
      return node.arguments.length === 1
        && expression(node.expression.expression)
        && ts.isArrayLiteralExpression(values)
        && values.elements.length > 0
        && values.elements.every(ts.isStringLiteral);
    }

    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'extend') {
      const shape = node.arguments[0];
      return node.arguments.length === 1
        && expression(node.expression.expression)
        && ts.isObjectLiteralExpression(shape)
        && shape.properties.every((property) => ts.isPropertyAssignment(property)
          && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
          && expression(property.initializer));
    }

    if (ts.isIdentifier(node)) return schemas.has(node.text);
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
    const receiver = node.expression.expression;
    const method = node.expression.name.text;
    if (ts.isIdentifier(receiver) && receiver.text === 'z') {
      if (method === 'string' || (method === 'number' || method === 'boolean')) return node.arguments.length === 0;
      if (method === 'record') return node.arguments.length === 2
        && expression(node.arguments[0]) && expression(node.arguments[1]);
      if (node.arguments.length !== 1) return false;
      const argument = node.arguments[0];
      if (method === 'array') return expression(argument);
      if (method === 'literal') return (ts.isStringLiteral(argument) || ts.isNumericLiteral(argument));
      if (method === 'enum') {
        return ts.isArrayLiteralExpression(argument) && argument.elements.length > 0
          && argument.elements.every(ts.isStringLiteral);
      }
      return method === 'object' && ts.isObjectLiteralExpression(argument)
        && argument.properties.every((property) => ts.isPropertyAssignment(property)
          && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
          && expression(property.initializer));
    }
    return ['optional', 'required', 'int', 'nonnegative'].includes(method)
      && node.arguments.length === 0 && expression(receiver);
  }
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const bindings = statement.importClause?.namedBindings;
      if (!ts.isStringLiteral(statement.moduleSpecifier)
          || statement.importClause?.name || !bindings || !ts.isNamedImports(bindings)
          || bindings.elements.some((element) => element.propertyName !== undefined)
          || imports.get(statement.moduleSpecifier.text)
            !== bindings.elements.map((element) => element.name.text).sort().join(',')
          || seenImports.has(statement.moduleSpecifier.text)) return false;
      seenImports.add(statement.moduleSpecifier.text);
      continue;
    }
    if (!ts.isVariableStatement(statement)
        || !(statement.declarationList.flags & ts.NodeFlags.Const)) return false;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.name.text.endsWith('Schema')
          || !declaration.initializer || !expression(declaration.initializer)) return false;
      schemas.add(declaration.name.text);
    }
  }
  return seenImports.size === imports.size && schemas.has(profile.requiredSchema);
}

function isDeclarativeEnumSchemaModule(source: ts.SourceFile): boolean {
  let imports = 0;
  let schemas = 0;
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const bindings = statement.importClause?.namedBindings;
      if (!ts.isStringLiteral(statement.moduleSpecifier)
          || statement.moduleSpecifier.text !== 'zod'
          || statement.importClause?.name
          || !bindings || !ts.isNamedImports(bindings)
          || bindings.elements.length !== 1
          || bindings.elements[0].name.text !== 'z'
          || bindings.elements[0].propertyName) return false;
      imports += 1;
      continue;
    }
    if (!ts.isVariableStatement(statement)
        || !(statement.declarationList.flags & ts.NodeFlags.Const)
        || !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      return false;
    }
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer;
      if (!ts.isIdentifier(declaration.name) || !declaration.name.text.endsWith('Schema')
          || !initializer || !ts.isCallExpression(initializer)
          || !ts.isPropertyAccessExpression(initializer.expression)
          || !ts.isIdentifier(initializer.expression.expression)
          || initializer.expression.expression.text !== 'z'
          || initializer.expression.name.text !== 'enum'
          || initializer.arguments.length !== 1) return false;
      const values = initializer.arguments[0];
      if (!ts.isArrayLiteralExpression(values) || values.elements.length === 0
          || !values.elements.every(ts.isStringLiteral)) return false;
      schemas += 1;
    }
  }
  return imports === 1 && schemas > 0;
}

describe('领域契约所有权', () => {
  it('保持遗留 src/types 目录已删除', () => {
    expect(existsSync(resolve('src/types'))).toBe(false);
  });

  it('保持已归位的领域实现不回退到旧路径', () => {
    for (const legacyPath of [
      'src/eval-workflows/hosts/index.ts',
      'src/eval-workflows/hosts/adapters/index.ts',
      'src/eval-workflows/hosts/evaluators/index.ts',
      'src/eval-workflows/hosts/resource-leases/index.ts',
      'src/eval-workflows/inputs/contracts/index.ts',
      'src/eval-workflows/instruments/contracts/index.ts',
      'src/eval-workflows/measurement/analysis/index.ts',
      'src/eval-workflows/measurement/evaluators/index.ts',
      'src/eval-workflows/orchestration/index.ts',
      'src/executors/contracts/index.ts',
      'src/observability/contracts/index.ts',
      'src/analysis',
      'src/artifacts',
      'src/authoring',
      'src/doctor',
      'src/managed',
      'src/skill-definition',
      'src/inputs',
      'src/grading',
      'src/preflight',
      'src/artifact-graph',
      'src/measurement-artifacts',
      'src/package-api',
      'src/eval-workflows/grading',
      'src/eval-workflows/downstream-projections',
      'src/eval-workflows/studio-catalog',
      'src/server',
      'src/renderer',
      'src/evidence/graph/core.ts',
      'src/evidence/storage/prompt-registry.ts',
      'src/observability/trace-ir.ts',
      'src/observability/trace-ingestion.ts',
      'src/observability/trace-projection.ts',
      'src/observability/trace-session-index.ts',
      'src/observability/tool-search.ts',
      'src/observability/trace-adapter.ts',
      'src/observability/trace-source.ts',
      'src/observability/trace-attribution.ts',
      'src/observability/trace-segmenter.ts',
      'src/observability/codex-trace-adapter.ts',
      'src/observability/codex-protocol.ts',
      'src/observability/codex-tool-status.ts',
      'src/observability/codex-exec-command.ts',
      'src/observability/codex-conversation-index.ts',
      'src/observability/inbox.ts',
      'src/observability/inbox-identity.ts',
      'src/observability/inbox-view-model.ts',
      'src/observability/explicit-capture.ts',
      'src/observability/capture-coverage.ts',
      'src/observability/observation-paths.ts',
      'src/observability/source-record-archive.ts',
      'src/observability/review-state.ts',
      'src/observability/resolved-review.ts',
      'src/observability/feedback-matchers.ts',
      'src/observability/feedback-projection.ts',
      'src/observability/problem-patterns.ts',
      'src/observability/conversation-catalog.ts',
      'src/observability/conversation-index-process.ts',
      'src/observability/conversation-view-model.ts',
      'src/observability/knowledge-debugger.ts',
      'src/observability/polling-subscription-hub.ts',
      'src/observability/task-semantic-projection.ts',
      'src/observability/task-window.ts',
      'src/observability/turn-index.ts',
      'src/observability/skill-health-analyzer.ts',
      'src/observability/skill-health-report.ts',
      'src/observability/skill-chain.ts',
      'src/observability/skill-chain-advisories.ts',
      'src/observability/experience-frontmatter.ts',
      'src/observability/text-signals.ts',
    ]) {
      expect(existsSync(resolve(legacyPath)), legacyPath).toBe(false);
    }
  });

  it('observability 根目录只保留稳定 facade', () => {
    const rootModules = readdirSync(resolve('src/observability'))
      .filter((entry) => entry.endsWith('.ts'))
      .sort();

    expect(rootModules).toEqual(['experience.ts']);
  });

  it('Experience 枚举 Schema 只声明字符串取值，不引入实现或副作用', () => {
    const source = ts.createSourceFile(
      EXPERIENCE_ENUM_SCHEMA_FILE,
      readFileSync(resolve(EXPERIENCE_ENUM_SCHEMA_FILE), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    expect(isDeclarativeEnumSchemaModule(source)).toBe(true);
  });

  it('Experience 证据结构 Schema 不引入宿主依赖或变换副作用', () => {
    const file = 'src/observability/contracts/experience-evidence-schema.ts';
    expect(isDeclarativeEvidenceSchemaModule(ts.createSourceFile(
      file, readFileSync(resolve(file), 'utf8'), ts.ScriptTarget.Latest, true,
    ))).toBe(true);
  });

  it.each([
    "z.object({ id: readFileSync('/secret') })",
    "z.object({ [computeKey()]: z.string() })",
    "z.object({ id: z.string() }).transform(() => sideEffect())",
    "z.object({ id: z.string() }); sideEffect()",
  ])('证据结构声明拒绝动态实现：%s', (initializer) => {
    const text = "import { ToolCallStatusSchema } from '../../executors/contracts/tool-call-status-schema.js';\n" + "import { TraceSourceKindSchema } from '../../executors/contracts/trace-source-schema.js';\nimport { TraceSourceMetadataSchema } from './trace-metadata-schema.js';\n" + "import { z } from 'zod';\n"
      + `import { ${EXPERIENCE_EVIDENCE_ENUM_IMPORTS.join(', ')} } from './experience-enums.js';\n`
      + `export const ExperienceEvidenceRefSchema = ${initializer};`;
    expect(isDeclarativeEvidenceSchemaModule(ts.createSourceFile(
      'invalid.ts', text, ts.ScriptTarget.Latest, true,
    ))).toBe(false);
  });

  it.each([
    "import { readFileSync } from 'node:fs'; export const ValueSchema = z.enum(['a']);",
    "import { z } from 'zod'; export function run() { return 'a'; }",
    "import { z } from 'zod'; export const ValueSchema = z.enum(loadValues());",
    "import { z } from 'zod'; export const ValueSchema = z.enum([...values]);",
    "import { z } from 'zod'; export const ValueSchema = z.enum(['a']); sideEffect();",
    "import { z } from 'zod'; export let ValueSchema = z.enum(['a']);",
  ])('枚举声明边界拒绝实现代码：%s', (text) => {
    expect(isDeclarativeEnumSchemaModule(ts.createSourceFile(
      'invalid.ts', text, ts.ScriptTarget.Latest, true,
    ))).toBe(false);
  });

  it('领域 contracts 与 view-models 保持为无运行时实现的纯类型模块', () => {
    const violations: string[] = [];
    for (const file of PURE_DOMAIN_TYPE_FILES) {
      const source = ts.createSourceFile(
        file,
        readFileSync(resolve(file), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      for (const statement of source.statements) {
        if (ts.isImportDeclaration(statement)) {
          if (statement.importClause?.isTypeOnly !== true) {
            violations.push(`${file}：只允许 import type`);
          }
          if (ts.isStringLiteral(statement.moduleSpecifier)) {
            const specifier = statement.moduleSpecifier.text;
            const target = relative(
              process.cwd(),
              resolve(dirname(resolve(file)), specifier.replace(/\.js$/, '.ts')),
            );
            const declarativeEnumTypeImport = ((file === 'src/observability/contracts/experience.ts' || file === 'src/observability/contracts/problem-patterns.ts')
              && EXPERIENCE_ENUM_TYPE_IMPORTS.has(specifier)
            || ((file === 'src/executors/contracts/trace-source.ts' && ['zod', './trace-source-schema.js'].includes(specifier) || (file === 'src/executors/contracts/trace.ts' && ['zod', './tool-call-status-schema.js'].includes(specifier))))
            || (file === 'src/observability/contracts/trace.ts' && ['zod', './trace-metadata-schema.js'].includes(specifier)));
            if (!PURE_DOMAIN_TYPE_FILE_SET.has(target) && !declarativeEnumTypeImport) {
              violations.push(`${file}：依赖了非契约模块 ${specifier}`);
            }
          }
          continue;
        }
        if (ts.isExportDeclaration(statement)) {
          if (statement.isTypeOnly !== true) {
            violations.push(`${file}：只允许 export type`);
          }
          continue;
        }
        if (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) {
          violations.push(`${file}：包含运行时声明 ${ts.SyntaxKind[statement.kind]}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});


describe('trace leaf schema ownership', () => {
  it.each([
    ['src/executors/contracts/trace-source-schema.ts', 'TraceSourceKindSchema'],
    ['src/observability/contracts/trace-metadata-schema.ts', 'TraceSourceMetadataSchema'],
    ['src/executors/contracts/tool-call-status-schema.ts', 'ToolCallStatusSchema'],
  ])('%s remains a declarative leaf schema', (file, requiredSchema) => {
    const source = ts.createSourceFile(file, readTraceSchemaSource(file, 'utf8'), ts.ScriptTarget.Latest, true);
    expect(isDeclarativeEvidenceSchemaModule(source, {
      imports: [['zod', 'z']],
      schemas: [],
      requiredSchema,
    })).toBe(true);
  });
});
