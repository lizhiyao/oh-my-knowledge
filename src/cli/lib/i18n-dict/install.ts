import type { CliMessage } from './types.js';

export type InstallMessageKey =
  | 'cli.install.asset_missing'
  | 'cli.install.unknown_input'
  | 'cli.install.unknown_target'
  | 'cli.install.target_exists'
  | 'cli.install.plan'
  | 'cli.install.installed'
  | 'cli.install.next_hint';

export const installDict: Record<InstallMessageKey, CliMessage> = {
  'cli.install.asset_missing': {
    zh: '未找到打包内置资源：{path}。请先运行 yarn build，或确认 npm 包包含 dist/assets/agent-skills/omk。',
    en: 'Packaged built-in asset not found: {path}. Run yarn build first, or verify the npm package includes dist/assets/agent-skills/omk.',
  },
  'cli.install.unknown_input': {
    zh: '当前 install MVP 只支持内置 id：omk-agent-skill。收到：{input}',
    en: 'The install MVP currently supports only the built-in id: omk-agent-skill. Got: {input}',
  },
  'cli.install.unknown_target': {
    zh: '未知安装目标：{target}。可用值：auto, codex, claude, all；或用 --dest <dir> 指定 skill 根目录。',
    en: 'Unknown install target: {target}. Use auto, codex, claude, all; or pass --dest <dir> for a custom skill root.',
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
  'cli.install.next_hint': {
    zh: '现在可以在 coding agent 中说「用 omk 评测这个 skill」。',
    en: 'You can now ask your coding agent: "use omk to evaluate this skill".',
  },
};
