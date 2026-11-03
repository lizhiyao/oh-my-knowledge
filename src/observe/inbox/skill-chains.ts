import { buildObservationSkillChain, type ObservationSkillChain } from '../skill-health/skill-chain.js';
import type { ObservationInboxReport } from '../contracts/inbox.js';

/**
 * 观察收件箱的 skill 链单一生产者。
 *
 * 链要读 SKILL.md，属宿主侧文件 IO，所以只在这里按报告自带的 cwd 证据构建，
 * 下游（诊断、视图、宿主命令）一律消费结果，不再各自解析目录。
 *
 * 歧义即跳过：同一 skill 出现多个 cwd 时，猜任何一个都可能读到别的项目的 SKILL.md，
 * 产出的 `skill_md_not_found` 假阳性会被持久化进 report.diagnostics，事后无从分辨。
 */
export function inferSkillCwds(
  reports: readonly Pick<ObservationInboxReport, 'items' | 'experience'>[],
): Map<string, string | null> {
  const cwdsBySkill = new Map<string, Set<string>>();
  const add = (skillName: string | undefined | null, cwd: string | undefined): void => {
    if (!skillName || !cwd) return;
    const bucket = cwdsBySkill.get(skillName) ?? new Set<string>();
    bucket.add(cwd);
    cwdsBySkill.set(skillName, bucket);
  };
  for (const report of reports) {
    for (const item of report.items) add(item.skillName, item.cwd);
    for (const invocation of report.experience?.invocations ?? []) add(invocation.skillName, invocation.cwd);
    for (const slice of report.experience?.goalSlices ?? []) add(slice.skillName, slice.cwd);
  }
  const resolved = new Map<string, string | null>();
  for (const [skillName, cwds] of cwdsBySkill) {
    resolved.set(skillName, cwds.size === 1 ? Array.from(cwds)[0] ?? null : null);
  }
  return resolved;
}

export function skillNamesFromReports(reports: readonly ObservationInboxReport[]): string[] {
  const names = new Set<string>();
  for (const report of reports) {
    for (const key of Object.keys(report.meta.skillInvocationCounts ?? {})) names.add(key);
    for (const key of Object.keys(report.meta.skillSessionCounts ?? {})) names.add(key);
    for (const item of report.items) if (item.skillName) names.add(item.skillName);
    for (const skill of report.experience?.skills ?? []) names.add(skill.skillName);
  }
  return Array.from(names).filter(Boolean).sort();
}

/** 只为「有唯一 cwd 证据」的 skill 建链；无证据或歧义的 skill 出现在 skipped 里。 */
export function buildSkillChainsForEvidence(
  skillNames: readonly string[],
  reports: readonly ObservationInboxReport[],
  experienceReports: ObservationSkillChainExperienceSource[] = reports
    .map((report) => report.experience)
    .filter((experience): experience is NonNullable<typeof experience> => experience !== undefined),
): { chains: Record<string, ObservationSkillChain>; skipped: string[] } {
  const cwds = inferSkillCwds(reports);
  const chains: Record<string, ObservationSkillChain> = {};
  const skipped: string[] = [];
  for (const skillName of [...skillNames].sort()) {
    const cwd = cwds.get(skillName);
    if (!cwd) {
      skipped.push(skillName);
      continue;
    }
    chains[skillName] = buildObservationSkillChain(skillName, cwd, experienceReports);
  }
  return { chains, skipped };
}

type ObservationSkillChainExperienceSource = Parameters<typeof buildObservationSkillChain>[2] extends
  (infer Item)[] | undefined ? Item : never;
