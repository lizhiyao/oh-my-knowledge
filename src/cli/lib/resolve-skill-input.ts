import { resolve, join, dirname, basename } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { tCli, type CliLang } from './i18n.js';

export interface ResolvedSkillInput {
  skillPath: string;
  skillDir: string;
  samplesPath: string;
  /**
   * 目标是否为目录-skill。**只看解析后形态、不看入参写法**：传目录 `skills/foo` 或传内部
   * `skills/foo/SKILL.md` 都判 true(两者 skillPath 都落到 `.../SKILL.md`),扁平 `bar.md` 判 false。
   * 受管联动按此对齐 install 落的记录形态(`source.isDirectorySkill`),避免「传 SKILL.md 文件路径就匹配不到目录记录」。
   */
  isDirectorySkill: boolean;
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

  // 形态以解析后的 skillPath 命名为准:目录-skill 的 skillPath 总是 `.../SKILL.md`。
  const isDirectorySkill = basename(skillPath) === 'SKILL.md';

  return { skillPath, skillDir, samplesPath, isDirectorySkill };
}
