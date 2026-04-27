/**
 * CLI 文案字典。
 *
 * 命名约定: `cli.<command>.<event>` 或 `cli.common.<event>`。
 * 占位符用 `{name}` 形式,在 tCli(params) 处替换。
 *
 * ============================================================================
 * 翻译守则 (受 cc-viewer i18n 方案启发)
 * ============================================================================
 *
 * 1. **彻底本地化, 不接受中英混搭**
 *    "中文用户读到的中文"和"英文用户读到的英文"必须是各自语言里自然的表达,
 *    不能机械翻译, 不能在中文里塞英文短语解释术语。如果某个英文短语没有
 *    自然的中文译法, 重新组织句子结构, 而不是混着写。
 *
 * 2. **保留原文的白名单 (产品术语 / 命令 / 文件名)**
 *    以下 token 在两种语言里都保留原文, 不翻译:
 *    - 产品名: omk, oh-my-knowledge, Claude, npm
 *    - 子命令空间和命令名: bench, analyze, run, report, init, evolve, gold,
 *      diff, ci, gen-samples, debias-validate, saturation, verdict,
 *      diagnose, failures
 *    - omk 核心业务术语: skill, variant, sample, judge, executor (出现在产品
 *      UI 里时首字母可大写如 "Skill 评测", 描述句中保持小写)
 *    - 技术参数: --lang, --control, --treatment, --bootstrap, --judge-repeat,
 *      OMK_LANG, JUDGE_PROMPT_VERSION_*
 *    - 文件名 / 路径: eval-samples.json, skills/v1.md, ~/.oh-my-knowledge/...
 *    - 数学概念缩写: CI, α, RAG (其译法可在配套描述里说明, 但术语本身留原文)
 *
 * 3. **必须翻译的内容**
 *    动作 (run / edit / scaffold / generate), 状态 (success / failed /
 *    invalid), 引导文案 (next steps / try this / see also), 解释性描述。
 *
 * 4. **不要机械直译**
 *    "Next steps:" 译 "下一步:" 而不是 "下一步骤:"。
 *    "Run: ..." 译 "运行: ..." 而不是 "跑: ..."。
 *    选用 omk 项目长期使用的中文措辞 (LLM judge 译"评委" 不译"判官", 见
 *    feedback_ui_translation.md)。
 *
 * 5. **新增 key 流程**
 *    a. 加到 CliMessageKey union 类型里
 *    b. 在 CLI_DICT 里同时给出 zh / en (Record 类型强制 zh/en 双写, 漏写
 *       tsc 直接报错)
 *    c. 自查: 中文里有没有非白名单的英文? 英文里有没有中文?
 *    d. 自查: 措辞自然度 — 把中文版念出来, 像不像中文项目的命令行输出?
 *    e. test/cli-i18n.test.ts 会跑 runtime parity 检查
 *
 * 未来扩 Lang (zh-TW / ja / ko ...): 改 src/types/shared.ts 的 Lang union,
 * Record 类型自动强制每 key 加新语言版本。
 */

