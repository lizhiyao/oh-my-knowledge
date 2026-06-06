import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Args, Flags } from '@oclif/core';
import { LANG_FLAG, bilingual } from '../oclif/i18n.js';
import { BaseCommand } from '../oclif/base-command.js';
import { tCli } from '../lib/i18n.js';
import { resolveArtifacts } from '../../inputs/skill-loader.js';
import { hashString } from '../../eval-core/evaluation-reporting.js';
import { buildManagedArtifactRecord, managedDir, recordManagedArtifact } from '../../managed/index.js';
import type { ArtifactKind, ManagedDistributionTarget } from '../../types/index.js';

const BUILTIN_OMK_AGENT_SKILL_ID = 'omk-agent-skill';
const INSTALLABLE_KINDS: ArtifactKind[] = ['skill', 'prompt', 'agent', 'workflow'];

type AgentTarget = 'codex' | 'claude';

interface InstallTarget {
  label: string;
  skillsDir: string;
}

interface AgentTargetSpec {
  label: string;
  skillsDir: (home: string) => string;
  detectDirs: (home: string) => string[];
}

const TARGET_ORDER: AgentTarget[] = ['codex', 'claude'];

const TARGET_SPECS: Record<AgentTarget, AgentTargetSpec> = {
  codex: {
    label: 'Codex/AGENTS',
    skillsDir: (home) => join(home, '.agents', 'skills'),
    detectDirs: (home) => [join(home, '.agents'), join(home, '.codex')],
  },
  claude: {
    label: 'Claude Code',
    skillsDir: (home) => join(home, '.claude', 'skills'),
    detectDirs: (home) => [join(home, '.claude')],
  },
};

function packagedOmkAgentSkillDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', 'assets', 'agent-skills', 'omk');
}

