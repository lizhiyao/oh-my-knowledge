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
  | 'cli.saturation.skipped_too_few_points'
  // 长段 help / usage 文案 (multi-line)
  | 'cli.help.main'
  | 'cli.help.diff_usage'
  | 'cli.help.analyze_usage'
  | 'cli.help.gold'
  | 'cli.help.debias_validate'
  | 'cli.help.saturation'
  | 'cli.help.verdict'
  | 'cli.help.diagnose'
  | 'cli.help.failures'
  // sample design coverage block (bench diagnose)
  | 'cli.diagnose.coverage_header'
  | 'cli.diagnose.coverage_unspecified'
  | 'cli.diagnose.coverage_chars'
  | 'cli.diagnose.coverage_hint_empty'
  | 'cli.diagnose.coverage_declared';

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
    zh: '✅ {name}: 已生成 {n} 条用例 → {path}{cost}\n',
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
    zh: '✅ 已生成 {n} 条用例 → {path}{cost}\n',
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
  'cli.help.main': {
    zh: `
oh-my-knowledge — 知识工件评测工具集

用法:
  omk bench run [options]              跑一轮评测
  omk bench report [options]           启动报告 server
  omk bench gate [options]             跑评测 + 应用 gate, exit code 0/1 (CI/CD 用)
  omk bench init [dir]                 初始化一个评测项目
  omk bench gen-samples [skill]        从 skill 内容生成 eval-samples
  omk bench diff <id1> <id2>           对比两份评测报告
  omk bench evolve <skill>             通过迭代评测自我改进 skill

  omk analyze <dir>                    分析 cc session trace, 生成 skill 健康度日报 (v0.18)

bench run 选项:

  --samples <path>       用例文件 (默认: eval-samples.json)
  --skill-dir <path>     skill 定义目录 (默认: skills)
  --control <expr>       对照组 variant 表达式 (实验角色 = control)
  --treatment <v1,v2>    实验组 variant 表达式 (逗号分隔; 角色 = treatment)
                         每个 variant 表达式解析为一个 artifact 加上可选运行时上下文:
                           "baseline"       — 裸模型, 不注入 artifact
                           "git:name"       — 来自最后一次 commit 的 artifact
                           "git:ref:name"   — 来自指定 commit 的 artifact
                           带 "/" 的路径    — 直接来自文件 (例如 ./v1.md)
                           "name@/cwd"      — 附加运行时上下文 / cwd
                         --control 和 --treatment 至少要给一个。
  --config <path>        YAML/JSON 配置文件 (evaluation-as-code)。
                         在一个文件里声明 samples + variants + model + executor。
                         CLI flag 会覆盖配置文件中的同名字段。
                         配置中的相对路径相对于配置文件所在目录解析。
  --model <name>         被测模型 (默认: sonnet)
  --judge-model <name>   评委模型 (默认: haiku)
  --output-dir <path>    报告输出目录 (默认: ~/.oh-my-knowledge/reports/)
  --no-judge             跳过 LLM 评委
  --no-cache             禁用结果缓存
  --dry-run              预览任务但不执行
  --blind                双盲 A/B 模式: 报告里隐藏 variant 名称
  --concurrency <n>      并发任务数 (默认: 1)
  --timeout <seconds>    单任务执行超时 (秒, 默认: 120)
  --repeat <n>           跑 N 轮做方差分析 (默认: 1)
  --judge-repeat <n>     每个 (sample × dimension) 调 LLM 评委 N 次评估
                         自洽性 (默认: 1)。多轮间高 stddev = 评委在该评分维度
                         上不稳定, 分数有噪声。
  --judge-models <list>  多评委 ensemble。逗号分隔的 executor:model, 如
                         claude:opus,openai:gpt-4o,gemini:pro。每个评委对所有
                         (sample × dimension) 打分; 报告含每评委分布 + Pearson
                         / MAD 评委间一致性。能反驳 "Claude 评委评 Claude 同
                         模态偏置" 的质疑。可与 --judge-repeat 组合。
                         成本 ~ N_judges × N_repeat × N_samples。
  --bootstrap            计算 bootstrap 置信区间 (无分布假设, 对 LLM 序数评分
                         比 t 区间更靠谱)。给出每个 variant 均值 CI + treatment
                         vs control 差值的 pairwise CI (CI 不跨 0 即显著)。
                         同时报告 t 区间和 bootstrap, 旧工具仍可用。
  --bootstrap-samples <n>  bootstrap 重采样次数 (默认 1000)。N>10000 触发
                         stderr 警告提示耗时。
  --retry <n>            失败任务最多重试 N 次, 指数退避 (默认: 0)
  --resume <report-id>   从历史报告恢复, 跳过已完成任务
  --executor <name>      执行器: claude / openai / gemini / anthropic-api /
                         openai-api, 或任意 shell 命令 (例如 "python my_provider.py")
  --judge-executor <name> 评委执行器 (默认: 同 --executor)
  --each                 对每个 skill 独立 vs baseline 评测
                         需要每个 skill 有配对的 {name}.eval-samples.json
  --skip-preflight       评测前跳过模型连通性预检
  --mcp-config <path>    通过 MCP server 抓 URL 用的 MCP 配置文件
                         (默认: 当前目录下的 .mcp.json)
  --no-serve             评测后不自动启动报告 server
  --verbose              打印每个用例的详细进度 (执行结果 / 评分阶段)
  --layered-stats        默认在 HTML 报告里展开三层 (fact/behavior/judge) 独立
                         显著性细分。不加这个 flag 时, 细分会折叠在每个对比下
                         的 click-to-expand summary 里。
  --strict-baseline      (默认开启) 对 baseline-kind variant 强制隔离 skill 自动
                         发现 + Skill 工具调用, 切断 ~/.claude/skills/ 污染路径,
                         保证 skill 评测的 construct validity。eval.yaml 显式
                         allowedSkills 优先。
  --no-strict-baseline   显式关闭 strict-baseline (baseline 走默认 SDK skill
                         全发现)。少数场景下可能想要这个 (例如评测 skill 文档
                         对默认全发现行为的增量影响)。开启时 pre-flight 会
                         stderr 提醒, 因为 verdict / Δ 易受污染。

bench gate 选项:
  (与 bench run 相同, 额外加:)
  --threshold <number>   三层 gate 阈值 (fact / behavior / LLM judge), 独立应用
                         到每一层。任一层低于阈值即失败 — 防止合成均值掩盖单层
                         崩塌。默认: 3.5。如果三层全空 (没有 assertion 也没在
                         eval-samples 里定义 rubric), gate 失败并提示配置问题,
                         不走合成 fallback。
  --trivial-diff <num>   实际可忽略的最小 diff (默认 0.1)。bootstrap diff CI
                         显著但 |Δ| 小于此值视为"统计有效但实际无意义",标
                         CAUTIOUS 不给 PROGRESS。

  内部 = bench run + bench verdict, exit code 与 bench verdict 对齐:
  PROGRESS / SOLO-PASS → 0; NOISE / UNDERPOWERED / CAUTIOUS / REGRESS → 1。
  数据 underpowered 时直接 FAIL, 堵住"单轮过 PASS 就 deploy"漏洞。

bench report 选项:
  --port <number>        server 端口 (默认: 7799)
  --reports-dir <path>   报告目录 (默认: ~/.oh-my-knowledge/reports/)
  --export <id>          把报告导出为独立 HTML 文件
  --dev                  开发模式: lib/ 文件改动时自动重启

bench gen-samples 选项:
  --each                 为所有还没 eval-samples 的 skill 生成
  --count <n>            每个 skill 生成多少条用例 (默认: 5)
  --model <name>         生成用的模型 (默认: sonnet)
  --skill-dir <path>     skill 目录 (默认: skills), 配合 --each 用

analyze 选项:
  <dir>                  输入: cc session JSONL 文件 / 目录
                         (例如 ~/.claude/projects/<slug>)
  --kb <path>            知识库根路径 (默认: 从 trace cwd 自动推断)
  --last <duration>      时间窗口, 例如 "7d" / "30d" (默认: 全部)
  --from <iso>           窗口起点 (ISO8601), 优先级高于 --last
  --to <iso>             窗口终点 (ISO8601), 优先级高于 --last
  --skills <n1,n2,...>   白名单要分析的 skill (默认: 全部)
  --output-dir <path>    输出目录 (默认: ~/.oh-my-knowledge/analyses/)

bench evolve 选项:
  --rounds <n>           最大演化轮数 (默认: 5)
  --target <score>       达到该分数即提前停止
  --samples <path>       用例文件 (默认: eval-samples.json)
  --model <name>         被测模型 (默认: sonnet)
  --judge-model <name>   评委模型 (默认: haiku)
  --improve-model <name> 生成改进版的模型 (默认: sonnet)
  --concurrency <n>      并发评测任务数 (默认: 1)
  --timeout <seconds>    单任务执行超时 (秒, 默认: 120)
  --executor <name>      执行器 (默认: claude)

通用选项:
  --lang <zh|en>         CLI 输出语言 (默认: zh, 也可设 OMK_LANG 环境变量)

示例:
  omk bench run --control v1 --treatment v2
  omk bench run --control baseline --treatment my-skill
  omk bench run --control git:my-skill --treatment my-skill
  omk bench run --control ./old-skill.md --treatment ./new-skill.md
  omk bench run --control baseline --treatment v1,v2,v3
  omk bench run --config eval.yaml
  omk bench run --config eval.yaml --model sonnet-4.6   # CLI 覆盖配置
  omk bench run --each
  omk bench run --dry-run
  omk bench report --port 8080
  omk bench report --export v1-vs-v2-20260326-1832
  omk bench init my-eval
  omk bench gen-samples skills/my-skill.md
`,
    en: `
oh-my-knowledge — Knowledge artifact evaluation toolkit

Usage:
  omk bench run [options]              Run an evaluation
  omk bench report [options]           Start the report server
  omk bench gate [options]             Run evaluation + apply gate, exit 0/1 (for CI/CD)
  omk bench init [dir]                 Scaffold a new eval project
  omk bench gen-samples [skill]        Generate eval-samples from skill content
  omk bench diff <id1> <id2>           Compare two evaluation reports
  omk bench evolve <skill>             Self-improve a skill through iterative evaluation

  omk analyze <dir>                    Analyze cc session trace(s), produce skill health report (v0.18)

Options for "bench run":

  --samples <path>       Sample file (default: eval-samples.json)
  --skill-dir <path>     Skill definitions directory (default: skills)
  --control <expr>       Control-group variant expression (experiment role = control)
  --treatment <v1,v2>    Treatment-group variant expressions (comma-separated; role = treatment)
                         Each variant expression resolves to an artifact and optional runtime context:
                           "baseline"       — bare model, no artifact injected
                           "git:name"       — artifact from last commit
                           "git:ref:name"   — artifact from specific commit
                           path with "/"    — artifact from file directly (e.g. ./v1.md)
                           "name@/cwd"      — attach runtime context / cwd
                         At least one of --control / --treatment must be provided.
  --config <path>        YAML/JSON config file (evaluation-as-code).
                         Declares samples + variants + model + executor in one file.
                         CLI flags override config fields when both are provided.
                         Relative paths inside the config are resolved against its directory.
  --model <name>         Model under test (default: sonnet)
  --judge-model <name>   Judge model (default: haiku)
  --output-dir <path>    Report output directory (default: ~/.oh-my-knowledge/reports/)
  --no-judge             Skip LLM judging
  --no-cache             Disable result caching
  --dry-run              Preview tasks without executing
  --blind                Blind A/B mode: hide variant names in report
  --concurrency <n>      Number of parallel tasks (default: 1)
  --timeout <seconds>    Executor timeout per task in seconds (default: 120)
  --repeat <n>           Run evaluation N times for variance analysis (default: 1)
  --judge-repeat <n>     Call LLM judge N times per (sample × dimension) for self-
                         consistency (default: 1). High stddev across runs = the
                         judge is unstable on this rubric and the score is noisy.
  --judge-models <list>  Multi-judge ensemble. Comma-separated executor:model pairs,
                         e.g. claude:opus,openai:gpt-4o,gemini:pro. Each judge scores
                         every (sample × dimension); report includes per-judge break-
                         down + Pearson/MAD inter-judge agreement. Refutes "Claude
                         judge Claude same-modality bias" critique. Combines with
                         --judge-repeat. Cost ~ N_judges × N_repeat × N_samples.
  --bootstrap            Compute bootstrap confidence intervals (distribution-free,
                         preferred over t-interval for ordinal LLM scores). Adds
                         per-variant CI on the mean + pairwise CI on treatment-vs-
                         control difference (significant=0 outside CI). Reports both
                         t-interval and bootstrap so old tooling still works.
  --bootstrap-samples <n>  Number of bootstrap resamples (default 1000). N>10000
                         triggers a stderr warning about runtime cost.
  --retry <n>            Retry failed tasks up to N times with exponential backoff (default: 0)
  --resume <report-id>   Resume from a previous report, skipping completed tasks
  --executor <name>      Executor: claude, openai, gemini, anthropic-api, openai-api,
                         or any shell command (e.g. "python my_provider.py")
  --judge-executor <name> Executor for LLM judge (default: same as --executor)
  --each                 Evaluate each skill independently against baseline
                         Requires {name}.eval-samples.json paired with each skill
  --skip-preflight       Skip model connectivity check before evaluation
  --mcp-config <path>    MCP config file for URL fetching via MCP servers
                         (default: .mcp.json in current directory)
  --no-serve             Skip auto-starting report server after evaluation
  --verbose              Print detailed progress for each sample (exec result, grading phases)
  --layered-stats        Expand the three-layer (fact/behavior/judge) independent
                         significance breakdown in the HTML report by default.
                         Without this flag, the breakdown is collapsed behind a
                         click-to-expand summary under each comparison.
  --strict-baseline      (default ON) Isolate skill auto-discovery + Skill tool
                         use for baseline-kind variants. Cuts the ~/.claude/skills/
                         contamination path so skill evaluations have valid
                         construct validity. Explicit eval.yaml allowedSkills
                         takes precedence.
  --no-strict-baseline   Explicitly turn strict-baseline OFF (baseline sees all
                         auto-discovered skills). Use only in narrow scenarios
                         (e.g. measuring how much a skill doc adds on top of
                         full default discovery). Pre-flight emits a stderr
                         warning when this flag is set, because
                         verdict / Δ are vulnerable to skill contamination.

Options for "bench gate":
  (same as "bench run", plus:)
  --threshold <number>   Three-layer gate threshold (fact / behavior / LLM judge),
                         applied INDEPENDENTLY to each layer. ANY layer below
                         threshold fails the gate — prevents composite averaging
                         from masking a single-layer collapse. Default: 3.5.
                         If all three layers are absent (no
                         assertions and no rubric defined in eval-samples), the
                         gate FAILS with a configuration hint — no composite fallback.
  --trivial-diff <num>   Smallest diff to treat as practically meaningful
                         (default 0.1). Bootstrap diff CI may be statistically
                         significant but with |Δ| < this value, treated as
                         CAUTIOUS rather than PROGRESS.

  Internally = bench run + bench verdict. Exit code aligns with bench verdict:
  PROGRESS / SOLO-PASS → 0; NOISE / UNDERPOWERED / CAUTIOUS / REGRESS → 1.
  Underpowered runs fail directly — closes the "single-run PASS = deploy" loophole.

Options for "bench report":
  --port <number>        Server port (default: 7799)
  --reports-dir <path>   Reports directory (default: ~/.oh-my-knowledge/reports/)
  --export <id>          Export report as standalone HTML file
  --dev                  Dev mode: auto-restart on lib/ file changes

Options for "bench gen-samples":
  --each                 Generate for all skills missing eval-samples
  --count <n>            Number of samples to generate per skill (default: 5)
  --model <name>         Model for generation (default: sonnet)
  --skill-dir <path>     Skill directory (default: skills), used with --each

Options for "analyze":
  <dir>                  Input: cc session JSONL file / dir (e.g. ~/.claude/projects/<slug>)
  --kb <path>            Knowledge base root (default: auto-infer from trace cwd)
  --last <duration>      Time window like "7d" / "30d" (default: all)
  --from <iso>           Window start (ISO8601), takes precedence over --last
  --to <iso>             Window end (ISO8601), takes precedence over --last
  --skills <n1,n2,...>   Whitelist skills to analyze (default: all)
  --output-dir <path>    Output dir (default: ~/.oh-my-knowledge/analyses/)

Options for "bench evolve":
  --rounds <n>           Maximum evolution rounds (default: 5)
  --target <score>       Stop early when score reaches this threshold
  --samples <path>       Sample file (default: eval-samples.json)
  --model <name>         Model under test (default: sonnet)
  --judge-model <name>   Judge model (default: haiku)
  --improve-model <name> Model for generating improvements (default: sonnet)
  --concurrency <n>      Parallel eval tasks (default: 1)
  --timeout <seconds>    Executor timeout per task in seconds (default: 120)
  --executor <name>      Executor to use (default: claude)

Common options:
  --lang <zh|en>         CLI output language (default: zh, also via OMK_LANG env)

Examples:
  omk bench run --control v1 --treatment v2
  omk bench run --control baseline --treatment my-skill
  omk bench run --control git:my-skill --treatment my-skill
  omk bench run --control ./old-skill.md --treatment ./new-skill.md
  omk bench run --control baseline --treatment v1,v2,v3
  omk bench run --config eval.yaml
  omk bench run --config eval.yaml --model sonnet-4.6   # CLI overrides config
  omk bench run --each
  omk bench run --dry-run
  omk bench report --port 8080
  omk bench report --export v1-vs-v2-20260326-1832
  omk bench init my-eval
  omk bench gen-samples skills/my-skill.md
`,
  },
  'cli.help.diff_usage': {
    zh: [
      '用法:',
      '  omk bench diff <reportId>                     单 report 内 sample 级 diff',
      '  omk bench diff <reportId1> <reportId2>        跨 report variant 级 diff',
      '',
      '选项:',
      '  --regressions-only          只列 treatment < control 的用例',
      '  --threshold <num>           回退判定阈值 (默认 0, 即任何负 Δ 都算回退)',
      '  --variant <name>            within-report 模式下指定要钻取的 variant (默认: variants[1])',
      '  --top <n>                   只列差距最大的前 N 个用例',
    ].join('\n'),
    en: [
      'Usage:',
      '  omk bench diff <reportId>                     within-report per-sample diff',
      '  omk bench diff <reportId1> <reportId2>        cross-report variant-level diff',
      '',
      'Options:',
      '  --regressions-only          show only samples where treatment < control',
      '  --threshold <num>           regression threshold (default 0, any negative Δ counts)',
      '  --variant <name>            within-report mode: which variant to drill (default: variants[1])',
      '  --top <n>                   only show top N samples by absolute diff',
    ].join('\n'),
  },
  'cli.help.analyze_usage': {
    zh: '用法: omk analyze <dir> [--kb <path>] [--last 7d] [--from ISO] [--to ISO] [--skills name1,name2]',
    en: 'Usage: omk analyze <dir> [--kb <path>] [--last 7d] [--from ISO] [--to ISO] [--skills name1,name2]',
  },
  'cli.help.gold': {
    zh: [
      '',
      '用法: omk bench gold <subcommand>',
      '',
      '子命令:',
      '  init [--out <dir>] [--annotator <id>]    生成空白 gold dataset 模板',
      '  validate <dir>                           校验数据集结构',
      '  compare <reportId> --gold-dir <dir>      与已有 report 计算 α / κ / Pearson',
      '    [--variant <name>] [--reports-dir <d>]',
      '    [--bootstrap-samples N] [--seed N]',
      '',
    ].join('\n'),
    en: [
      '',
      'Usage: omk bench gold <subcommand>',
      '',
      'Subcommands:',
      '  init [--out <dir>] [--annotator <id>]    create a blank gold dataset template',
      '  validate <dir>                           validate dataset structure',
      '  compare <reportId> --gold-dir <dir>      compute α / κ / Pearson against an existing report',
      '    [--variant <name>] [--reports-dir <d>]',
      '    [--bootstrap-samples N] [--seed N]',
      '',
    ].join('\n'),
  },
  'cli.help.debias_validate': {
    zh: [
      '',
      '用法: omk bench debias-validate <kind> <reportId> [options]',
      '',
      '类别:',
      '  length    用相反的长度去偏设置重新评判, 并对分数差出 bootstrap CI。',
      '            judge 成本约为原评判的两倍。',
      '',
      '选项:',
      '  --reports-dir <dir>          报告存储目录 (默认: ~/.oh-my-knowledge/reports)',
      '  --samples <path>             覆盖用例文件 (默认: 从 report.meta.request 读)',
      '  --variant <name>             校验哪个 variant (默认: 第一个)',
      '  --judge-executor <name>      评委调用执行器 (默认: claude)',
      '  --judge-model <model>        评委模型 ID (默认: 沿用 report)',
      '  --bootstrap-samples N        bootstrap 迭代次数 (默认 1000)',
      '  --seed N                     固定 CI 随机种子',
      '',
    ].join('\n'),
    en: [
      '',
      'Usage: omk bench debias-validate <kind> <reportId> [options]',
      '',
      'Kinds:',
      '  length    re-judge with the opposite length-debias setting and bootstrap CI',
      '            on the score diff. Cost ~doubles vs the original judge pass.',
      '',
      'Options:',
      '  --reports-dir <dir>          report store dir (default: ~/.oh-my-knowledge/reports)',
      '  --samples <path>             override samples file (default: from report.meta.request)',
      '  --variant <name>             which variant to validate (default: first)',
      '  --judge-executor <name>      executor for judge calls (default: claude)',
      '  --judge-model <model>        judge model id (default: from report)',
      '  --bootstrap-samples N        bootstrap iterations (default 1000)',
      '  --seed N                     deterministic CI seed',
      '',
    ].join('\n'),
  },
  'cli.help.saturation': {
    zh: [
      '',
      '用法: omk bench saturation <reportId> [options]',
      '',
      '回答 "我跑够用例了吗?"。复述已有 report 中持久化的饱和判定。',
      '',
      '注: 本命令读取 run 时跑出的 verdict (运行时已用 method=bootstrap-ci-width',
      '默认阈值 + 3 窗口持续条件)。如要换 method/threshold 重新计算, 需要重跑',
      '`omk bench run --repeat ≥ 5` (运行时持久化的 trace 不含原始分数, 无法',
      '在事后用其他参数复算)。',
      '',
      '选项:',
      '  --reports-dir <dir>   报告存储目录 (默认: ~/.oh-my-knowledge/reports)',
      '  --variant <name>      只看一个 variant (默认: 全部)',
      '',
    ].join('\n'),
    en: [
      '',
      'Usage: omk bench saturation <reportId> [options]',
      '',
      'Answers "do I have enough samples?". Replays the saturation verdict',
      'persisted in an existing report.',
      '',
      'Note: this command reads the verdict computed at run time (which used',
      'method=bootstrap-ci-width with default threshold + 3-window sustained',
      'condition). To re-compute with a different method/threshold, re-run',
      '`omk bench run --repeat ≥ 5` (the persisted trace does not include raw',
      'scores, so post-hoc parameter sweeps are not possible here).',
      '',
      'Options:',
      '  --reports-dir <dir>   report store dir (default: ~/.oh-my-knowledge/reports)',
      '  --variant <name>      only show one variant (default: all)',
      '',
    ].join('\n'),
  },
  'cli.help.verdict': {
    zh: [
      '',
      '用法: omk bench verdict <reportId> [options]',
      '',
      '聚合 bootstrap CI / 三层 ci-gate / saturation / human α, 给出一行结论。',
      '',
      'Verdict 等级:',
      '  PROGRESS      显著改进 + 三层全过',
      '  CAUTIOUS      改进真实但有警告 (gate 破 / 幅度太小 / 控制组本身崩)',
      '  REGRESS       显著回退 — 不要 ship',
      '  NOISE         CI 跨 0, 无法判定',
      '  UNDERPOWERED  用例不足, 需要扩 N 重测',
      '  SOLO          单 variant 报告, 没有对比对象',
      '',
      '选项:',
      '  --reports-dir <dir>      报告存储目录 (默认: ~/.oh-my-knowledge/reports)',
      '  --threshold <num>        三层 gate 阈值 (默认 3.5, 与 omk bench gate 对齐)',
      '  --trivial-diff <num>     "幅度太小" 阈值 (默认 0.1)',
      '  --verbose                展开每个 pair 的详情',
      '',
    ].join('\n'),
    en: [
      '',
      'Usage: omk bench verdict <reportId> [options]',
      '',
      'Aggregates bootstrap CI / 3-layer ci-gate / saturation / human α into a one-line verdict.',
      '',
      'Verdict levels:',
      '  PROGRESS      significant improvement + all 3 layers pass',
      '  CAUTIOUS      real improvement but with warnings (gate fails / diff too small / control collapsed)',
      '  REGRESS       significant regression — do not ship',
      '  NOISE         CI crosses 0, no verdict',
      '  UNDERPOWERED  not enough samples, expand N and re-run',
      '  SOLO          single-variant report, nothing to compare against',
      '',
      'Options:',
      '  --reports-dir <dir>      report store dir (default: ~/.oh-my-knowledge/reports)',
      '  --threshold <num>        3-layer gate threshold (default 3.5, matches omk bench gate)',
      '  --trivial-diff <num>     "diff too small" threshold (default 0.1)',
      '  --verbose                expand per-pair details',
      '',
    ].join('\n'),
  },
  'cli.help.diagnose': {
    zh: [
      '',
      '用法: omk bench diagnose <reportId> [options]',
      '',
      '诊断用例集本身的质量问题: 区分度低 / 重复 / 歧义 / 成本异常 / 全 fail。',
      '回答 "测评结论是否被坏用例污染" — 与 omk bench verdict 互补。',
      '',
      '选项:',
      '  --reports-dir <dir>      报告存储目录',
      '  --samples <path>         用例文件路径 (用于 near-duplicate 检测; 默认从 report.meta.request 读)',
      '  --top <n>                每类只显示前 N 个 (默认 10, 0=全部)',
      '  --duplicate-rouge <num>  near-duplicate ROUGE-1 阈值 (默认 0.7)',
      '  --ambiguous-stddev <num> 歧义阈值, judge stddev (默认 1.0, 需要 --judge-repeat ≥ 2 数据)',
      '  --cost-k <num>           成本异常倍数 vs 中位数 (默认 3)',
      '  --latency-k <num>        耗时异常倍数 vs 中位数 (默认 3)',
      '  --flat <num>             flat_scores 分差阈值 (默认 0.5)',
      '',
    ].join('\n'),
    en: [
      '',
      'Usage: omk bench diagnose <reportId> [options]',
      '',
      'Diagnose quality issues in the sample set itself: low discrimination /',
      'duplicates / ambiguity / cost anomalies / all-fail. Answers "is the verdict',
      'tainted by bad samples?" — complements omk bench verdict.',
      '',
      'Options:',
      '  --reports-dir <dir>      report store dir',
      '  --samples <path>         sample file path (for near-duplicate detection; defaults to report.meta.request)',
      '  --top <n>                top N per category (default 10, 0=all)',
      '  --duplicate-rouge <num>  near-duplicate ROUGE-1 threshold (default 0.7)',
      '  --ambiguous-stddev <num> ambiguity threshold, judge stddev (default 1.0, requires --judge-repeat ≥ 2)',
      '  --cost-k <num>           cost-outlier multiplier vs median (default 3)',
      '  --latency-k <num>        latency-outlier multiplier vs median (default 3)',
      '  --flat <num>             flat_scores spread threshold (default 0.5)',
      '',
    ].join('\n'),
  },
  'cli.help.failures': {
    zh: [
      '',
      '用法: omk bench failures <reportId> [options]',
      '',
      '把已有 report 的失败用例喂给一次 LLM 调用, 自动聚类并给出修复建议。',
      '失败定义: compositeScore < threshold 或 ok=false。',
      '',
      '选项:',
      '  --reports-dir <dir>      报告存储目录',
      '  --judge-executor <name>  执行器 (默认: claude)',
      '  --judge-model <id>       聚类用的模型 (默认: 沿用 report.meta.judgeModel)',
      '  --max-clusters <n>       最多聚成几类 (默认 5)',
      '  --threshold <num>        compositeScore < threshold 算失败 (默认 3)',
      '  --max-feed <n>           最多喂给 LLM 多少条 (默认 50, 超出取最差)',
      '',
    ].join('\n'),
    en: [
      '',
      'Usage: omk bench failures <reportId> [options]',
      '',
      'Feed failing samples from an existing report to a single LLM call, auto-cluster',
      'them, and produce per-cluster fix suggestions.',
      'Failure definition: compositeScore < threshold or ok=false.',
      '',
      'Options:',
      '  --reports-dir <dir>      report store dir',
      '  --judge-executor <name>  executor (default: claude)',
      '  --judge-model <id>       model for clustering (default: from report.meta.judgeModel)',
      '  --max-clusters <n>       max number of clusters (default 5)',
      '  --threshold <num>        compositeScore < threshold counts as failure (default 3)',
      '  --max-feed <n>           max samples to feed the LLM (default 50, takes the worst)',
      '',
    ].join('\n'),
  },
  // sample design coverage block strings
  'cli.diagnose.coverage_header': {
    zh: '用例设计覆盖度 (Sample design coverage):',
    en: 'Sample design coverage:',
  },
  'cli.diagnose.coverage_unspecified': {
    zh: '(未声明)',
    en: '(unspecified)',
  },
  'cli.diagnose.coverage_chars': {
    zh: '字符',
    en: 'chars',
  },
  'cli.diagnose.coverage_hint_empty': {
    zh: 'ℹ 该用例集未声明任何 capability / difficulty / construct / provenance 元数据。详见 docs/sample-design-spec.md',
    en: 'ℹ No samples in this set declare capability / difficulty / construct / provenance metadata. See docs/sample-design-spec.md',
  },
  'cli.diagnose.coverage_declared': {
    zh: '声明',
    en: 'declared',
  },
};
