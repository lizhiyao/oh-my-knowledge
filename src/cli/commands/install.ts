import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Args, Flags, Errors } from '@oclif/core';
import { LANG_FLAG, bilingual } from '../oclif/i18n.js';
import { BaseCommand } from '../oclif/base-command.js';
import { tCli } from '../lib/i18n.js';
import { resolveInstallSource, resolveRemoteGitSource, usingInstallSource, SourceResolveError } from '../../knowledge/artifacts/sources/install-source.js';
import type { InstallMessageKey } from '../lib/i18n-dict/install.js';

import { replaceDeployedArtifact } from '../../knowledge/artifacts/sources/deploy-artifact.js';

const BUILTIN_OMK_AGENT_SKILL_ID = 'omk-agent-skill';

interface InstallTarget {
  label: string;
  skillsDir: string;
}

function packagedOmkAgentSkillDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const packaged = resolve(here, '..', '..', 'assets', 'agent-skills', 'omk');
  if (existsSync(packaged)) return packaged;
  const workspace = resolve(here, '..', '..', '..', '.agents', 'skills', 'omk');
  return existsSync(workspace) ? workspace : packaged;
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function resolveInstallTargets(params: { to: string; dest?: string; lang: 'zh' | 'en' }): InstallTarget[] {
  if (params.dest) {
    return [{ label: 'custom', skillsDir: resolve(params.dest) }];
  }

  const home = homedir();
  if (params.to === 'auto' && ![join(home, '.agents'), join(home, '.codex')].some(directoryExists)) {
    throw new Error(tCli('cli.install.no_detected_targets', params.lang));
  }
  return [{ label: 'Codex/AGENTS', skillsDir: join(home, '.agents', 'skills') }];
}

/** 目标落点:目录-skill → {skillsDir}/{name};文件-skill → {skillsDir}/{name}.md。 */
function targetArtifactPath(target: InstallTarget, name: string, isDirectorySkill: boolean): string {
  return isDirectorySkill ? join(target.skillsDir, name) : join(target.skillsDir, `${name}.md`);
}

/** 内置 omk Agent Skill 固定落到 {skillsDir}/omk(目录-skill)。 */
function targetSkillDir(target: InstallTarget): string {
  return targetArtifactPath(target, 'omk', true);
}

/** 全部目标预检通过才拷任何一个(无部分安装)。源就是目标(已在目标位置)的目标跳过存在性检查。 */
function validateInstallTargets(params: {
  targetPaths: string[];
  force: boolean;
  dryRun: boolean;
  lang: 'zh' | 'en';
  source?: string;
}): void {
  if (params.dryRun) return;
  for (const targetPath of params.targetPaths) {
    if (params.source) {
      const relation = classifyPaths(params.source, targetPath);
      if (relation === 'same') continue;
      if (relation === 'overlap') {
        throw new Error(tCli('cli.install.target_overlaps_source', params.lang, { source: params.source, target: targetPath }));
      }
    }
    if (!params.force && existsSync(targetPath)) {
      throw new Error(tCli('cli.install.target_exists', params.lang, { path: targetPath }));
    }
  }
}

