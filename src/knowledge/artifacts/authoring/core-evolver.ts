import { basename, dirname, join, resolve } from 'node:path';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import type { StoredCoreRunArtifacts } from '../../../eval-workflows/artifact-store/index.js';
import { parseCompositeTableValue } from '../../../eval-workflows/measurement/analysis/composite-table.js';
import { createExecutor } from '../../../executors/index.js';
import { buildImprovementPrompt, computeEditDelta } from './improvement.js';
import { distributableCopyFilter, hashArtifactSource } from '../sources/content-hash.js';
import { writeTextFileAtomic } from '../../../evidence/storage/atomic-text.js';
import { applySkillTextEdits, SKILL_EDIT_SYSTEM_PROMPT } from './text-edits.js';

const IMPROVE_SYSTEM_PROMPT = `你是一个 AI 提示词改进专家。请依据真实评测弱项对 skill 做最小、可审查的修改。保留有效内容，不重排无关结构，不添加泛化空话。直接输出改进后的完整 skill，不要添加代码围栏或解释。`;
const IMPROVE_AGENT_SYSTEM_PROMPT = `${SKILL_EDIT_SYSTEM_PROMPT}\n用途：omk.evolve-agent/v2，只处理真实评测暴露的问题。`;

export interface CoreEvolverOptions {
  signal?: AbortSignal;
  skillPath: string;
  isDirectorySkill: boolean;
  rounds: number;
  target: number | null;
  model: string;
  improveModel: string;
  executorName: string;
  timeoutMs: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  evaluatePair: (control: string, treatment: string) => Promise<StoredCoreRunArtifacts>;
  writeBackToSource: boolean;
  improveMode: 'agent' | 'rewrite';
  editBudget: number;
  rejectMemory: boolean;
  onRoundProgress?: ((event: Readonly<{
    round: number;
    totalRounds: number;
    phase: string;
    score?: number;
    delta?: number;
    accepted?: boolean;
    costUSD?: number;
    costReported?: boolean;
    decisionAccepted?: boolean;
    error?: string;
  }>) => void) | null;
}

export interface CoreEvolverResult {
  startScore: number;
  finalScore: number;
  bestRound: number;
  totalRounds: number;
  totalCostUSD: number;
  costReported?: boolean;
  trajectory: Array<{
    round: number;
    score: number;
    delta: number;
    accepted: boolean;
    costUSD: number;
    editRatio?: number;
    rejectedPreEval?: boolean;
  }>;
  bestSkillPath: string;
  allVersions: string[];
  runId?: string;
}

interface Measurement {
  stored: StoredCoreRunArtifacts;
  targetId: string;
  scores: ReadonlyMap<string, number>;
  score: number;
  costUSD: number;
  costReported: boolean;
}

export interface MaterializeCoreEvolveSnapshotInput {
  readonly skillDirectory: string;
  readonly evolveDirectory: string;
  readonly skillName: string;
  readonly round: number;
  readonly content: string;
  readonly isDirectorySkill: boolean;
}

