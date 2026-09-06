import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findSkillSamplesPath } from './sample-locator.js';

export function discoverBatchSkills(skillDir: string): Array<{ name: string; skillPath: string; samplesPath: string }> {
  if (!existsSync(skillDir)) return [];

  const entries = readdirSync(skillDir);
  const skills: Array<{ name: string; skillPath: string; samplesPath: string }> = [];

  for (const entry of entries) {
    const entryPath = join(skillDir, entry);
    if (entry.endsWith('.md')) {
      continue;
    }

    if (statSync(entryPath).isDirectory()) {
      const skillMd = join(entryPath, 'SKILL.md');
      if (!existsSync(skillMd)) continue;
      if (existsSync(join(skillDir, `${entry}.md`))) continue;
      const samplesPath = findSkillSamplesPath(entryPath);
      if (samplesPath) {
        skills.push({ name: entry, skillPath: skillMd, samplesPath });
      }
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}
