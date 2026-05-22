import { resolve, join, basename, dirname } from 'node:path';
import { existsSync, statSync } from 'node:fs';

export interface ResolvedSkillInput {
  skillPath: string;
  skillDir: string;
  samplesPath: string;
}

export function resolveSkillInput(input: string): ResolvedSkillInput {
  const resolved = resolve(input);
  if (!existsSync(resolved)) throw new Error(`路径不存在: ${resolved}`);

  let skillPath: string;
  let skillDir: string;

  if (statSync(resolved).isDirectory()) {
    const skillMd = join(resolved, 'SKILL.md');
    if (!existsSync(skillMd)) throw new Error(`目录下未找到 SKILL.md: ${resolved}`);
    skillPath = skillMd;
    skillDir = resolved;
  } else {
    skillPath = resolved;
    skillDir = basename(resolved) === 'SKILL.md' ? dirname(resolved) : dirname(resolved);
  }

  const candidates = [
    join(skillDir, '.omk', 'samples.json'),
    join(skillDir, 'eval-samples.json'),
    join(skillDir, 'eval-samples.yaml'),
    join(skillDir, 'eval-samples.yml'),
  ];
  const samplesPath = candidates.find(existsSync) ?? candidates[0];

  return { skillPath, skillDir, samplesPath };
}
