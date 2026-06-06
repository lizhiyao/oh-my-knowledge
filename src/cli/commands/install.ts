import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Args, Flags } from '@oclif/core';
import { LANG_FLAG, bilingual } from '../oclif/i18n.js';
import { BaseCommand } from '../oclif/base-command.js';
import { tCli } from '../lib/i18n.js';

const BUILTIN_OMK_AGENT_SKILL_ID = 'omk-agent-skill';

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

function targetSkillDir(target: InstallTarget): string {
  return join(target.skillsDir, 'omk');
}

function validateInstallTargets(params: {
  targets: InstallTarget[];
  force: boolean;
  dryRun: boolean;
  lang: 'zh' | 'en';
}): void {
  if (params.dryRun || params.force) return;

  for (const target of params.targets) {
    const targetDir = targetSkillDir(target);
    if (existsSync(targetDir)) {
      throw new Error(tCli('cli.install.target_exists', params.lang, { path: targetDir }));
    }
  }
}

function installOmkAgentSkill(params: {
  sourceDir: string;
  target: InstallTarget;
  force: boolean;
  dryRun: boolean;
  lang: 'zh' | 'en';
}): string {
  if (!existsSync(params.sourceDir)) {
    throw new Error(tCli('cli.install.asset_missing', params.lang, { path: params.sourceDir }));
  }

  const targetDir = targetSkillDir(params.target);
  if (params.dryRun) {
    console.log(tCli('cli.install.plan', params.lang, { path: targetDir }));
    return targetDir;
  }

  if (existsSync(targetDir) && !params.force) {
    throw new Error(tCli('cli.install.target_exists', params.lang, { path: targetDir }));
  }

  mkdirSync(params.target.skillsDir, { recursive: true });
  rmSync(targetDir, { recursive: true, force: true });
  cpSync(params.sourceDir, targetDir, { recursive: true });
  console.log(tCli('cli.install.installed', params.lang, { path: targetDir }));
  return targetDir;
}

export default class Install extends BaseCommand {
  static description = bilingual({
    zh: '安装 omk 官方 Agent Skill（当前仅支持内置 id：omk-agent-skill，默认写入本机已检测 agent 目标）。',
    en: 'Install the official omk Agent Skill (currently supports only built-in id: omk-agent-skill, defaulting to detected local agent targets).',
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
  ];

  static args = {
    input: Args.string({
      description: bilingual({
        zh: '要安装的知识输入。当前支持内置 id：omk-agent-skill。',
        en: 'Knowledge input to install. Currently supports built-in id: omk-agent-skill.',
      }),
      required: true,
    }),
  };

  static flags = {
    lang: LANG_FLAG,
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
      if (args.input !== BUILTIN_OMK_AGENT_SKILL_ID) {
        throw new Error(tCli('cli.install.unknown_input', lang, { input: args.input }));
      }

      const sourceDir = packagedOmkAgentSkillDir();
      const targets = resolveInstallTargets({ to: flags.to, dest: flags.dest, lang });
      validateInstallTargets({
        targets,
        force: flags.force,
        dryRun: flags['dry-run'],
        lang,
      });
      for (const target of targets) {
        installOmkAgentSkill({
          sourceDir,
          target,
          force: flags.force,
          dryRun: flags['dry-run'],
          lang,
        });
      }
      if (!flags['dry-run']) console.log(tCli('cli.install.next_hint', lang));
    });
  }
}