/** 解析路径的物理形态:对存在的最长前缀做 realpath、余下保持字面,使尚不存在的目标也能比较。 */
function realPathBestEffort(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  while (!existsSync(cur)) {
    tail.unshift(basename(cur));
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  const base = existsSync(cur) ? realpathSync(cur) : cur;
  return tail.length ? join(base, ...tail) : base;
}

type PathRelation = 'same' | 'overlap' | 'disjoint';
/**
 * 源与目标的物理关系(解析软链):
 *   - same:同一节点 → 已在目标位置(绝不删/拷);
 *   - overlap:一个是另一个的祖先 → rmSync(target) 会删掉源、或 cpSync 把目录拷进自身子目录,数据损坏,必须拒;
 *   - disjoint:正常拷贝。
 */
function classifyPaths(source: string, targetPath: string): PathRelation {
  const rs = realPathBestEffort(source);
  const rt = realPathBestEffort(targetPath);
  if (rs === rt) return 'same';
  if (rs.startsWith(rt + sep) || rt.startsWith(rs + sep)) return 'overlap';
  return 'disjoint';
}

/**
 * 通用拷贝:目录递归 cp(过滤 .omk / .git / evolve 等非分发产物 + 软链)、单文件 copyFile。
 * 清理失败单独提示，正常结果由调用方呈现。dry-run 不写。源即目标 → 已在目标位置(inPlace);重叠路径拒绝。
 */
function copyArtifactToTarget(params: {
  source: string;
  isDirectorySkill: boolean;
  targetPath: string;
  force: boolean;
  dryRun: boolean;
  lang: 'zh' | 'en';
}): { targetPath: string; planned: boolean; inPlace: boolean } {
  if (!existsSync(params.source)) {
    throw new Error(tCli('cli.install.asset_missing', params.lang, { path: params.source }));
  }
  if (params.dryRun) {
    return { targetPath: params.targetPath, planned: true, inPlace: false };
  }
  const relation = classifyPaths(params.source, params.targetPath);
  // 已在目标位置:源就是目标(接管已安装的 skill),绝不 rmSync 源。
  if (relation === 'same') {
    return { targetPath: params.targetPath, planned: false, inPlace: true };
  }
  // 互为祖先:删除目标会删掉源、或自拷进子目录 —— 数据损坏,直接拒,哪怕带 --force。
  if (relation === 'overlap') {
    throw new Error(tCli('cli.install.target_overlaps_source', params.lang, { source: params.source, target: params.targetPath }));
  }
  if (existsSync(params.targetPath) && !params.force) {
    throw new Error(tCli('cli.install.target_exists', params.lang, { path: params.targetPath }));
  }
  const deployment = replaceDeployedArtifact(params.source, params.targetPath, params.isDirectorySkill, params.force);
  if (deployment.cleanupWarning) {
    process.stderr.write(params.lang === 'zh'
      ? `安装已完成，临时目录清理失败，请手动清理：${deployment.cleanupWarning}\n`
      : `Installation completed; remove the leftover staging directory: ${deployment.cleanupWarning}\n`);
  }
  return { targetPath: params.targetPath, planned: false, inPlace: false };
}

function installOmkAgentSkill(params: {
  sourceDir: string;
  target: InstallTarget;
  force: boolean;
  dryRun: boolean;
  lang: 'zh' | 'en';
}): string {
  const targetDir = targetSkillDir(params.target);
  const { planned } = copyArtifactToTarget({
    source: params.sourceDir,
    isDirectorySkill: true,
    targetPath: targetDir,
    force: params.force,
    dryRun: params.dryRun,
    lang: params.lang,
  });
  console.log(tCli(planned ? 'cli.install.plan' : 'cli.install.installed', params.lang, { path: targetDir }));
  return targetDir;
}

/**
 * 是否当作用户 artifact 路径(否则按 typo 的内置 id 处理,报 unknown_input)。
 *   - 显式路径意图(含 `/`)或 `.md` 结尾 → 是(后续 installUserSkill 经 resolver 给出精确的存在性 / SKILL.md 报错);
 *   - 裸短名 → 仅当它确实解析到一个含 SKILL.md 的目录才算;裸的同名普通文件(如 cwd 里恰好有个
 *     `omk-agnt-skill` 文件)不该被当成 skill 安装,落回 unknown_input。
 */
function looksLikeArtifactPath(input: string): boolean {
  if (input.includes('/') || /\.md$/i.test(input)) return true;
  try {
    const abs = resolve(input);
    return statSync(abs).isDirectory() && existsSync(join(abs, 'SKILL.md'));
  } catch {
    return false;
  }
}

export default class Install extends BaseCommand {
  static description = bilingual({
    zh: '安装 omk 官方 Agent Skill，或安装用户自己的 skill（内置 id omk-agent-skill，本地路径，或 git:<ref>:<name> 取当前仓库某个 ref 的 skill）。默认写入本机已检测 agent 目标。',
    en: 'Install the official omk Agent Skill, or install your own skill (built-in id omk-agent-skill, a local path, or git:<ref>:<name> for a skill at a ref of the current repo). Defaults to detected local agent targets.',
  });

  static examples = [
    {
      description: bilingual({
        zh: '安装 omk 官方 Agent Skill 到默认本机目标',
        en: 'Install the official omk Agent Skill into default local targets',
      }),
      command: '<%= config.bin %> install omk-agent-skill',
    },
    {
      description: bilingual({
        zh: '直接安装到 Codex/AGENTS，无需提前检测到目录',
        en: 'Install to Codex/AGENTS even when its directories are not detected',
      }),
      command: '<%= config.bin %> install omk-agent-skill --to codex',
    },
    {
      description: bilingual({
        zh: '安装到自定义 skill 根目录',
        en: 'Install into a custom skill root',
      }),
      command: '<%= config.bin %> install omk-agent-skill --dest ~/.my-agent/skills',
    },
    {
      description: bilingual({
        zh: '安装用户自己的 skill（可省略 --kind skill）',
        en: 'Install your own skill (--kind skill is optional)',
      }),
      command: '<%= config.bin %> install ./skills/review',
    },
    {
      description: bilingual({
        zh: '从当前仓库某个 ref 安装 skill（可复现；SHA 不可变、分支会随 ref 漂移）',
        en: 'Install a skill from a ref of the current repo (reproducible; a SHA is immutable, a branch drifts with the ref)',
      }),
      command: '<%= config.bin %> install git:main:skills/review',
    },
    {
      description: bilingual({
        zh: '从远端 git 仓库安装 skill（位置参数是仓库内路径；认证用本机 git 凭证）',
        en: 'Install a skill from a remote git repo (positional arg is the in-repo path; auth via local git credentials)',
      }),
      command: '<%= config.bin %> install --git-url https://github.com/org/repo.git --git-ref v1.0.0 skills/review',
    },
  ];

  static args = {
    input: Args.string({
      description: bilingual({
        zh: '要安装的知识输入：内置 id omk-agent-skill，本地 skill 路径（目录或 .md），或 git:<ref>:<name>（当前仓库某 ref 的 skill）。',
        en: 'Knowledge input to install: built-in id omk-agent-skill, a local skill path (directory or .md), or git:<ref>:<name> (a skill at a ref of the current repo).',
      }),
      required: true,
    }),
  };

  static flags = {
    lang: LANG_FLAG,
    kind: Flags.string({
      description: bilingual({
        zh: '安装的 Artifact.kind，可省略；仅支持 skill。',
        en: 'Artifact.kind to install. Optional; only skill is supported.',
      }),
      options: ['skill'],
    }),
    to: Flags.string({
      description: bilingual({
        zh: '安装目标：auto（默认，检测 Codex/AGENTS）或 codex（直接安装）。',
        en: 'Install target: auto (default, detect Codex/AGENTS) or codex (install directly).',
      }),
      options: ['auto', 'codex'],
      default: 'auto',
    }),
    dest: Flags.string({
      description: bilingual({
        zh: '自定义 skill 根目录；skill 安装到 <dir>/<name>（内置 omk-agent-skill 为 <dir>/omk）。',
        en: 'Custom skill root; a skill installs into <dir>/<name> (the built-in omk-agent-skill into <dir>/omk).',
      }),
    }),
    force: Flags.boolean({
      description: bilingual({
        zh: '覆盖目标位置已存在的 skill。',
        en: 'Overwrite an existing skill at the target location.',
      }),
      default: false,
    }),
    'dry-run': Flags.boolean({
      description: bilingual({
        zh: '只打印安装目标，不写文件。',
        en: 'Print install targets without writing files.',
      }),
      default: false,
    }),
    'git-url': Flags.string({
      description: bilingual({
        zh: '远端 git 仓库 URL（https / ssh / git@host:path）。给了它时，位置参数当作仓库内 skill 路径（spec）。',
        en: 'Remote git repository URL (https / ssh / git@host:path). When set, the positional arg is the in-repo skill path (spec).',
      }),
    }),
    'git-ref': Flags.string({
      description: bilingual({
        zh: '远端 git 的 ref（分支 / tag / SHA），默认 HEAD。仅配合 --git-url 使用。',
        en: 'Remote git ref (branch / tag / SHA), default HEAD. Only with --git-url.',
      }),
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Install);
    const lang = this.lang;

    await this.runWithCliExit(async () => {
      // --git-ref 必须配 --git-url(否则静默丢弃、误把 spec 当本地路径解析,报错令人困惑)。
      if (flags['git-ref'] && !flags['git-url']) {
        throw new Errors.CLIError(tCli('cli.install.git_ref_needs_url', lang), { exit: 2 });
      }
      // 远端 git:--git-url 在场时,位置参数是仓库内 spec(repo 相对路径),先于其它分支判定。
      if (flags['git-url']) {
        this.installUserSkill(args.input, flags, lang, {
          url: flags['git-url'],
          ref: flags['git-ref'] || 'HEAD',
        });
        return;
      }
      if (args.input === BUILTIN_OMK_AGENT_SKILL_ID) {
        this.installBuiltinAgentSkill(flags, lang);
        return;
      }
      if (args.input.startsWith('git:') || looksLikeArtifactPath(args.input)) {
        this.installUserSkill(args.input, flags, lang);
        return;
      }
      throw new Error(tCli('cli.install.unknown_input', lang, { input: args.input }));
    });
  }

  private installBuiltinAgentSkill(flags: InstallFlags, lang: 'zh' | 'en'): void {
    const sourceDir = packagedOmkAgentSkillDir();
    const targets = resolveInstallTargets({ to: flags.to, dest: flags.dest, lang });
    validateInstallTargets({
      targetPaths: targets.map(targetSkillDir),
      force: flags.force,
      dryRun: flags['dry-run'],
      lang,
      source: sourceDir,
    });
    for (const target of targets) {
      installOmkAgentSkill({ sourceDir, target, force: flags.force, dryRun: flags['dry-run'], lang });
    }
    if (!flags['dry-run']) console.log(tCli('cli.install.next_hint', lang));
  }

  private installUserSkill(
    input: string,
    flags: InstallFlags,
    lang: 'zh' | 'en',
    remote?: { url: string; ref: string },
  ): void {
    // 源解析委托给 source-resolver(file / 本地 git / 远端 git),install 主干源无关。
    // 远端走结构化 resolveRemoteGitSource(url/ref/spec 分字段,URL 不经任何字符串切分);
    // resolver 不依赖 CLI,错误以 SourceResolveError(messageKey) 抛出,这里映射成本地化文案。
    let src;
    try {
      src = remote ? resolveRemoteGitSource(remote.url, remote.ref, input) : resolveInstallSource(input);
    } catch (err) {
      if (err instanceof SourceResolveError) {
        throw new Error(tCli(err.messageKey as InstallMessageKey, lang, err.params));
      }
      throw err;
    }

    usingInstallSource(src, () => {
      const { localRoot, name, isDirectorySkill } = src;

      const targets = resolveInstallTargets({ to: flags.to, dest: flags.dest, lang });
      validateInstallTargets({
        targetPaths: targets.map((t) => targetArtifactPath(t, name, isDirectorySkill)),
        force: flags.force,
        dryRun: flags['dry-run'],
        lang,
        source: localRoot,
      });

      for (const target of targets) {
        const targetPath = targetArtifactPath(target, name, isDirectorySkill);
        const { planned, inPlace } = copyArtifactToTarget({
          source: localRoot,
          isDirectorySkill,
          targetPath,
          force: flags.force,
          dryRun: flags['dry-run'],
          lang,
        });
        const key = planned ? 'cli.install.plan_skill' : inPlace ? 'cli.install.adopted' : 'cli.install.copied';
        console.log(tCli(key, lang, { name, path: targetPath }));
      }
    });
  }
}

// --kind 单独传入 installUserSkill,故此处不含 kind 字段(裸 kind 留给 ArtifactKind)。
type InstallFlags = Pick<import('@oclif/core').Interfaces.InferredFlags<typeof Install.flags>, 'to' | 'dest' | 'force' | 'dry-run'>;