export type CliMessageKey =
  // 通用 / 启动期
  | 'cli.common.lang_invalid_silent'
  | 'cli.common.help_hint'
  | 'cli.common.unknown_domain'
  | 'cli.common.unknown_bench_command'
  // bench init
  | 'cli.init.scaffolded'
  | 'cli.init.next_steps_title'
  | 'cli.init.next_step_edit_samples'
  | 'cli.init.next_step_edit_skills'
  | 'cli.init.next_step_run'
  // 启动期检查 (checkUpdate)
  | 'cli.update.new_version_available'
  // 实时进度 (defaultOnProgress)
  | 'cli.progress.preflight_starting'
  | 'cli.progress.sample_retry'
  | 'cli.progress.sample_error'
  | 'cli.progress.sample_executing'
  | 'cli.progress.sample_exec_done'
  | 'cli.progress.output_preview'
  | 'cli.progress.judging'
  | 'cli.progress.judged'
  | 'cli.progress.skipped'
  | 'cli.progress.sample_done'
  // bench run 参数校验 (parseRunConfig)
  | 'cli.run.invalid_repeat'
  | 'cli.run.invalid_judge_repeat'
  | 'cli.run.invalid_judge_models_format'
  | 'cli.run.judge_models_single_warning'
  | 'cli.run.no_debias_length_active'
  | 'cli.run.invalid_bootstrap_samples'
  | 'cli.run.bootstrap_samples_too_large'
  // bench run 完成 / 报告 server / gold compare / 错误
  | 'cli.run.skill_section'
  | 'cli.run.run_section'
  | 'cli.run.batch_complete'
  | 'cli.run.eval_complete'
  | 'cli.run.report_saved'
  | 'cli.run.report_server_running'
  | 'cli.run.report_server_view'
  | 'cli.run.report_server_stop'
  | 'cli.run.no_serve_in_non_tty'
  | 'cli.run.no_serve_view_hint'
  | 'cli.run.gold_load_failed'
  | 'cli.run.gold_load_issue'
  | 'cli.run.contamination_warning'
  | 'cli.common.error_prefix'
  // bench analyze
  | 'cli.analyze.view_in_browser'
  // 通用 not-found 错误
  | 'cli.common.skill_dir_not_found'
  | 'cli.common.skill_file_not_found'
  | 'cli.common.report_not_found'
  | 'cli.common.no_judge_model'
  | 'cli.common.usage_gold_validate'
  | 'cli.common.warn_load_samples_failed'
  // bench gen-samples
  | 'cli.gen.skill_skipped_existing'
  | 'cli.gen.skill_generating'
  | 'cli.gen.skill_done'
  | 'cli.gen.skill_failed'
  | 'cli.gen.batch_none_needed'
  | 'cli.gen.batch_summary'
  | 'cli.gen.specify_skill_path'
  | 'cli.gen.samples_already_exists'
  | 'cli.gen.single_generating'
  | 'cli.gen.single_done'
  | 'cli.gen.review_hint'
  | 'cli.gen.failed'
  // bench evolve
  | 'cli.evolve.specify_skill_path'
  | 'cli.evolve.section_header'
  | 'cli.evolve.round_baseline'
  | 'cli.evolve.round_error'
  | 'cli.evolve.round_done'
  | 'cli.evolve.summary'
  | 'cli.evolve.best_path'
  | 'cli.evolve.versions_saved'
  | 'cli.evolve.report_link'
  // bench gold
  | 'cli.gold.created_files'
  | 'cli.gold.next_step_edit_annotations'
  | 'cli.gold.validate_ok'
  // bench debias-validate
  | 'cli.debias.warn_cost_doubles'
  // bench saturation
  | 'cli.saturation.no_data'
  | 'cli.saturation.verdict_header'
  | 'cli.saturation.variant_no_trace'
  | 'cli.saturation.variant_label'
  | 'cli.saturation.checkpoints'
  | 'cli.saturation.last_point'
  | 'cli.saturation.persisted_verdict'
  | 'cli.saturation.persisted_verdict_saturated'
  | 'cli.saturation.persisted_verdict_unsaturated'
  | 'cli.saturation.skipped_too_few_points';

export interface CliMessage {
  zh: string;
  en: string;
}

