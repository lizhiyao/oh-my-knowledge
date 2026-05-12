import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  validateSkillHardRules,
  validateSkillWorkflows,
  type SkillHardRule,
  type SkillWorkflow,
} from '../shared/hard-rules.js';

export interface ObservationSkillChain {
  skillName: string;
  definition: {
    found: boolean;
    path?: string;
    content?: string;
    truncated?: boolean;
  };
  healthCheck: {
    source: 'doctor-static-rules';
    hardRules: {
      declared: boolean;
      valid: boolean;
      count: number;
      rules: SkillHardRule[];
      errors: string[];
    };
    workflows: {
      declared: boolean;
      valid: boolean;
      branchCount: number;
      nodeCount: number;
      workflows: SkillWorkflow[];
      errors: string[];
    };
  };
  runtime: {
    supported: false;
    message: string;
  };
}

const MAX_SKILL_DEFINITION_CHARS = 12000;

export function buildObservationSkillChains(skillNames: string[], cwd = process.cwd()): Record<string, ObservationSkillChain> {
  const uniqueSkillNames = Array.from(new Set(skillNames.filter(Boolean))).sort();
  return Object.fromEntries(uniqueSkillNames.map((skillName) => [skillName, buildObservationSkillChain(skillName, cwd)]));
}

export function buildObservationSkillChain(skillName: string, cwd = process.cwd()): ObservationSkillChain {
  const path = findSkillMdPath(skillName, cwd);
  if (!path) return emptySkillChain(skillName);
  const content = readFileSync(path, 'utf-8');
  const hardRules = validateSkillHardRules(content);
  const workflows = validateSkillWorkflows(content);
  const nodeCount = workflows.workflows.reduce((sum, workflow) => sum + workflow.nodes.length, 0);
  const truncated = content.length > MAX_SKILL_DEFINITION_CHARS;
  return {
    skillName,
    definition: {
      found: true,
      path,
      content: truncated ? content.slice(0, MAX_SKILL_DEFINITION_CHARS) : content,
      truncated,
    },
    healthCheck: {
      source: 'doctor-static-rules',
      hardRules: {
        declared: hardRules.declared,
        valid: hardRules.ok,
        count: hardRules.rules.length,
        rules: hardRules.rules,
        errors: hardRules.errors,
      },
      workflows: {
        declared: workflows.declared,
        valid: workflows.ok,
        branchCount: workflows.workflows.length,
        nodeCount,
        workflows: workflows.workflows,
        errors: workflows.errors,
      },
    },
    runtime: runtimeUnsupported(),
  };
}

function emptySkillChain(skillName: string): ObservationSkillChain {
  return {
    skillName,
    definition: { found: false },
    healthCheck: {
      source: 'doctor-static-rules',
      hardRules: { declared: false, valid: true, count: 0, rules: [], errors: [] },
      workflows: { declared: false, valid: true, branchCount: 0, nodeCount: 0, workflows: [], errors: [] },
    },
    runtime: runtimeUnsupported(),
  };
}

function runtimeUnsupported(): ObservationSkillChain['runtime'] {
  return {
    supported: false,
    message: '暂不支持运行时 hardRules / workflows 遵守判断；这里只展示静态输入来源和 observe 证据链。',
  };
}

function findSkillMdPath(skillName: string, cwd: string): string | undefined {
  if (!/^[A-Za-z0-9_.-]+$/.test(skillName)) return undefined;
  const candidates = [
    join(cwd, '.claude', 'skills', skillName, 'SKILL.md'),
    join(cwd, 'skills', skillName, 'SKILL.md'),
    join(homedir(), '.claude', 'skills', skillName, 'SKILL.md'),
    join(homedir(), '.codex', 'skills', skillName, 'SKILL.md'),
    join(homedir(), '.agents', 'skills', skillName, 'SKILL.md'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}
