import { resolve, join, dirname } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { tCli, type CliLang } from './i18n.js';

export interface ResolvedSkillInput {
  skillPath: string;
  skillDir: string;
  samplesPath: string;
}

// 统一 skill 入参解析:既接受 SKILL.md 文件(老式 + flat skill),也接受 directory-skill
// 目录(skills/foo/ 自动找 foo/SKILL.md)。samples 发现优先级:.omk/ 目录(loadSamples
// 支持目录模式，自动 glob 多文件) > eval-samples.json > .yaml > .yml,fallback 是
// .omk/ 目录路径(给上游 "samples 不存在" 的提示一个稳定路径)。
//
// 错误用 tCli 走 i18n,调用方直接 console.error err.message 给用户看,zh/en 都要正确。
export function resolveSkillInput(input: string, lang: CliLang): ResolvedSkillInput {
  const resolved = resolve(input);
  if (!existsSync(resolved)) {
    throw new Error(tCli('cli.common.skill_file_not_found', lang, { path: resolved }));
  }

  let skillPath: string;
  let skillDir: string;

  if (statSync(resolved).isDirectory()) {
    const skillMd = join(resolved, 'SKILL.md');
    if (!existsSync(skillMd)) {
      throw new Error(tCli('cli.common.skill_dir_no_skill_md', lang, { path: resolved }));
    }
    skillPath = skillMd;
    skillDir = resolved;
  } else {
    skillPath = resolved;
    skillDir = dirname(resolved);
  }

  const omkDir = join(skillDir, '.omk');
  const candidates = [
    ...(existsSync(omkDir) ? [omkDir] : []),
    join(skillDir, 'eval-samples.json'),
    join(skillDir, 'eval-samples.yaml'),
    join(skillDir, 'eval-samples.yml'),
  ];
  // fallback 到 .omk/ 目录：上游会报 "no sample files found in directory" 引导用户创建
  const samplesPath = candidates.find(existsSync) ?? omkDir;

  return { skillPath, skillDir, samplesPath };
}
