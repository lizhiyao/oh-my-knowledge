import type { CliMessage } from './types.js';

export type CommonMessageKey =
  | 'cli.common.unknown_domain'
  | 'cli.common.error_prefix'
  | 'cli.common.skill_dir_not_found'
  | 'cli.common.skill_file_not_found'
  | 'cli.common.skill_dir_no_skill_md'
  | 'cli.common.judge_models_single_only'
  | 'cli.common.ambiguous_sample_files'
  | 'cli.common.samples_not_found'
  | 'cli.common.samples_not_found_hint'
  | 'cli.update.new_version_available'
  | 'cli.update.box_title'
  | 'cli.update.box_version_line'
  | 'cli.update.box_upgrade_line'
  | 'cli.update.box_silence_line'
  | 'cli.observe.view_hint'
  | 'cli.observe.observation_recorded'
  | 'cli.observe.production_gap'
  | 'cli.studio.started'
  | 'cli.studio.stop_hint'
  | 'cli.studio.open_failed'
  | 'cli.doctor.no_skill_found'
  | 'cli.doctor.progress_skill_start'
  | 'cli.doctor.progress_skill_done';

export const commonDict: Record<CommonMessageKey, CliMessage> = {
  'cli.common.unknown_domain': {
    zh: "未知命令：{domain}。运行 'omk --help' 查看可用命令。",
    en: "Unknown command: {domain}. Run 'omk --help' to see available commands.",
  },
  'cli.common.error_prefix': {
    zh: '❌ 错误: {message}',
    en: '❌ Error: {message}',
  },
  'cli.common.skill_dir_not_found': {
    zh: '未找到 skill 目录: {path}',
    en: 'Skill directory not found: {path}',
  },
  'cli.common.skill_file_not_found': {
    zh: '未找到 skill 文件: {path}',
    en: 'Skill file not found: {path}',
  },
  'cli.common.skill_dir_no_skill_md': {
    zh: '目录下未找到 SKILL.md: {path}',
    en: 'SKILL.md not found in directory: {path}',
  },
  'cli.common.judge_models_single_only': {
    zh: '{cmd} 仅支持单评委。--judge-models 只能传一个 executor:model entry。',
    en: '{cmd} only supports a single judge. --judge-models accepts exactly one executor:model entry.',
  },
  'cli.common.ambiguous_sample_files': {
    zh: '评测用例文件存在歧义：{paths}。同一作用域只能保留 eval-samples.json 或 eval-samples.yaml 其中一个。',
    en: 'Ambiguous eval sample files: {paths}. Keep only one of eval-samples.json or eval-samples.yaml in the same scope.',
  },
  'cli.common.samples_not_found': {
    zh: '未找到评测用例：{path}。请通过 --samples 指定文件，或创建项目级 eval-samples.json / eval-samples.yaml；单 treatment 目录 skill 请使用 <skill>/.omk/eval-samples.json / eval-samples.yaml。',
    en: 'Eval samples not found: {path}. Pass --samples, create project-level eval-samples.json / eval-samples.yaml, or use <skill>/.omk/eval-samples.json / eval-samples.yaml for a single-treatment directory skill.',
  },
  'cli.common.samples_not_found_hint': {
    zh: '下一步：先运行 {command} 生成用例，人工 review 后再重跑 omk eval。',
    en: 'Next: run {command} to generate samples, review them, then re-run omk eval.',
  },
  'cli.update.new_version_available': {
    zh: '\n💡 新版本可用：{old} → {new}，运行 npm i -g oh-my-knowledge@latest 升级\n\n',
    en: '\n💡 New version available: {old} → {new}, run npm i -g oh-my-knowledge@latest to upgrade\n\n',
  },
  'cli.update.box_title': {
    zh: '↑ omk 有新版本',
    en: '↑ omk update available',
  },
  'cli.update.box_version_line': {
    zh: '当前 {old} → 最新 {new}',
    en: 'current {old} → latest {new}',
  },
  'cli.update.box_upgrade_line': {
    zh: '升级：{cmd}',
    en: 'Upgrade: {cmd}',
  },
  'cli.update.box_silence_line': {
    zh: '静默：设 {env} 关闭提醒',
    en: 'Silence: set {env} to disable',
  },
  'cli.observe.view_hint': {
    zh: '分析 JSON 已写入 output-dir；后续可用 omk observe 持续生成健康报告。',
    en: 'Analysis JSON written to output-dir; use omk observe to keep producing health reports.',
  },
  'cli.observe.observation_recorded': {
    zh: '🔭 已为受管 skill「{name}」记录生产健康观测。\n',
    en: '🔭 Recorded a production-health observation for managed skill "{name}".\n',
  },
  'cli.observe.production_gap': {
    zh: '⚠️ 受管 skill「{name}」线上检测到生产盲区（{areas}）。建议补充对应用例后重跑 omk eval —— observe 只提示，不改样本集。\n',
    en: '⚠️ Managed skill "{name}" shows production gaps in real traffic ({areas}). Consider adding matching samples and re-running omk eval — observe only suggests, it does not edit the sample set.\n',
  },
  'cli.studio.started': {
    zh: 'studio 已启动：{url}',
    en: 'Studio running at {url}',
  },
  'cli.studio.stop_hint': {
    zh: '按 Ctrl+C 停止服务',
    en: 'Press Ctrl+C to stop',
  },
  'cli.studio.open_failed': {
    zh: '⚠ 无法自动打开浏览器（{command}）：{message}\n',
    en: '⚠ Failed to open browser automatically ({command}): {message}\n',
  },
  'cli.doctor.no_skill_found': {
    zh: '未在 {path} 下发现 skill 文件。\n  doctor 期望 .md 文件、目录(包含 .md 或 SKILL.md)或 cwd 下的 skills/ 子目录。',
    en: 'No skills found at {path}.\n  doctor expects a .md file, a directory (containing .md or SKILL.md), or skills/ under cwd.',
  },
  'cli.doctor.progress_skill_start': {
    zh: '{prefix}{skill} ⏳ 体检中...\n',
    en: '{prefix}{skill} ⏳ checking...\n',
  },
  'cli.doctor.progress_skill_done': {
    zh: '{prefix}{skill} {result}（{ms}ms）\n',
    en: '{prefix}{skill} {result} ({ms}ms)\n',
  },
};