/** Preserves the full distributable artifact construct for directory-skill candidates. */
export function materializeCoreEvolveSnapshot(
  input: Readonly<MaterializeCoreEvolveSnapshotInput>,
): { root: string; contentPath: string } {
  if (!input.isDirectorySkill) {
    const path = join(input.evolveDirectory, `${input.skillName}.r${input.round}.md`);
    writeFileSync(path, input.content);
    return { root: path, contentPath: path };
  }
  const root = join(input.evolveDirectory, `${input.skillName}.r${input.round}`);
  const stagingDirectory = mkdtempSync(join(tmpdir(), 'omk-core-evolve-'));
  const stagedRoot = join(stagingDirectory, 'artifact');
  try {
    // Node 会在调用 filter 前拒绝复制到 source 子目录，因此先在 source 外构造完整快照。
    cpSync(input.skillDirectory, stagedRoot, {
      recursive: true,
      filter: distributableCopyFilter(input.skillDirectory),
    });
    // rN 是 evolve 自己拥有的生成物；重跑同一轮先清掉旧快照，避免已删除资产残留。
    rmSync(root, { recursive: true, force: true });
    cpSync(stagedRoot, root, { recursive: true });
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
  const contentPath = join(root, 'SKILL.md');
  writeFileSync(contentPath, input.content);
  return { root, contentPath };
}

function parseImprovedSkill(output: string): string {
  let content = output.trim();
  const fenced = content.match(/```(?:markdown|md)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) content = fenced[1].trim();
  return content;
}

function targetMeasurement(
  stored: StoredCoreRunArtifacts,
  targetKind: 'control' | 'treatment',
): Measurement {
  const comparisons = stored.plan.definition.comparisons;
  if (comparisons.length !== 1 || comparisons[0].treatmentTargetIds.length !== 1) {
    throw new Error('Core evolve 需要恰好一个 control 与一个 treatment 的封存比较。');
  }
  const comparison = comparisons[0];
  const targetId = targetKind === 'control'
    ? comparison.controlTargetId : comparison.treatmentTargetIds[0];
  const target = stored.plan.execution.targets.find((entry) => entry.targetId === targetId);
  if (target === undefined) throw new Error(`Core evolve 缺少 ${targetKind} Target。`);
  const compositeRecord = stored.analysis.records.find((record) => (
    record.analysisStatus === 'completed'
      && record.outputSchema.schemaVersion === 'omk.composite-table/v1'
  ));
  if (compositeRecord?.analysisStatus !== 'completed') {
    throw new Error('Core evolve 缺少可验证的 composite analysis。');
  }
  const table = parseCompositeTableValue(compositeRecord.value);
  const scores = new Map(table.groups.flatMap((group) => (
    group.targetId === target.targetId && group.aggregate.aggregateStatus === 'observed'
      ? [[group.sampleId, group.aggregate.score] as const]
      : []
  )));
  if (scores.size === 0) throw new Error('Core evolve 没有可用的 per-sample composite evidence。');
  const score = [...scores.values()].reduce((sum, value) => sum + value, 0) / scores.size;
  const runTotals = stored.report.budgetSummary.scopes.find((scope) => scope.scopeKind === 'run')?.totals;
  const providerCosts = runTotals?.reportedProviderCosts ?? [];
  const costUSD = providerCosts
    .filter((cost) => cost.currency === 'USD')
    .reduce((sum, cost) => sum + cost.amount, 0);
  return {
    stored,
    targetId: target.targetId,
    scores,
    score: Number(score.toFixed(4)),
    costUSD,
    costReported: (runTotals?.unreportedProviderCostInvocations ?? 0) === 0,
  };
}

function weakSamples(measurement: Measurement) {
  return [...measurement.scores.entries()]
    .sort((left, right) => (
      left[1] - right[1]
      || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)
    ))
    .slice(0, 5)
    .map(([sampleId, score]) => ({
      sample_id: sampleId,
      compositeScore: score,
      llmReason: null,
      failedAssertions: [],
      dimensions: null,
    }));
}

function coreAccepted(stored: StoredCoreRunArtifacts): boolean {
  const decision = stored.report.decision;
  return decision?.decisionStatus === 'decided'
    && decision.verdict === 'PROGRESS'
    && decision.reasonCodes.includes('release-gates-passed');
}

/** Core-native authoring loop: every acceptance is an explicit Core A/B decision. */
export async function evolveSkillCore(options: Readonly<CoreEvolverOptions>): Promise<CoreEvolverResult> {
  options.signal?.throwIfAborted();
  const sourcePath = resolve(options.skillPath);
  if (!existsSync(sourcePath)) throw new Error(`skill file not found: ${sourcePath}`);
  const skillDirectory = dirname(sourcePath);
  const skillName = basename(sourcePath, '.md') === 'SKILL'
    ? basename(skillDirectory)
    : basename(sourcePath, '.md');
  const evolveDirectory = join(skillDirectory, 'evolve');
  mkdirSync(evolveDirectory, { recursive: true });
  const sourceRoot = options.isDirectorySkill ? skillDirectory : sourcePath;
  const sourceHash = hashArtifactSource(sourceRoot, options.isDirectorySkill);
  const snapshot = (round: number, content: string, directory = skillDirectory) => materializeCoreEvolveSnapshot({
    skillDirectory: directory,
    evolveDirectory,
    skillName,
    round,
    content,
    isDirectorySkill: options.isDirectorySkill,
  });
  const sourceContent = readFileSync(sourcePath, 'utf8');
  let currentContent = sourceContent;
  const baselinePath = snapshot(0, currentContent).root;
  if (hashArtifactSource(baselinePath, options.isDirectorySkill) !== sourceHash) {
    throw new Error('Core evolve 源载体在基线捕获期间发生变化，请重新运行。');
  }
  const allVersions = [baselinePath];
  const baseline = targetMeasurement(
    await options.evaluatePair('baseline', baselinePath),
    'treatment',
  );
  let currentMeasurement = baseline;
  let currentPath = baselinePath;
  let bestScore = baseline.score;
  let bestRound = 0;
  let totalCostUSD = baseline.costUSD;
  let costReported = baseline.costReported;
  let consecutiveRejects = 0;
  const rejectedEdits: string[] = [];
  const trajectory: CoreEvolverResult['trajectory'] = [{
    round: 0,
    score: bestScore,
    delta: 0,
    accepted: true,
    costUSD: baseline.costUSD,
  }];
  options.onRoundProgress?.({
    round: 0,
    totalRounds: options.rounds,
    phase: 'baseline',
    score: bestScore,
    costUSD: baseline.costUSD,
    costReported: baseline.costReported,
  });

  for (let round = 1; round <= options.rounds; round += 1) {
    options.signal?.throwIfAborted();
    const prompt = buildImprovementPrompt(
      currentContent,
      bestScore,
      weakSamples(currentMeasurement),
      options.rejectMemory ? rejectedEdits : undefined,
    );
    const executor = createExecutor(options.executorName);
    let candidateContent: string;
    const improvement = await executor({
      model: options.improveModel,
      system: options.improveMode === 'agent' ? IMPROVE_AGENT_SYSTEM_PROMPT : IMPROVE_SYSTEM_PROMPT,
      prompt,
      timeoutMs: options.timeoutMs,
      abortSignal: options.signal,
      effort: options.effort,
      ...(options.improveMode === 'rewrite' ? { lean: true } : {}),
    });
    options.signal?.throwIfAborted();
    totalCostUSD += improvement.costUSD;
    if (improvement.costReportedByExecutor === false) costReported = false;
    if (!improvement.ok) {
      consecutiveRejects += 1;
      trajectory.push({ round, score: bestScore, delta: 0, accepted: false, costUSD: improvement.costUSD });
      options.onRoundProgress?.({ round, totalRounds: options.rounds, phase: 'error', error: improvement.error });
      if (consecutiveRejects >= 2) break;
      continue;
    }
    try {
      candidateContent = options.improveMode === 'agent'
        ? applySkillTextEdits(currentContent, improvement.output ?? '').content
        : parseImprovedSkill(improvement.output ?? '');
    } catch (error) {
      if (options.improveMode === 'rewrite') throw error;
      consecutiveRejects += 1;
      trajectory.push({ round, score: bestScore, delta: 0, accepted: false, costUSD: improvement.costUSD });
      options.onRoundProgress?.({
        round, totalRounds: options.rounds, phase: 'error',
        error: '改进响应不是可唯一定位的合法编辑，候选已拒绝。',
      });
      if (consecutiveRejects >= 2) break;
      continue;
    }
    if (candidateContent === currentContent) {
      consecutiveRejects += 1;
      trajectory.push({ round, score: bestScore, delta: 0, accepted: false,
        costUSD: improvement.costUSD, editRatio: 0, rejectedPreEval: true });
      if (consecutiveRejects >= 2) break;
      continue;
    }
    const candidatePath = snapshot(round, candidateContent,
      options.isDirectorySkill ? currentPath : skillDirectory).root;
    allVersions.push(candidatePath);
    const edit = computeEditDelta(currentContent, candidateContent);
    if (options.editBudget > 0 && edit.ratio > options.editBudget && edit.changedLines > 4) {
      consecutiveRejects += 1;
      if (options.rejectMemory) rejectedEdits.push(edit.summary);
      trajectory.push({
        round,
        score: bestScore,
        delta: 0,
        accepted: false,
        costUSD: improvement.costUSD,
        editRatio: Number(edit.ratio.toFixed(4)),
        rejectedPreEval: true,
      });
      if (consecutiveRejects >= 2) break;
      continue;
    }
    const artifacts = await options.evaluatePair(currentPath, candidatePath);
    const candidate = targetMeasurement(artifacts, 'treatment');
    const refreshedCurrent = targetMeasurement(artifacts, 'control');
    totalCostUSD += candidate.costUSD;
    if (!candidate.costReported) costReported = false;
    // Core Decision is the sole admission authority. Comparing the candidate score with a score
    // from an earlier run would add an unsealed, cross-run gate whose sampling/runtime noise is
    // not represented by the current comparison family.
    const accepted = coreAccepted(artifacts);
    const delta = Number((candidate.score - refreshedCurrent.score).toFixed(4));
    if (accepted) {
      currentContent = candidateContent;
      currentPath = candidatePath;
      currentMeasurement = candidate;
      bestScore = candidate.score;
      bestRound = round;
      consecutiveRejects = 0;
    } else {
      currentMeasurement = refreshedCurrent;
      consecutiveRejects += 1;
      if (options.rejectMemory) rejectedEdits.push(edit.summary);
    }
    trajectory.push({
      round,
      score: candidate.score,
      delta,
      accepted,
      costUSD: improvement.costUSD + candidate.costUSD,
      editRatio: Number(edit.ratio.toFixed(4)),
    });
    options.onRoundProgress?.({
      round,
      totalRounds: options.rounds,
      phase: 'done',
      score: candidate.score,
      delta,
      accepted,
      costUSD: improvement.costUSD + candidate.costUSD,
      costReported: improvement.costReportedByExecutor !== false && candidate.costReported,
      decisionAccepted: accepted,
    });
    if (options.target !== null && bestScore >= options.target) break;
    if (consecutiveRejects >= 2) break;
  }

  let evidence: StoredCoreRunArtifacts | undefined;
  let finalScore = bestScore;
  if (bestRound > 0 && options.writeBackToSource) {
    const assertSourceUnchanged = (): void => {
      if (hashArtifactSource(sourceRoot, options.isDirectorySkill) !== sourceHash) {
        throw new Error('Core evolve 源载体已被修改，拒绝覆盖；候选快照保留在 evolve 目录。');
      }
    };
    assertSourceUnchanged();
    // Final admission compares the untouched original source with the selected snapshot. The source
    // is written only after that authenticated Core decision passes, so a failed final run cannot
    // leave a half-committed evolve result on disk.
    evidence = await options.evaluatePair(baselinePath, currentPath);
    if (!coreAccepted(evidence)) {
      throw new Error('Core evolve 最终写回门禁未通过；源文件保持不变。');
    }
    const finalMeasurement = targetMeasurement(evidence, 'treatment');
    finalScore = finalMeasurement.score;
    totalCostUSD += finalMeasurement.costUSD;
    if (!finalMeasurement.costReported) costReported = false;
    options.signal?.throwIfAborted();
    assertSourceUnchanged();
    writeTextFileAtomic(sourcePath, currentContent, { expectedPreviousText: sourceContent });
  }
  return {
    startScore: baseline.score,
    finalScore,
    bestRound,
    totalRounds: trajectory.length - 1,
    totalCostUSD: Number(totalCostUSD.toFixed(6)),
    ...(costReported ? {} : { costReported: false }),
    trajectory,
    bestSkillPath: currentPath,
    allVersions,
    ...(evidence === undefined ? {} : { runId: evidence.manifest.runId }),
  };
}
