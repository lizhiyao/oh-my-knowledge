import type { CliMessage } from './types.js';

export type InstallMessageKey =
  | 'cli.install.asset_missing'
  | 'cli.install.unknown_input'
  | 'cli.install.unknown_target'
  | 'cli.install.invalid_target_combo'
  | 'cli.install.no_detected_targets'
  | 'cli.install.target_exists'
  | 'cli.install.plan'
  | 'cli.install.installed'
  | 'cli.install.kind_unsupported'
  | 'cli.install.copied'
  | 'cli.install.adopted'
  | 'cli.install.registered'
  | 'cli.install.target_overlaps_source'
  | 'cli.install.path_not_found'
  | 'cli.install.skillmd_missing'
  | 'cli.install.skillmd_is_symlink'
  | 'cli.install.not_a_skill'
  | 'cli.install.not_a_git_repo'
  | 'cli.install.git_skill_not_found'
  | 'cli.install.next_hint';

export const installDict: Record<InstallMessageKey, CliMessage> = {
  'cli.install.asset_missing': {
    zh: '未找到打包内置资源：{path}。请先运行 yarn build，或确认 npm 包包含 dist/assets/agent-skills/omk。',
    en: 'Packaged built-in asset not found: {path}. Run yarn build first, or verify the npm package includes dist/assets/agent-skills/omk.',
  },
  'cli.install.unknown_input': {
    zh: 'install 接受内置 id omk-agent-skill,或一个 skill 路径（如 ./skills/review、./review.md）。无法识别的输入：{input}',
    en: 'install accepts the built-in id omk-agent-skill, or a skill path (e.g. ./skills/review or ./review.md). Unrecognized input: {input}',
  },
  'cli.install.unknown_target': {
    zh: '未知安装目标：{target}。可用值：auto, codex, claude, all；或用 --dest <dir> 指定 skill 根目录。',
    en: 'Unknown install target: {target}. Use auto, codex, claude, all; or pass --dest <dir> for a custom skill root.',
  },
  'cli.install.invalid_target_combo': {
    zh: '安装目标组合不合法：{target}。auto 和 all 必须单独使用；如需多个明确目标，请写 codex,claude。',
    en: 'Invalid install target combination: {target}. auto and all must be used alone; use codex,claude for multiple explicit targets.',
  },
  'cli.install.no_detected_targets': {
    zh: '未检测到本机支持的 agent skill 目录。请用 --to codex / --to claude / --to all 明确目标，或用 --dest <dir> 指定 skill 根目录。',
    en: 'No supported local agent skill directory was detected. Pass --to codex / --to claude / --to all, or pass --dest <dir> for a custom skill root.',
  },
  'cli.install.target_exists': {
    zh: '目标已存在：{path}。如要更新 omk Agent Skill，请加 --force。',
    en: 'Target already exists: {path}. Pass --force to update the omk Agent Skill.',
  },
  'cli.install.plan': {
    zh: '将安装 omk Agent Skill 到：{path}',
    en: 'Will install the omk Agent Skill to: {path}',
  },
  'cli.install.installed': {
    zh: '已安装 omk Agent Skill：{path}',
    en: 'Installed omk Agent Skill: {path}',
  },
  'cli.install.kind_unsupported': {
    zh: '暂不支持安装 kind 为 {kind} 的知识输入；当前仅支持 skill（prompt / agent / workflow 的 artifact 模型尚未定义）。',
    en: 'Installing a {kind} knowledge input is not yet supported; only skill is supported today (the artifact model for prompt / agent / workflow is not yet defined).',
  },
  'cli.install.copied': {
    zh: '已安装 skill {name}：{path}',
    en: 'Installed skill {name}: {path}',
  },
  'cli.install.adopted': {
    zh: '已就地接管 skill {name}（已在目标位置，未改动文件）：{path}',
    en: 'Adopted skill {name} in place (already at target, files untouched): {path}',
  },
  'cli.install.registered': {
    zh: '已登记受管记录 {id}：{store}',
    en: 'Registered managed record {id}: {store}',
  },
  'cli.install.target_overlaps_source': {
    zh: '安装目标与源相互嵌套，拒绝执行（会删掉源或自我复制）。源：{source}；目标：{target}。请换一个不与源重叠的 --dest。',
    en: 'Install target overlaps the source (would delete the source or copy into itself); refused. Source: {source}; target: {target}. Use a --dest that does not overlap the source.',
  },
  'cli.install.path_not_found': {
    zh: '找不到要安装的 skill 路径：{path}',
    en: 'Skill path to install not found: {path}',
  },
  'cli.install.skillmd_missing': {
    zh: '目录下没有 SKILL.md，不是一个 directory-skill：{path}',
    en: 'No SKILL.md in the directory; not a directory-skill: {path}',
  },
  'cli.install.not_a_skill': {
    zh: '不是 skill 文件（需要 .md 或含 SKILL.md 的目录）：{path}',
    en: 'Not a skill file (expected a .md file or a directory containing SKILL.md): {path}',
  },
  'cli.install.skillmd_is_symlink': {
    zh: 'SKILL.md 是指向 {target} 的软链，分发会跳过软链、装出来的 skill 会缺 SKILL.md。请直接 install 真源位置：{target}',
    en: 'SKILL.md is a symlink to {target}; symlinks are skipped during distribution, so the installed skill would be missing its SKILL.md. Install the real source instead: {target}',
  },
  'cli.install.not_a_git_repo': {
    zh: '当前目录不在 git 仓库内，无法解析 git: 源。请在仓库内执行，或改用本地路径。',
    en: 'Current directory is not inside a git repo; cannot resolve a git: source. Run inside the repo, or use a local path.',
  },
  'cli.install.git_skill_not_found': {
    zh: '在 git ref {ref} 下找不到 skill {name}（既无 {name}/SKILL.md 也无 {name}.md）。',
    en: 'Skill {name} not found at git ref {ref} (neither {name}/SKILL.md nor {name}.md).',
  },
  'cli.install.next_hint': {
    zh: '现在可以在 coding agent 中说「用 omk 评测这个 skill」。',
    en: 'You can now ask your coding agent: "use omk to evaluate this skill".',
  },
};