function knownTarget(target: AgentTarget): InstallTarget {
  const home = homedir();
  const spec = TARGET_SPECS[target];
  return { label: spec.label, skillsDir: spec.skillsDir(home) };
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function parseTargets(raw: string, lang: 'zh' | 'en'): AgentTarget[] {
  const parts = [...new Set(raw.split(',').map((part) => part.trim()).filter(Boolean))];
  if (parts.length === 0) return autoTargets();
  if (parts.includes('auto')) {
    if (parts.length > 1) throw new Error(tCli('cli.install.invalid_target_combo', lang, { target: raw }));
    return autoTargets();
  }
  if (parts.includes('all')) {
    if (parts.length > 1) throw new Error(tCli('cli.install.invalid_target_combo', lang, { target: raw }));
    return TARGET_ORDER;
  }
  const out: AgentTarget[] = [];
  for (const part of parts) {
    if (part !== 'codex' && part !== 'claude') {
      throw new Error(tCli('cli.install.unknown_target', lang, { target: part }));
    }
    out.push(part);
  }
  return out;
}

function autoTargets(): AgentTarget[] {
  const home = homedir();
  return TARGET_ORDER.filter((target) => TARGET_SPECS[target].detectDirs(home).some(directoryExists));
}

function resolveInstallTargets(params: { to: string; dest?: string; lang: 'zh' | 'en' }): InstallTarget[] {
  if (params.dest) {
    return [{ label: 'custom', skillsDir: resolve(params.dest) }];
  }

  const targets = parseTargets(params.to, params.lang);
  if (targets.length === 0) {
    throw new Error(tCli('cli.install.no_detected_targets', params.lang));
  }
  const seen = new Set<string>();
  return targets
    .map(knownTarget)
    .filter((target) => {
      const key = resolve(target.skillsDir);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** 目标落点:目录-skill → {skillsDir}/{name};文件-skill → {skillsDir}/{name}.md。 */
function targetArtifactPath(target: InstallTarget, name: string, isDirectorySkill: boolean): string {
  return isDirectorySkill ? join(target.skillsDir, name) : join(target.skillsDir, `${name}.md`);
}

/** 内置 omk Agent Skill 固定落到 {skillsDir}/omk(目录-skill)。 */
function targetSkillDir(target: InstallTarget): string {
  return targetArtifactPath(target, 'omk', true);
}

/** 全部目标预检通过才拷任何一个(无部分安装)。 */
function validateInstallTargets(params: {
  targetPaths: string[];
  force: boolean;
  dryRun: boolean;
  lang: 'zh' | 'en';
}): void {
  if (params.dryRun || params.force) return;
  for (const targetPath of params.targetPaths) {
    if (existsSync(targetPath)) {
      throw new Error(tCli('cli.install.target_exists', params.lang, { path: targetPath }));
    }
  }
}

/** 通用拷贝:目录递归 cp、单文件 copyFile。不打印——由调用方决定文案。dry-run 不写。 */
function copyArtifactToTarget(params: {
  source: string;
  isDirectorySkill: boolean;
  targetPath: string;
  skillsDir: string;
  force: boolean;
  dryRun: boolean;
  lang: 'zh' | 'en';
}): { targetPath: string; planned: boolean } {
  if (!existsSync(params.source)) {
    throw new Error(tCli('cli.install.asset_missing', params.lang, { path: params.source }));
  }
  if (params.dryRun) {
    return { targetPath: params.targetPath, planned: true };
  }
  if (existsSync(params.targetPath) && !params.force) {
    throw new Error(tCli('cli.install.target_exists', params.lang, { path: params.targetPath }));
  }
  mkdirSync(params.skillsDir, { recursive: true });
  rmSync(params.targetPath, { recursive: true, force: true });
  if (params.isDirectorySkill) {
    cpSync(params.source, params.targetPath, { recursive: true });
  } else {
    copyFileSync(params.source, params.targetPath);
  }
  return { targetPath: params.targetPath, planned: false };
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
    skillsDir: params.target.skillsDir,
    force: params.force,
    dryRun: params.dryRun,
    lang: params.lang,
  });
  console.log(tCli(planned ? 'cli.install.plan' : 'cli.install.installed', params.lang, { path: targetDir }));
  return targetDir;
}

/** 裸短名(既非内置 id 又不像路径)多半是 typo 的内置 id,而非用户 artifact 路径。 */
function looksLikeArtifactPath(input: string): boolean {
  return input.includes('/') || /\.md$/i.test(input) || existsSync(resolve(input));
}

export default class Install extends BaseCommand {
  static description = bilingual({
    zh: '安装 omk 官方 Agent Skill,或登记并分发用户自己的 skill(内置 id omk-agent-skill,或 skill 路径 + --kind skill)。默认写入本机已检测 agent 目标;安装用户 skill 时同时登记一条受管记录。',
    en: 'Install the official omk Agent Skill, or register and distribute your own skill (built-in id omk-agent-skill, or a skill path + --kind skill). Defaults to detected local agent targets; installing a user skill also records a managed entry.',
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
        zh: '强制安装到当前 omk 已知的所有目标',
        en: 'Install into every target currently known to omk',
      }),
      command: '<%= config.bin %> install omk-agent-skill --to all',
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
        zh: '登记并分发用户自己的 skill(--kind 可省,命中 SKILL.md 自动推导)',
        en: 'Register and distribute your own skill (--kind optional; inferred from SKILL.md)',
      }),
      command: '<%= config.bin %> install ./skills/review',
    },
  ];

  static args = {
    input: Args.string({
      description: bilingual({
        zh: '要安装的知识输入:内置 id omk-agent-skill,或用户 skill 路径(目录或 .md)。',
        en: 'Knowledge input to install: built-in id omk-agent-skill, or a user skill path (directory or .md).',
      }),
      required: true,
    }),
  };

  static flags = {
    lang: LANG_FLAG,
    kind: Flags.string({
      description: bilingual({
        zh: '用户 artifact 的 kind(对齐 Artifact.kind)。可省:命中 SKILL.md 自动推导,当前仅支持 skill。',
        en: 'Kind of the user artifact (aligns with Artifact.kind). Optional: inferred from SKILL.md; only skill is supported today.',
      }),
      options: INSTALLABLE_KINDS,
    }),
    to: Flags.string({
      description: bilingual({
        zh: '安装目标：auto（默认，本机已检测目标） / codex / claude / all。',
        en: 'Install target: auto (default, detected local targets) / codex / claude / all.',
      }),
      default: 'auto',
    }),
    dest: Flags.string({
      description: bilingual({
        zh: '自定义 skill 根目录；omk 会安装到 <dir>/omk。',
        en: 'Custom skill root; installs into <dir>/omk.',
      }),
    }),
    force: Flags.boolean({
      description: bilingual({
        zh: '覆盖已存在的 omk Agent Skill。',
        en: 'Overwrite an existing omk Agent Skill.',
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
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Install);
    const lang = this.lang;

    await this.runWithCliExit(async () => {
      if (args.input === BUILTIN_OMK_AGENT_SKILL_ID) {
        this.installBuiltinAgentSkill(flags, lang);
        return;
      }
      if (looksLikeArtifactPath(args.input)) {
        this.installUserSkill(args.input, flags.kind, flags, lang);
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
    });
    for (const target of targets) {
      installOmkAgentSkill({ sourceDir, target, force: flags.force, dryRun: flags['dry-run'], lang });
    }
    if (!flags['dry-run']) console.log(tCli('cli.install.next_hint', lang));
  }

  private installUserSkill(input: string, kindFlag: string | undefined, flags: InstallFlags, lang: 'zh' | 'en'): void {
    // kind 推导:--kind 显式优先;否则命中 SKILL.md / Phase 1 缺省 skill。
    const kind: ArtifactKind = (kindFlag as ArtifactKind | undefined) ?? 'skill';
    if (kind !== 'skill') {
      throw new Error(tCli('cli.install.kind_unsupported', lang, { kind }));
    }

    const abs = resolve(input);
    // 绝对路径必含 `/`,走 resolveArtifacts 的 file-path 分支(目录→SKILL.md 设 skillRoot,裸 .md 不设)。
    const artifact = resolveArtifacts(dirname(abs), [abs])[0];
    const isDirectorySkill = Boolean(artifact.skillRoot);
    const source = isDirectorySkill ? artifact.skillRoot! : artifact.locator!;
    const contentHash = hashString(artifact.content ?? '');

    const targets = resolveInstallTargets({ to: flags.to, dest: flags.dest, lang });
    validateInstallTargets({
      targetPaths: targets.map((t) => targetArtifactPath(t, artifact.name, isDirectorySkill)),
      force: flags.force,
      dryRun: flags['dry-run'],
      lang,
    });

    const now = new Date().toISOString();
    const distribution: ManagedDistributionTarget[] = [];
    for (const target of targets) {
      const targetPath = targetArtifactPath(target, artifact.name, isDirectorySkill);
      const { planned } = copyArtifactToTarget({
        source,
        isDirectorySkill,
        targetPath,
        skillsDir: target.skillsDir,
        force: flags.force,
        dryRun: flags['dry-run'],
        lang,
      });
      if (planned) {
        console.log(tCli('cli.install.plan', lang, { path: targetPath }));
      } else {
        console.log(tCli('cli.install.copied', lang, { name: artifact.name, path: targetPath }));
        distribution.push({ label: target.label, path: targetPath, contentHash, copiedAt: now });
      }
    }

    if (flags['dry-run']) return;

    const record = buildManagedArtifactRecord({
      name: artifact.name,
      kind,
      source: {
        locator: artifact.locator!,
        ...(artifact.ref ? { ref: artifact.ref } : {}),
        isDirectorySkill,
      },
      contentHash,
      installedAt: now,
      distribution,
    });
    const dir = managedDir();
    recordManagedArtifact(record, { dir });
    console.log(tCli('cli.install.registered', lang, { id: record.id, store: dir }));
  }
}

// --kind 单独传入 installUserSkill,故此处不含 kind 字段(裸 kind 留给 ArtifactKind)。
type InstallFlags = {
  to: string;
  dest?: string;
  force: boolean;
  'dry-run': boolean;
};
