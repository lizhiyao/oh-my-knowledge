import { resolve, join, dirname, basename } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { tCli, type CliLang } from './i18n.js';
import {
  defaultSkillLocalSamplesFile,
  findProjectSamplesFile,
  findSkillSamplesPath,
} from '../../inputs/sample-locator.js';
import { withLocalizedSampleDiscovery } from './localized-sample-discovery.js';

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
// 目录(skills/foo/ 自动找 foo/SKILL.md)。目录-skill 以
// `<skill>/.omk/eval-samples.{json,yaml}` 为标准 samples 命名空间；扁平 .md 回到项目级
// `eval-samples.json`。
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

  // 形态以解析后的 skillPath 命名为准:目录-skill 的 skillPath 总是 `.../SKILL.md`。
  const isDirectorySkill = basename(skillPath) === 'SKILL.md';
  const samplesPath = withLocalizedSampleDiscovery(() => (isDirectorySkill
    ? findSkillSamplesPath(skillDir) ?? defaultSkillLocalSamplesFile(skillDir)
    : findProjectSamplesFile(process.cwd())
      ?? 'eval-samples.json'), lang);

  return { skillPath, skillDir, samplesPath, isDirectorySkill };
}
