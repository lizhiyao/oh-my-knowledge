/**
 * doctor preflight context builder。
 *
 * 把「评测前 doctor 要检查什么 + 路径上下文锚到哪里」从评测引擎里抽出来,
 * 让 doctor engine 只消费 ctx，不再自己猜 eval 的路径语义。
 *
 * Bench 路径语义本来就复杂(.md / SKILL.md 目录 / git: / 绝对路径 / name@cwd /
 * runtime-context-only / batch paired samples), doctor 嵌入需要用而不是旁路重建。
 * 任何 eval 路径推断的边界变化，只需改这一处，doctor engine 零修改。
 *
 * 不服务 standalone `omk doctor [path]` — 那条路径是用户视角的 target 解析,
 * 由 src/doctor/index.ts:resolveDoctorTargets() 单独负责。
 */

import { resolve } from 'node:path';
import type { DependencyRequirements } from '../eval-core/dependency-checker.js';
import type { Artifact, Sample } from '../types/index.js';

export interface DoctorPreflightContext {
  /** 过滤掉 baseline-kind 后的 artifact 列表; doctor 只检查实际被测的 skill。 */
  doctorArtifacts: Artifact[];
  /** dependency / preflight 路径基准。
   *  解析规则与生产 Evaluation Core host 的 dependency check 严格对齐：
   *  artifacts.find(a => a.cwd)?.cwd > resolve(skillDir) > process.cwd()。 */
  dependencyCwd: string;
  samples?: Sample[];
  requires?: DependencyRequirements;
}

export function buildDoctorPreflightContext(input: {
  artifacts: Artifact[];
  samples?: Sample[];
  requires?: DependencyRequirements;
  skillDir: string;
}): DoctorPreflightContext | null {
  const doctorArtifacts = input.artifacts.filter((a) => a.kind !== 'baseline');
  if (doctorArtifacts.length === 0) return null; // baseline-only run, doctor skip

  // dependencyCwd 解析必须看完整 input.artifacts(包括 baseline-kind),
  // 因为 `project-env@/repo` 这类 runtime-context-only 在 skill-loader.ts:242
  // 会被生成成 kind:'baseline' 但带 cwd。如果只看 doctorArtifacts 就会丢这个
  // cwd, 让 requires.files / preflight 错锚到 skillDir, false-fail 用户。
  const dependencyCwd = input.artifacts.find((a) => a.cwd)?.cwd
    ?? resolve(input.skillDir);

  return {
    doctorArtifacts,
    dependencyCwd,
    samples: input.samples,
    requires: input.requires,
  };
}
