import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, relative, resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Args, Flags } from '@oclif/core';
import { LANG_FLAG, bilingual } from '../oclif/i18n.js';
import { BaseCommand } from '../oclif/base-command.js';
import { tCli } from '../lib/i18n.js';
import { resolveInstallSource, SourceResolveError } from '../../inputs/source-resolver.js';
import { buildManagedArtifactRecord, hashArtifactSource, isDistributablePath, managedDir, recordManagedArtifact } from '../../managed/index.js';
import type { ArtifactKind, ManagedDistributionTarget } from '../../types/index.js';
import type { InstallMessageKey } from '../lib/i18n-dict/install.js';

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

/** 全部目标预检通过才拷任何一个(无部分安装)。源就是目标(就地接管)的目标跳过存在性检查。 */
function validateInstallTargets(params: {
  targetPaths: string[];
  force: boolean;
  dryRun: boolean;
  lang: 'zh' | 'en';
  source?: string;
}): void {
  if (params.dryRun || params.force) return;
  for (const targetPath of params.targetPaths) {
    if (params.source && classifyPaths(params.source, targetPath) === 'same') continue;
    if (existsSync(targetPath)) {
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
 *   - same:同一节点 → 就地接管(绝不删/拷);
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
 * 不打印——由调用方决定文案。dry-run 不写。源即目标 → 就地接管(inPlace);源与目标互为祖先 → 拒绝(防自毁)。
 */
function copyArtifactToTarget(params: {
  source: string;
  isDirectorySkill: boolean;
  targetPath: string;
  skillsDir: string;
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
  // 就地接管:源就是目标(接管已安装的 skill),绝不 rmSync 源。
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
  mkdirSync(params.skillsDir, { recursive: true });
  rmSync(params.targetPath, { recursive: true, force: true });
  if (params.isDirectorySkill) {
    cpSync(params.source, params.targetPath, {
      recursive: true,
      // 与 hashArtifactSource 共用过滤,保证"分发出去的 == 算进 hash 的":
      // 源根永远拷;软链跳过(与 hash walk 一致,避免软链目标改了却不触发 drift);
      // evolve 只在源根第一层排除(嵌套 references/evolve 正常分发),.omk/.git 任意层级排除。
      filter: (src) => {
        const rel = relative(params.source, src);
        if (rel === '') return true;
        if (lstatSync(src).isSymbolicLink()) return false;
        return isDistributablePath(rel.split(sep));
      },
    });
  } else {
    copyFileSync(params.source, params.targetPath);
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
    skillsDir: params.target.skillsDir,
    force: params.force,
    dryRun: params.dryRun,
    lang: params.lang,
  });
  console.log(tCli(planned ? 'cli.install.plan' : 'cli.install.installed', params.lang, { path: targetDir }));
  return targetDir;
}

/**
 * 是否当作用户 artifact 路径(否则按 typo 的内置 id 处理,报 unknown_input)。
 *   - 显式路径意图(含 `/`)或 `.md` 结尾 → 是(后续 installManagedSkill 经 resolver 给出精确的存在性 / SKILL.md 报错);
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
    zh: '安装 omk 官方 Agent Skill，或登记并分发用户自己的 skill（内置 id omk-agent-skill，本地路径，或 git:<ref>:<name> 取当前仓库某个 ref 的 skill）。默认写入本机已检测 agent 目标；安装用户 skill 时同时登记一条受管记录。',
    en: 'Install the official omk Agent Skill, or register and distribute your own skill (built-in id omk-agent-skill, a local path, or git:<ref>:<name> for a skill at a ref of the current repo). Defaults to detected local agent targets; installing a user skill also records a managed entry.',
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
    {
      description: bilingual({
        zh: '从当前仓库某个 ref 安装 skill（可复现；SHA 不可变、分支会随 ref 漂移）',
        en: 'Install a skill from a ref of the current repo (reproducible; a SHA is immutable, a branch drifts with the ref)',
      }),
      command: '<%= config.bin %> install git:main:skills/review',
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
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Install);
    const lang = this.lang;

    await this.runWithCliExit(async () => {
      if (args.input === BUILTIN_OMK_AGENT_SKILL_ID) {
        this.installBuiltinAgentSkill(flags, lang);
        return;
      }
      if (args.input.startsWith('git:') || looksLikeArtifactPath(args.input)) {
        this.installManagedSkill(args.input, flags.kind, flags, lang);
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

  private installManagedSkill(input: string, kindFlag: string | undefined, flags: InstallFlags, lang: 'zh' | 'en'): void {
    // kind 推导:--kind 显式优先;否则缺省 skill(Phase 1 仅 skill)。
    const kind: ArtifactKind = (kindFlag as ArtifactKind | undefined) ?? 'skill';
    if (kind !== 'skill') {
      throw new Error(tCli('cli.install.kind_unsupported', lang, { kind }));
    }

    // 源解析委托给 source-resolver(file / git ...),install 主干源无关。
    // resolver 不依赖 CLI,错误以 SourceResolveError(messageKey) 抛出,这里映射成本地化文案。
    let src;
    try {
      src = resolveInstallSource(input);
    } catch (err) {
      if (err instanceof SourceResolveError) {
        throw new Error(tCli(err.messageKey as InstallMessageKey, lang, err.params));
      }
      throw err;
    }

    try {
      const { localRoot, name, isDirectorySkill, sourceKind, locator, ref } = src;
      // 目录-skill 哈整棵可分发树(排除 .omk/.git/evolve);git 源哈的是物化后的临时树。
      const contentHash = hashArtifactSource(localRoot, isDirectorySkill);

      const targets = resolveInstallTargets({ to: flags.to, dest: flags.dest, lang });
      validateInstallTargets({
        targetPaths: targets.map((t) => targetArtifactPath(t, name, isDirectorySkill)),
        force: flags.force,
        dryRun: flags['dry-run'],
        lang,
        source: localRoot,
      });

      const now = new Date().toISOString();
      const distribution: ManagedDistributionTarget[] = [];
      const dir = managedDir();
      // 即便多目标中途失败,也把已成功分发的落点登记进记录,保持"磁盘 == 记录"一致;
      // 重跑 --force 时 upsert 会按 path 去重并补齐其余目标。
      const writeRecordIfAny = (): void => {
        if (flags['dry-run'] || distribution.length === 0) return;
        const record = buildManagedArtifactRecord({
          name,
          kind,
          source: { sourceKind, locator, ...(ref ? { ref } : {}), isDirectorySkill },
          contentHash,
          installedAt: now,
          distribution,
        });
        recordManagedArtifact(record, { dir });
        console.log(tCli('cli.install.registered', lang, { id: record.id, store: dir }));
      };

      try {
        for (const target of targets) {
          const targetPath = targetArtifactPath(target, name, isDirectorySkill);
          const { planned, inPlace } = copyArtifactToTarget({
            source: localRoot,
            isDirectorySkill,
            targetPath,
            skillsDir: target.skillsDir,
            force: flags.force,
            dryRun: flags['dry-run'],
            lang,
          });
          if (planned) {
            console.log(tCli('cli.install.plan_skill', lang, { name, path: targetPath }));
          } else {
            console.log(tCli(inPlace ? 'cli.install.adopted' : 'cli.install.copied', lang, { name, path: targetPath }));
            distribution.push({ label: target.label, path: targetPath, contentHash, copiedAt: now });
          }
        }
      } finally {
        writeRecordIfAny();
      }
    } finally {
      src.cleanup(); // git 删临时物化目录;file noop
    }
  }
}

// --kind 单独传入 installManagedSkill,故此处不含 kind 字段(裸 kind 留给 ArtifactKind)。
type InstallFlags = {
  to: string;
  dest?: string;
  force: boolean;
  'dry-run': boolean;
};
