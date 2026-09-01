/**
 * skill SKILL.md frontmatter 读取 + 投影到 experience 报告字段。
 *
 * experience.ts 在构建复盘报告时需要三处 frontmatter 投影:
 *   - `loadFrontmatterSkillType`:读 `skillType` / `type` / `category` 字段,
 *     归一化为 `ExperienceRuntimeSkillType`(router / executor / advisory / ...),
 *     用于声明侧 skill 类型(对照 trace 推断)
 *   - `loadSkillDeclarationCheck`:解析 SKILL.md 的 hard rules / workflows 声明,
 *     用于复盘报告里的 declaration 步骤
 *   - `loadExpectedToolsForSkill`:读 `expected_tools` / `expectedTools` 字段,
 *     用于「真用上声明的工具」判定
 *
 * 设计原则:
 *   - 只做 IO + 投影:读 skill.md、解析 frontmatter、归一化字段
 *   - 不做事件链路推断:`traceInferredSkillType` 等不属于 frontmatter 投影,留在 experience.ts
 *   - 所有读文件异常 swallow:复盘报告不该因为缺一个 skill.md 而 throw,
 *     缺失时降级为 undefined / [] / `{declared:false,count:0}`
 *
 * 阶段 3 PR2 拆分历史:原本住在 experience.ts 内部,与事件链路投影逻辑混杂。
 * 拆出独立文件后,experience.ts 主体回归「事件 → 复盘字段」单职责,frontmatter
 * IO 改为通过本模块显式调用。
 */

import { readFileSync } from 'node:fs';
import { parseSkillFrontmatter, validateSkillHardRules, validateSkillWorkflows } from '../skill-definition/hard-rules.js';
import { findSkillMdPath } from './skill-chain.js';
import type { ExperienceRuntimeSkillType } from './contracts/experience.js';

export interface SkillDeclarationCheck {
  hardRules: {
    declared: boolean;
    count: number;
  };
  workflows: {
    declared: boolean;
    count: number;
  };
}

export function loadFrontmatterSkillType(skillName: string, cwd?: string): ExperienceRuntimeSkillType | undefined {
  const path = findSkillMdPath(skillName, cwd ?? '');
  if (!path) return undefined;
  try {
    const parsed = parseSkillFrontmatter(readFileSync(path, 'utf8'));
    if (!parsed.ok) return undefined;
    const raw = parsed.data?.skillType ?? parsed.data?.type ?? parsed.data?.category;
    return normalizeRuntimeSkillType(raw);
  } catch {
    return undefined;
  }
}

export function loadSkillDeclarationCheck(skillName: string, cwd?: string): SkillDeclarationCheck {
  const path = findSkillMdPath(skillName, cwd ?? process.cwd());
  if (!path) {
    return {
      hardRules: { declared: false, count: 0 },
      workflows: { declared: false, count: 0 },
    };
  }
  try {
    const content = readFileSync(path, 'utf-8');
    const hardRules = validateSkillHardRules(content);
    const workflows = validateSkillWorkflows(content);
    return {
      hardRules: { declared: hardRules.declared, count: hardRules.rules.length },
      workflows: { declared: workflows.declared, count: workflows.workflows.reduce((sum, workflow) => sum + workflow.nodes.length, 0) },
    };
  } catch {
    return {
      hardRules: { declared: false, count: 0 },
      workflows: { declared: false, count: 0 },
    };
  }
}

export function loadExpectedToolsForSkill(skillName: string, cwd?: string): string[] {
  const path = findSkillMdPath(skillName, cwd ?? process.cwd());
  if (!path) return [];
  try {
    const parsed = parseSkillFrontmatter(readFileSync(path, 'utf-8'));
    const data = parsed.ok ? parsed.data : undefined;
    const value = data?.expected_tools ?? data?.expectedTools;
    return Array.isArray(value)
      ? unique(value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim()))
      : [];
  } catch {
    return [];
  }
}

function normalizeRuntimeSkillType(value: unknown): ExperienceRuntimeSkillType | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/[_\s-]+/g, '_');
  if (normalized === 'router' || normalized === 'route') return 'router';
  if (normalized === 'delegation' || normalized === 'delegate' || normalized === 'delegator') return 'delegation';
  if (normalized === 'executor' || normalized === 'execute') return 'executor';
  if (normalized === 'advisory' || normalized === 'advisor' || normalized === 'consulting') return 'advisory';
  if (normalized === 'workflow_owner' || normalized === 'workflowowner' || normalized === 'workflow') return 'workflow_owner';
  return undefined;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}