export const CLI_DICT: Record<CliMessageKey, CliMessage> = {
  'cli.common.lang_invalid_silent': {
    zh: '无效的语言代码: {value} (仅支持 zh / en, 已使用默认 zh)',
    en: 'Invalid language code: {value} (supported: zh / en, using default zh)',
  },
  'cli.common.help_hint': {
    zh: "运行 'omk --help' 查看用法",
    en: "Run 'omk --help' to see usage",
  },
  'cli.common.unknown_domain': {
    zh: "未知顶层命令: {domain} (请用 'omk bench <command>' 或 'omk analyze <dir>')",
    en: "Unknown domain: {domain} (use 'omk bench <command>' or 'omk analyze <dir>')",
  },
  'cli.common.unknown_bench_command': {
    zh: "未知子命令: bench {command} (运行 'omk --help' 查看可用列表)",
    en: "Unknown bench command: {command} (run 'omk --help' to see all commands)",
  },
  'cli.init.scaffolded': {
    zh: '已初始化测评项目: {dir}',
    en: 'Eval project scaffolded at: {dir}',
  },
  'cli.init.next_steps_title': {
    zh: '下一步:',
    en: 'Next steps:',
  },
  'cli.init.next_step_edit_samples': {
    zh: '  1. 编辑 eval-samples.json, 加入你要测的测评用例',
    en: '  1. Edit eval-samples.json to add your test cases',
  },
  'cli.init.next_step_edit_skills': {
    zh: '  2. 编辑 skills/v1.md 和 skills/v2.md, 为两个 skill 版本填入实际内容',
    en: '  2. Edit skills/v1.md and skills/v2.md with your skill versions',
  },
  'cli.init.next_step_run': {
    zh: '  3. 运行: omk bench run --control v1 --treatment v2',
    en: '  3. Run: omk bench run --control v1 --treatment v2',
  },
  'cli.update.new_version_available': {
    zh: '\n💡 新版本可用: {old} → {new}, 运行 npm update {pkg} -g 升级\n\n',
    en: '\n💡 New version available: {old} → {new}, run npm update {pkg} -g to upgrade\n\n',
  },
  'cli.progress.preflight_starting': {
    zh: '⏳ 正在预检模型连通性...\n',
    en: '⏳ Preflight: checking model connectivity...\n',
  },
  'cli.progress.sample_retry': {
    zh: '[{i}/{n}] {sample}/{variant} 🔄 重试 {attempt}/{max}...\n',
    en: '[{i}/{n}] {sample}/{variant} 🔄 retry {attempt}/{max}...\n',
  },
  'cli.progress.sample_error': {
    zh: '[{i}/{n}] {sample}/{variant} ❌ {error}\n',
    en: '[{i}/{n}] {sample}/{variant} ❌ {error}\n',
  },
  'cli.progress.sample_executing': {
    zh: '[{i}/{n}] {sample}/{variant} ⏳ 执行中...\n',
    en: '[{i}/{n}] {sample}/{variant} ⏳ running...\n',
  },
  'cli.progress.sample_exec_done': {
    zh: '[{i}/{n}] {sample}/{variant} 执行完成 {ms}ms {input}+{output} tokens{cost}\n',
    en: '[{i}/{n}] {sample}/{variant} done {ms}ms {input}+{output} tokens{cost}\n',
  },
  'cli.progress.output_preview': {
    zh: '  输出预览: {preview}\n',
    en: '  output preview: {preview}\n',
  },
  'cli.progress.judging': {
    zh: '[{i}/{n}] {sample}/{variant} 评委评审中{dim}...\n',
    en: '[{i}/{n}] {sample}/{variant} judging{dim}...\n',
  },
  'cli.progress.judged': {
    zh: '[{i}/{n}] {sample}/{variant} 评委评审完成{dim} score={score}\n',
    en: '[{i}/{n}] {sample}/{variant} judged{dim} score={score}\n',
  },
  'cli.progress.skipped': {
    zh: '[{i}/{n}] {sample}/{variant} ⏭ 已跳过 (已有结果)\n',
    en: '[{i}/{n}] {sample}/{variant} ⏭ skipped (cached)\n',
  },
  'cli.progress.sample_done': {
    zh: '[{i}/{n}] {sample}/{variant} ✓ {ms}ms {input}+{output} tokens{cost}{score}\n',
    en: '[{i}/{n}] {sample}/{variant} ✓ {ms}ms {input}+{output} tokens{cost}{score}\n',
  },
  'cli.run.invalid_repeat': {
    zh: '⚠ --repeat "{value}" 无效 (期望 ≥ 1 的整数), 已按 1 次评测执行\n',
    en: '⚠ --repeat "{value}" is invalid (expected an integer ≥ 1), falling back to 1 run\n',
  },
  'cli.run.invalid_judge_repeat': {
    zh: '⚠ --judge-repeat "{value}" 无效 (期望 ≥ 1 的整数), 已按 1 次 judge 执行\n',
    en: '⚠ --judge-repeat "{value}" is invalid (expected an integer ≥ 1), falling back to 1 judge call\n',
  },
  'cli.run.invalid_judge_models_format': {
    zh: '--judge-models 格式错误: "{part}", 应为 "executor:model" (例如 claude:opus)',
    en: '--judge-models format error: "{part}", expected "executor:model" (e.g. claude:opus)',
  },
  'cli.run.judge_models_single_warning': {
    zh: 'ℹ --judge-models 只指定了 1 个 judge ({executor}:{model}), 不会进入 ensemble 模式。如需 ensemble, 至少配 2 个。\n',
    en: 'ℹ --judge-models specified only 1 judge ({executor}:{model}); ensemble not triggered. Configure at least 2 for ensemble mode.\n',
  },
  'cli.run.no_debias_length_active': {
    zh: 'ℹ --no-debias-length 已生效: judge prompt 退回 v2-cot, 与 < v0.21 报告 hash 一致。\n',
    en: 'ℹ --no-debias-length is active: judge prompt reverts to v2-cot, matching < v0.21 report hashes.\n',
  },
  'cli.run.invalid_bootstrap_samples': {
    zh: '⚠ --bootstrap-samples "{value}" 无效 (期望 ≥ 100 的整数), 已按 1000 执行\n',
    en: '⚠ --bootstrap-samples "{value}" is invalid (expected an integer ≥ 100), falling back to 1000\n',
  },
  'cli.run.bootstrap_samples_too_large': {
    zh: '⚠ --bootstrap-samples {n} 较大, 可能耗时数秒。1000 是业内标准, 通常已够用。\n',
    en: '⚠ --bootstrap-samples {n} is large and may take several seconds. 1000 is the industry standard and usually sufficient.\n',
  },
  'cli.run.skill_section': {
    zh: '\n=== [{i}/{n}] Skill: {skill} ===\n',
    en: '\n=== [{i}/{n}] Skill: {skill} ===\n',
  },
  'cli.run.run_section': {
    zh: '\n=== 第 {i}/{n} 轮 ===\n',
    en: '\n=== Run {i}/{n} ===\n',
  },
  'cli.run.batch_complete': {
    zh: '\n✅ 批量评测完成\n',
    en: '\n✅ Batch evaluation done\n',
  },
  'cli.run.eval_complete': {
    zh: '\n✅ 评测完成\n',
    en: '\n✅ Evaluation done\n',
  },
  'cli.run.report_saved': {
    zh: '📄 报告已保存到: {path}\n',
    en: '📄 Report saved to: {path}\n',
  },
  'cli.run.report_server_running': {
    zh: '\n📊 报告服务已启动: {url}\n',
    en: '\n📊 Report server running at {url}\n',
  },
  'cli.run.report_server_view': {
    zh: '👉 查看报告: {url}\n',
    en: '👉 View report: {url}\n',
  },
  'cli.run.report_server_stop': {
    zh: '\n按 Ctrl+C 停止服务\n',
    en: '\nPress Ctrl+C to stop the server\n',
  },
  'cli.run.no_serve_in_non_tty': {
    zh: '\n💡 非交互环境, 已跳过 report server\n',
    en: '\n💡 Non-interactive environment, skipping report server\n',
  },
  'cli.run.no_serve_view_hint': {
    zh: '   查看报告: omk bench report --reports-dir {dir}\n',
    en: '   View report: omk bench report --reports-dir {dir}\n',
  },
  'cli.run.gold_load_failed': {
    zh: '\n⚠ gold dataset 加载失败 ({dir}):\n',
    en: '\n⚠ Failed to load gold dataset ({dir}):\n',
  },
  'cli.run.gold_load_issue': {
    zh: '  - {message}\n',
    en: '  - {message}\n',
  },
  'cli.run.contamination_warning': {
    zh: '\n⚠ {warning}\n',
    en: '\n⚠ {warning}\n',
  },
  'cli.common.error_prefix': {
    zh: '错误: {message}',
    en: 'Error: {message}',
  },
  'cli.analyze.view_in_browser': {
    zh: "在浏览器查看: omk bench report  # 打开后点首页的 \"📊 Skill 健康度日报\"",
    en: "View in browser: omk bench report  # then click \"📊 Skill health report\" on the home page",
  },
  'cli.common.skill_dir_not_found': {
    zh: '未找到 skill 目录: {path}',
    en: 'Skill directory not found: {path}',
  },
  'cli.common.skill_file_not_found': {
    zh: '未找到 skill 文件: {path}',
    en: 'Skill file not found: {path}',
  },
  'cli.common.report_not_found': {
    zh: '未找到 report: {id}',
    en: 'Report not found: {id}',
  },
  'cli.common.no_judge_model': {
    zh: '未指定评委模型。请加 --judge-model <id>, 或确保 report.meta.judgeModel 已写。',
    en: 'No judge model. Pass --judge-model <id> or ensure report has meta.judgeModel.',
  },
  'cli.common.usage_gold_validate': {
    zh: '用法: omk bench gold validate <dir>',
    en: 'Usage: omk bench gold validate <dir>',
  },
  'cli.common.warn_load_samples_failed': {
    zh: '⚠ 加载 samples 文件失败 ({path}): {message}\n',
    en: '⚠ Failed to load samples file ({path}): {message}\n',
  },
  'cli.gen.skill_skipped_existing': {
    zh: '⏭️  {name}: eval-samples 已存在, 跳过\n',
    en: '⏭️  {name}: eval-samples already exists, skipping\n',
  },
  'cli.gen.skill_generating': {
    zh: '🔄 {name}: 正在生成 {count} 条测评用例...\n',
    en: '🔄 {name}: generating {count} test cases...\n',
  },
  'cli.gen.skill_done': {
    zh: '✅ {name}: 已生成 {n} 条样本 → {path}{cost}\n',
    en: '✅ {name}: generated {n} samples → {path}{cost}\n',
  },
  'cli.gen.skill_failed': {
    zh: '❌ {name}: {message}\n',
    en: '❌ {name}: {message}\n',
  },
  'cli.gen.batch_none_needed': {
    zh: '没有需要生成的 eval-samples (所有 skill 都已有配对文件)',
    en: 'No eval-samples need generating (all skills already have paired files)',
  },
  'cli.gen.batch_summary': {
    zh: '\n共生成 {n} 份 eval-samples, 请审查后运行: omk bench run --each',
    en: '\nGenerated {n} eval-samples files. Review them, then run: omk bench run --each',
  },
  'cli.gen.specify_skill_path': {
    zh: '请指定 skill 文件路径, 例如: omk bench gen-samples skills/my-skill.md',
    en: 'Please specify a skill file path, e.g.: omk bench gen-samples skills/my-skill.md',
  },
  'cli.gen.samples_already_exists': {
    zh: 'eval-samples.json 已存在。如需覆盖请先删除该文件。',
    en: 'eval-samples.json already exists. Delete it first if you want to overwrite.',
  },
  'cli.gen.single_generating': {
    zh: '🔄 正在生成 {count} 条测评用例...\n',
    en: '🔄 Generating {count} test cases...\n',
  },
  'cli.gen.single_done': {
    zh: '✅ 已生成 {n} 条样本 → {path}{cost}\n',
    en: '✅ Generated {n} samples → {path}{cost}\n',
  },
  'cli.gen.review_hint': {
    zh: '\n请审查生成的测评用例后运行: omk bench run',
    en: '\nReview the generated test cases, then run: omk bench run',
  },
  'cli.gen.failed': {
    zh: '生成失败: {message}',
    en: 'Generation failed: {message}',
  },
  'cli.evolve.specify_skill_path': {
    zh: '请指定 skill 文件路径, 例如: omk bench evolve skills/my-skill.md',
    en: 'Please specify a skill file path, e.g.: omk bench evolve skills/my-skill.md',
  },
  'cli.evolve.section_header': {
    zh: '\n=== Evolution: {path} ===\n',
    en: '\n=== Evolution: {path} ===\n',
  },
  'cli.evolve.round_baseline': {
    zh: '第 0 轮 (基线): score={score} (${cost})\n',
    en: 'Round 0 (baseline): score={score} (${cost})\n',
  },
  'cli.evolve.round_error': {
    zh: '第 {round} 轮: ✗ 改进生成失败: {error}\n',
    en: 'Round {round}: ✗ improvement generation failed: {error}\n',
  },
  'cli.evolve.round_done': {
    zh: '第 {round} 轮: score={score} ({delta}) {status} (${cost})\n',
    en: 'Round {round}: score={score} ({delta}) {status} (${cost})\n',
  },
  'cli.evolve.summary': {
    zh: '\n✅ {start} → {final} (+{percent}%) | 共 {rounds} 轮 | ${cost}\n',
    en: '\n✅ {start} → {final} (+{percent}%) | {rounds} rounds | ${cost}\n',
  },
  'cli.evolve.best_path': {
    zh: '最优版本: {best} → {target}\n',
    en: 'Best: {best} → {target}\n',
  },
  'cli.evolve.versions_saved': {
    zh: '所有版本已保存在: {dir}/\n',
    en: 'All versions saved at: {dir}/\n',
  },
  'cli.evolve.report_link': {
    zh: '📊 评测报告: omk bench report (ID: {id})\n',
    en: '📊 Report: omk bench report (ID: {id})\n',
  },
  'cli.gold.created_files': {
    zh: '已在 {dir} 创建 {n} 个文件:',
    en: 'Created {n} files in {dir}:',
  },
  'cli.gold.next_step_edit_annotations': {
    zh: '\n下一步: 编辑 annotations.yaml 加入真实标注 → 跑 omk bench gold validate',
    en: '\nNext step: edit annotations.yaml with real annotations → run omk bench gold validate',
  },
  'cli.gold.validate_ok': {
    zh: '✓ gold dataset OK — 共 {n} 条标注',
    en: '✓ gold dataset OK — {n} annotations',
  },
  'cli.debias.warn_cost_doubles': {
    zh: '\n⚠ debias-validate 会重判所有 (sample × variant), judge 成本大约翻倍。\n',
    en: '\n⚠ debias-validate will re-judge all (sample × variant) pairs; judge cost will roughly double.\n',
  },
  'cli.saturation.no_data': {
    zh: '该 report 没有 saturation 数据 (需要 --repeat ≥ 2 才会记录)。',
    en: 'This report has no saturation data (requires --repeat ≥ 2 to record).',
  },
  'cli.saturation.verdict_header': {
    zh: '\n  Saturation verdict (复述持久化结果)\n',
    en: '\n  Saturation verdict (replaying persisted result)\n',
  },
  'cli.saturation.variant_no_trace': {
    zh: '  {variant}: 没有 trace 数据',
    en: '  {variant}: no trace data',
  },
  'cli.saturation.variant_label': {
    zh: '  {variant}:',
    en: '  {variant}:',
  },
  'cli.saturation.checkpoints': {
    zh: '    检查点: {n} (N={list})',
    en: '    checkpoints: {n} (N={list})',
  },
  'cli.saturation.last_point': {
    zh: '    最后一点 mean={mean}, CI=[{lo}, {hi}]',
    en: '    last point mean={mean}, CI=[{lo}, {hi}]',
  },
  'cli.saturation.persisted_verdict': {
    zh: '    持久化判定 ({method}): {result} - {reason}',
    en: '    persisted verdict ({method}): {result} - {reason}',
  },
  'cli.saturation.persisted_verdict_saturated': {
    zh: '已饱和@N={n}',
    en: 'saturated@N={n}',
  },
  'cli.saturation.persisted_verdict_unsaturated': {
    zh: '未饱和',
    en: 'not saturated',
  },
  'cli.saturation.skipped_too_few_points': {
    zh: '    判定: 数据点数 {n} < 5, 跳过 (需要跑 --repeat 5 以上才会输出)',
    en: '    verdict: only {n} data points (< 5), skipping (need --repeat 5 or more)',
  },
};
