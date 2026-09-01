/**
 * issue #206 护栏:裸 `kind` 字段只允许 `ArtifactKind`。
 *
 * 产品语义里不带限定词的 `kind` 默认指 knowledge artifact 类型(`Artifact.kind: ArtifactKind`)。
 * 例外是已经发布并落盘/对外暴露的 public schema（如 report / doctor / observe 的顶层
 * kind）；其它判别字段必须用限定名（`eventKind` / `runtimeKind` / `standardKind` ...）。
 *
 * 本测试用 TypeScript AST 扫 `src/**\/*.ts` 里**每个名为 `kind` 的字段声明**
 * (interface / type-literal 的 PropertySignature、class 的 PropertyDeclaration —— 不含
 * 函数 param、`.kind` 读取、对象字面量构造点、注释 / 字符串):
 *   - 字段类型是 `ArtifactKind`(或以它为基的类型)→ 放行;
 *   - 否则必须登记在 FROZEN_KIND_EXCEPTIONS —— 这些都是已经序列化进
 *     report / observe / doctor / diagnosis JSON 的判别字段,改名会破坏读取已有落盘文件,
 *     要走单独的数据 / schema 迁移(序列化向后兼容,非统计可比性;
 *     详见 docs/specs/terminology-spec.md §5.4);
 *   - 两者都不是 → 新代码引入了裸 `kind`,失败。改成限定名,或(确为新的持久化判别字段时)
 *     显式登记并在 PR 里说明理由。
 *
 * key 形如 `相对路径::EnclosingType::字段类型文本`,只在真正增删 `kind` 字段时变化,
 * 对缩进 / 换行 / 重排不敏感。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const SRC_DIR = join(PROJECT_ROOT, 'src');

// 已序列化进 JSON 的判别字段:改名会破坏反序列化磁盘上已有的 report/observe/doctor/diagnosis
// 文件,要走单独的数据/schema 迁移(序列化向后兼容,非统计可比性),本轮冻结。
// 这是债务登记,不是「允许裸 kind」的背书。
const FROZEN_KIND_EXCEPTIONS = new Set<string>([
  "src/types/doctor.ts::DoctorReport::'doctor'",
  "src/observability/contracts/review.ts::ObservationReviewState::'observe-review-state'",
  "src/observability/contracts/inbox.ts::ObservationInboxReport::'observe-inbox'",
  "src/observability/contracts/experience.ts::ObservationExperienceReport::'observe-experience'",
  "src/observability/soft-standards/types.ts::SkillDerivedStandards::'observe-skill-derived-standards'",
  "src/observability/skill-health-analyzer.ts::SkillHealthReport::'observe-health'",
  // —— 持久化 observe / experience JSON ——
  'src/observability/contracts/experience.ts::ExperienceEvidenceRef::ExperienceEvidenceKind',
  'src/observability/contracts/experience.ts::ExperienceSessionStoryNode::ExperienceSessionStoryNodeKind',
  "src/observability/contracts/experience.ts::ExperienceGoalEvidenceRef::'user_message' | 'goal_slice' | 'llm_goal'",
  'src/observability/contracts/experience.ts::ExperienceEpisodeArtifact::ExperienceEpisodeArtifactKind',
  'src/observability/contracts/experience.ts::ExperienceSessionStoryGraphNode::ExperienceSessionStoryNodeKind',
  'src/observability/contracts/experience.ts::ExperienceReviewerReport::ExperienceReviewerReportScope',
  'src/observability/contracts/problem-patterns.ts::ExperienceProblemEvidenceRef::string',
  'src/observability/contracts/problem-patterns.ts::ProblemTimelineEvent::string',
  // —— 持久化 soft-standards JSON（含 enhancedReview 内嵌结构）——
  // ResolvedSkillStandard 非持久（view-model），但与持久 standard 同源、且被 renderer 多处 .kind 消费，
  // 跨模块改名风险高，渐进式留待后续单独处理。
  // —— 持久化 diagnosis JSON（payload spread 进 Diagnosis）——
  'src/types/diagnosis.ts::DiagnosisEvidenceRef::string',
  // 持久化进 experience evidence-pack 的 runtime check 节点
  // 外部 codex JSONL 事件的镜像 shape（omk 解析 codex stdout，非 omk 自有判别字段；codex 实际用 type）
]);

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

interface KindSite {
  key: string;
  file: string;
  line: number;
  enclosing: string;
  typeText: string;
}

function enclosingTypeName(node: ts.Node): string {
  let p: ts.Node | undefined = node.parent;
  while (p) {
    if (ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p)) return p.name.text;
    if (ts.isClassDeclaration(p) && p.name) return p.name.text;
    p = p.parent;
  }
  return '(anonymous)';
}

function findKindFields(absFile: string): KindSite[] {
  const text = readFileSync(absFile, 'utf8');
  const sf = ts.createSourceFile(absFile, text, ts.ScriptTarget.Latest, true);
  const rel = relative(PROJECT_ROOT, absFile).split('\\').join('/');
  const out: KindSite[] = [];
  function visit(node: ts.Node): void {
    if (
      (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'kind'
    ) {
      const typeText = node.type ? node.type.getText(sf).replace(/\s+/g, ' ').trim() : '(none)';
      const enclosing = enclosingTypeName(node);
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      out.push({ key: `${rel}::${enclosing}::${typeText}`, file: rel, line, enclosing, typeText });
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return out;
}

// `ArtifactKind` 本身,或以它为基的类型(如 `Exclude<ArtifactKind, 'baseline'>` / `ArtifactKind | null`)。
function isArtifactKindType(typeText: string): boolean {
  return /\bArtifactKind\b/.test(typeText);
}

describe('issue #206: 裸 kind 护栏', () => {
  it('每个 kind 字段声明要么是 ArtifactKind,要么是已登记的持久化例外', () => {
    const sites = collectTsFiles(SRC_DIR).flatMap(findKindFields);

    const offenders = sites
      .filter((s) => !isArtifactKindType(s.typeText) && !FROZEN_KIND_EXCEPTIONS.has(s.key))
      .map((s) => `  ${s.file}:${s.line}  ${s.enclosing}.kind: ${s.typeText}\n    key: ${s.key}`)
      .sort();

    const presentKeys = new Set(sites.map((s) => s.key));
    const staleFrozen = [...FROZEN_KIND_EXCEPTIONS].filter((k) => !presentKeys.has(k)).sort();

    assert.deepEqual(
      offenders,
      [],
      `发现未登记的裸 \`kind\` 字段声明(issue #206)。裸 kind 留给 ArtifactKind:\n` +
        `${offenders.join('\n')}\n\n` +
        `修法:改成限定名(eventKind / runtimeKind / standardKind / recordKind 等);` +
        `或——若确为新的持久化判别字段——把上面的 key 加进 FROZEN_KIND_EXCEPTIONS 并在 PR 说明理由。`,
    );
    assert.deepEqual(
      staleFrozen,
      [],
      `这些 FROZEN_KIND_EXCEPTIONS 已不存在(字段被删 / 改名 / 改类型),请删除以保持清单收紧:\n  ${staleFrozen.join('\n  ')}`,
    );
  });
});
