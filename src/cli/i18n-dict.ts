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
 *    - 命令名: init, doctor, eval, observe, evolve, sample, studio, gold
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
  | 'cli.common.unknown_domain'
  // init
  | 'cli.init.scaffolded'
  | 'cli.init.next_steps_title'
  | 'cli.init.next_step_edit_samples'
  | 'cli.init.next_step_edit_skills'
  | 'cli.init.next_step_run'
  | 'cli.init.note_codex_executor'
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
  | 'cli.progress.sample_failed_done'
  // eval 参数校验 (parseRunConfig)
  | 'cli.run.invalid_repeat'
  | 'cli.run.invalid_judge_repeat'
  | 'cli.run.no_debias_length_active'
  | 'cli.run.invalid_bootstrap_samples'
  | 'cli.run.bootstrap_samples_too_large'
  | 'cli.run.power_warning_tiny_n'
  | 'cli.run.power_warning_small_n'
  | 'cli.run.power_warning_repeat_one'
  | 'cli.run.dry_run_no_scores'
  // eval 完成 / 报告 server / gold compare / 错误
  | 'cli.run.skill_section'
  | 'cli.run.run_section'
  | 'cli.run.batch_complete'
  | 'cli.run.batch_verdict_header'
  | 'cli.run.batch_child_report_missing'
  | 'cli.run.eval_complete'
  | 'cli.run.tally'
  | 'cli.run.report_saved'
  | 'cli.run.report_only_gate_skipped'
  | 'cli.run.report_server_running'
  | 'cli.run.report_server_view'
  | 'cli.run.report_server_stop'
  | 'cli.run.no_serve_in_non_tty'
  | 'cli.run.no_serve_view_hint'
  | 'cli.run.gold_load_failed'
  | 'cli.run.gold_load_issue'
  | 'cli.run.contamination_warning'
  | 'cli.common.error_prefix'
  // observe
  | 'cli.observe.view_hint'
  // 通用 not-found 错误
  | 'cli.common.skill_dir_not_found'
  | 'cli.common.skill_file_not_found'
  | 'cli.common.report_not_found'
  | 'cli.common.no_judge_model'
  | 'cli.common.judge_models_single_only'
  | 'cli.common.warn_load_samples_failed'
  // studio 操作反馈
  | 'cli.studio.started'
  | 'cli.studio.stop_hint'
  | 'cli.studio.open_failed'
  // improve samples
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
  // improve skill
  | 'cli.evolve.specify_skill_path'
  | 'cli.evolve.section_header'
  | 'cli.evolve.round_baseline'
  | 'cli.evolve.round_error'
  | 'cli.evolve.round_done'
  | 'cli.evolve.summary'
  | 'cli.evolve.best_path'
  | 'cli.evolve.versions_saved'
  | 'cli.evolve.report_link'
  // 长段 help / usage 文案 (multi-line)
  | 'cli.help.product_main'
  | 'cli.help.init_usage'
  | 'cli.help.eval'
  | 'cli.help.eval_gold'
  | 'cli.help.observe'
  | 'cli.help.evolve'
  | 'cli.help.sample'
  | 'cli.help.studio'
  // omk doctor 健康检查 — rule labels
  | 'cli.doctor.rule.skill_readable'
  | 'cli.doctor.rule.skill_metadata'
  | 'cli.doctor.rule.dependencies'
  | 'cli.doctor.rule.samples_contract'
  // doctor — pass messages
  | 'cli.doctor.skill_readable.pass'
  | 'cli.doctor.skill_metadata.pass'
  | 'cli.doctor.dependencies.pass'
  | 'cli.doctor.samples_contract.pass'
  // doctor — skill_readable rule
  | 'cli.doctor.skill_readable.fail.missing'
  | 'cli.doctor.skill_readable.fail.empty'
  | 'cli.doctor.skill_readable.fail.too_short'
  | 'cli.doctor.skill_readable.hint.missing'
  | 'cli.doctor.dependencies.hint.tool'
  | 'cli.doctor.dependencies.hint.file'
  | 'cli.doctor.dependencies.hint.env'
  | 'cli.doctor.dependencies.hint.preflight'
  | 'cli.doctor.dependencies.issue.tool_not_found'
  | 'cli.doctor.dependencies.issue.file_not_found'
  | 'cli.doctor.dependencies.issue.env_not_set'
  | 'cli.doctor.dependencies.issue.preflight_failed'
  | 'cli.doctor.skill_readable.hint.too_short'
  // doctor — skill_metadata rule
  | 'cli.doctor.skill_metadata.fail.frontmatter_invalid'
  | 'cli.doctor.skill_metadata.fail.missing_skillmd'
  | 'cli.doctor.skill_metadata.hint.frontmatter'
  | 'cli.doctor.skill_metadata.hint.missing_skillmd'
  // doctor — dependencies rule
  | 'cli.doctor.dependencies.fail'
  // doctor — samples_contract rule
  | 'cli.doctor.samples_contract.skipped'
  | 'cli.doctor.samples_contract.warn.empty'
  | 'cli.doctor.samples_contract.warn.missing_prompt'
  | 'cli.doctor.samples_contract.hint'
  // omk doctor — CLI level
  | 'cli.help.doctor_usage'
  | 'cli.doctor.no_skill_found'
  | 'cli.doctor.samples_detected'
  | 'cli.doctor.gate_blocked'
  | 'cli.run.skip_connectivity_warning';

export interface CliMessage {
  zh: string;
  en: string;
}

export const CLI_DICT: Record<CliMessageKey, CliMessage> = {
  'cli.common.unknown_domain': {
    zh: "未知命令：{domain}。运行 'omk --help' 查看可用命令。",
    en: "Unknown command: {domain}. Run 'omk --help' to see available commands.",
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
    zh: '  1. 编辑 eval-samples.json，加入你要测的评测用例',
    en: '  1. Edit eval-samples.json to add your test cases',
  },
  'cli.init.next_step_edit_skills': {
    zh: '  2. 编辑 skills/code-review-v1/SKILL.md 和 skills/code-review-v2/SKILL.md, 为两个 skill 版本填入实际内容',
    en: '  2. Edit skills/code-review-v1/SKILL.md and skills/code-review-v2/SKILL.md with your skill versions',
  },
  'cli.init.next_step_run': {
    zh: '  3. 运行: omk eval --control code-review-v1 --treatment code-review-v2',
    en: '  3. Run: omk eval --control code-review-v1 --treatment code-review-v2',
  },
  'cli.init.note_codex_executor': {
    zh: '\n注: omk 评测时把 SKILL.md 整文(含 frontmatter)作为 system prompt 注入 — 跨 executor 一致(claude / codex / openai-api / gemini 都走同一条路径,不依赖任何 executor 的 native skill auto-discovery 或 Skill 工具机制)。frontmatter 在 prompt 头部对 model 行为无显著影响。\n模板带 Claude Code 兼容的 frontmatter(name + description)是为了让同一份 directory-skill 也能 deploy 到 Claude Code:把整个目录复制到 ~/.claude/skills/code-review-v1/(整目录,不是单个 SKILL.md),Claude SDK 才能识别。这是 omk 评测之外的 bonus,一份文件双向 dogfood。',
    en: '\nNote: during omk evaluation the full SKILL.md (frontmatter included) is injected as the system prompt — uniformly across executors (claude / codex / openai-api / gemini all take the same path; omk does not rely on any executor\'s native skill auto-discovery or Skill tool). Frontmatter has no measurable impact on model behavior in this position.\nThe template ships with Claude Code-compatible frontmatter (name + description) so the same directory-skill can also be deployed to Claude Code: copy the whole directory to ~/.claude/skills/code-review-v1/ (the directory, not just SKILL.md) so Claude SDK can recognize it. That is a bonus beyond omk evaluation — one source, two-way dogfood.',
  },
  'cli.update.new_version_available': {
    zh: '\n💡 新版本可用: {old} → {new}, 运行 npm update {pkg} -g 升级\n\n',
    en: '\n💡 New version available: {old} → {new}, run npm update {pkg} -g to upgrade\n\n',
  },
  'cli.run.power_warning_tiny_n': {
    zh: '⚠ N={n} < 5：仅适合探索，任何结论都不可靠，CI 会很宽。需要决策时建议 ≥20 条评测用例。',
    en: '⚠ N={n} < 5 (exploration-only): any conclusion is unreliable, CI will be uselessly wide. Decisions need ≥20 cases.',
  },
  'cli.run.power_warning_small_n': {
    zh: '⚠ N={n} < 20：只能识别很大的效果（Cohen\'s d > 0.8），中等效果（d ≈ 0.5）很难检出。要做可靠决策建议 ≥20 条评测用例。',
    en: '⚠ N={n} < 20 (large-effect-only, Cohen\'s d > 0.8): medium effects (d ≈ 0.5) hard to detect. For confident decisions consider ≥20 cases.',
  },
  'cli.run.power_warning_repeat_one': {
    zh: '⚠ --repeat=1：单轮评测无法测稳定性（CV 会标记为未测量）。用 --repeat 3+ 检测同一 variant 内部方差。',
    en: '⚠ --repeat=1: single-run cannot measure stability (CV will be marked "not measured"). Use --repeat 3+ to detect within-variant variance.',
  },
  'cli.run.dry_run_no_scores': {
    zh: 'eval dry-run：仅预览任务，不检查分数',
    en: 'Eval dry-run: no scores to check',
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
    zh: '[{i}/{n}] {sample}/{variant} ⚠️ {error}\n',
    en: '[{i}/{n}] {sample}/{variant} ⚠️ {error}\n',
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
  'cli.progress.sample_failed_done': {
    zh: '[{i}/{n}] {sample}/{variant} ⚠️ {ms}ms {input}+{output} tokens{cost} error={error}\n',
    en: '[{i}/{n}] {sample}/{variant} ⚠️ {ms}ms {input}+{output} tokens{cost} error={error}\n',
  },
  'cli.run.invalid_repeat': {
    zh: '⚠ --repeat "{value}" 无效 (期望 ≥ 1 的整数), 已按 1 次评测执行\n',
    en: '⚠ --repeat "{value}" is invalid (expected an integer ≥ 1), falling back to 1 run\n',
  },
  'cli.run.invalid_judge_repeat': {
    zh: '⚠ --judge-repeat "{value}" 无效 (期望 ≥ 1 的整数), 已按 1 次 judge 执行\n',
    en: '⚠ --judge-repeat "{value}" is invalid (expected an integer ≥ 1), falling back to 1 judge call\n',
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
  'cli.run.batch_verdict_header': {
    zh: '批量评测结论：{status}（{passed}/{total} 通过）',
    en: 'Batch verdict: {status} ({passed}/{total} passed)',
  },
  'cli.run.batch_child_report_missing': {
    zh: '⚠ 子报告缺失：{id}，将按不可 ship 处理。\n',
    en: '⚠ Child report missing: {id}; treating it as not shippable.\n',
  },
  'cli.run.eval_complete': {
    zh: '\n✅ 评测完成\n',
    en: '\n✅ Evaluation done\n',
  },
  'cli.run.tally': {
    zh: '试次: {passed} ✓ / {failed} ⚠️\n',
    en: 'Trials: {passed} ✓ / {failed} ⚠️\n',
  },
  'cli.run.report_saved': {
    zh: '📄 报告已保存到: {path}\n',
    en: '📄 Report saved to: {path}\n',
  },
  'cli.run.report_only_gate_skipped': {
    zh: 'ℹ 已启用 report-only 模式：保留 verdict 输出，但本次不使用 verdict 改写 exit code。\n',
    en: 'ℹ Report-only mode enabled: verdict is still printed, but it will not affect the exit code.\n',
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
    zh: '   查看报告：omk studio --reports-dir {dir}（报告 ID：{id}）\n',
    en: '   View report: omk studio --reports-dir {dir} (report id: {id})\n',
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
    zh: '❌ 错误: {message}',
    en: '❌ Error: {message}',
  },
  'cli.observe.view_hint': {
    zh: '分析 JSON 已写入 output-dir；后续可用 omk observe 持续生成日报。',
    en: 'Analysis JSON written to output-dir; use omk observe to keep producing health reports.',
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
    zh: '未指定评委。请加 --judge-models <executor:model>, 或确保 report.meta.judgeModels 已写。',
    en: 'No judge configured. Pass --judge-models <executor:model> or ensure the report has meta.judgeModels.',
  },
  'cli.common.judge_models_single_only': {
    zh: '{cmd} 仅支持单评委。--judge-models 只能传一个 executor:model entry。',
    en: '{cmd} only supports a single judge. --judge-models accepts exactly one executor:model entry.',
  },
  'cli.common.warn_load_samples_failed': {
    zh: '⚠ 加载 samples 文件失败 ({path}): {message}\n',
    en: '⚠ Failed to load samples file ({path}): {message}\n',
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
  'cli.gen.skill_skipped_existing': {
    zh: '⏭️  {name}: eval-samples 已存在, 跳过\n',
    en: '⏭️  {name}: eval-samples already exists, skipping\n',
  },
  'cli.gen.skill_generating': {
    zh: '🔄 {name}: 正在生成 {count} 条评测用例...\n',
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
    zh: '\n共生成 {n} 份 eval-samples, 请审查后运行: omk eval --batch',
    en: '\nGenerated {n} eval-samples files. Review them, then run: omk eval --batch',
  },
  'cli.gen.specify_skill_path': {
    zh: '请指定 skill 文件路径, 例如: omk sample skills/my-skill.md',
    en: 'Please specify a skill file path, e.g.: omk sample skills/my-skill.md',
  },
  'cli.gen.samples_already_exists': {
    zh: 'eval-samples.json 已存在。如需覆盖请先删除该文件。',
    en: 'eval-samples.json already exists. Delete it first if you want to overwrite.',
  },
  'cli.gen.single_generating': {
    zh: '🔄 正在生成 {count} 条评测用例...\n',
    en: '🔄 Generating {count} test cases...\n',
  },
  'cli.gen.single_done': {
    zh: '✅ 已生成 {n} 条用例 → {path}{cost}\n',
    en: '✅ Generated {n} samples → {path}{cost}\n',
  },
  'cli.gen.review_hint': {
    zh: '\n请审查生成的评测用例后运行: omk eval',
    en: '\nReview the generated test cases, then run: omk eval',
  },
  'cli.gen.failed': {
    zh: '生成失败: {message}',
    en: 'Generation failed: {message}',
  },
  'cli.evolve.specify_skill_path': {
    zh: '请指定 skill 文件路径, 例如: omk evolve skills/my-skill.md',
    en: 'Please specify a skill file path, e.g.: omk evolve skills/my-skill.md',
  },
  'cli.evolve.section_header': {
    zh: '\n=== Improve skill: {path} ===\n',
    en: '\n=== Improve skill: {path} ===\n',
  },
  'cli.evolve.round_baseline': {
    zh: '第 0 轮 (基线): score={score} ({cost})\n',
    en: 'Round 0 (baseline): score={score} ({cost})\n',
  },
  'cli.evolve.round_error': {
    zh: '第 {round} 轮: ✗ 改进生成失败: {error}\n',
    en: 'Round {round}: ✗ improvement generation failed: {error}\n',
  },
  'cli.evolve.round_done': {
    zh: '第 {round} 轮: score={score} ({delta}) {status} ({cost})\n',
    en: 'Round {round}: score={score} ({delta}) {status} ({cost})\n',
  },
  'cli.evolve.summary': {
    zh: '\n✅ {start} → {final} (+{percent}%) | 共 {rounds} 轮 | {cost}\n',
    en: '\n✅ {start} → {final} (+{percent}%) | {rounds} rounds | {cost}\n',
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
    zh: '📊 查看报告：omk studio（报告 ID：{id}）\n',
    en: '📊 View report: omk studio (report id: {id})\n',
  },
  'cli.help.product_main': {
    zh: `
oh-my-knowledge — 知识载体工作台

用法：
  omk init [dir]                      初始化一个 skill 评测项目
  omk doctor [path]                   静态健康检查：结构、依赖、样本、配置、污染风险
  omk eval [options]                  离线评测：比较版本，输出 verdict + report
  omk observe <sessions-dir>          线上观测：真实 session、gap、失败率、inbox
  omk evolve <skill>                  多轮自动迭代改进 skill
  omk sample <skill>                  生成或补齐 eval-samples 评测用例（或 --batch 批量模式）
  omk studio                          打开本地工作台浏览报告

主路径：
  omk doctor
  omk eval --control code-review-v1 --treatment code-review-v2
  omk observe ~/.claude/projects/<project>
  omk evolve skills/code-review-v2/SKILL.md
  omk studio

通用选项：
  --lang <zh|en>                      CLI 输出语言（默认：zh，也可设 OMK_LANG）

运行 'omk <command> --help' 查看单个命令的参数。
`,
    en: `
oh-my-knowledge — Knowledge Artifact Workbench

Usage:
  omk init [dir]                      Scaffold a skill evaluation project
  omk doctor [path]                   Static health check: structure, deps, samples, config, contamination risk
  omk eval [options]                  Offline evaluation: compare versions, emit verdict + report
  omk observe <sessions-dir>          Production observation: sessions, gaps, failure rate, inbox
  omk evolve <skill>                  Auto-iterate a skill through multi-round eval loops
  omk sample <skill>                  Generate or fill eval-samples test cases (or --batch for all skills)
  omk studio                          Open the local workbench to browse reports

Main workflow:
  omk doctor
  omk eval --control code-review-v1 --treatment code-review-v2
  omk observe ~/.claude/projects/<project>
  omk evolve skills/code-review-v2/SKILL.md
  omk studio

Common options:
  --lang <zh|en>                      CLI output language (default: zh, or set OMK_LANG)

Run 'omk <command> --help' for command-specific options.
`,
  },
  'cli.help.init_usage': {
    zh: `
omk init — 初始化 skill 评测项目

用法：
  omk init [dir]

生成内容：
  eval-samples.json                  示例评测用例
  skills/code-review-v1/SKILL.md     基线 skill
  skills/code-review-v2/SKILL.md     实验组 skill

下一步：
  1. 编辑 eval-samples.json，替换成你的真实评测用例
  2. 编辑两个 SKILL.md，填入要对比的 skill 版本
  3. 运行 omk eval --control code-review-v1 --treatment code-review-v2
`,
    en: `
omk init — scaffold a skill evaluation project

Usage:
  omk init [dir]

Generated files:
  eval-samples.json                  Example test cases
  skills/code-review-v1/SKILL.md     Baseline skill
  skills/code-review-v2/SKILL.md     Treatment skill

Next steps:
  1. Edit eval-samples.json with your real test cases
  2. Edit both SKILL.md files with the skill versions to compare
  3. Run omk eval --control code-review-v1 --treatment code-review-v2
`,
  },
  'cli.help.eval': {
    zh: `
omk eval — 离线评测 skill 版本，并给出 ship/no-ship verdict

用法：
  omk eval --control <variant> --treatment <variant> [options]
  omk eval gold <init|validate|compare> ...

常用选项：
  --samples <path>                    用例文件（默认：eval-samples.json）
  --skill-dir <path>                  skill 目录（默认：skills）
  --control <expr>                    对照组 variant
  --treatment <v1,v2>                 实验组 variant，逗号分隔
  --config <path>                     eval.yaml / JSON 配置
  --executor <name>                   执行器：claude / claude-sdk / codex / openai / gemini / custom
  --model <name>                      任务执行模型（默认：sonnet）
  --judge-models <list>               评委配置，例如 claude:haiku 或 claude:opus,openai:gpt-4o
  --dry-run                           预览任务，不调用模型
  --batch                             批量评测：每个 skill 独立 vs baseline
  --bootstrap                         显式开启 bootstrap CI；omk eval 默认会自动开启
  --bootstrap-samples <n>             bootstrap 重采样次数（默认：1000）
  --threshold <number>                三层 gate 阈值（默认：3.5）
  --trivial-diff <number>             实际可忽略 diff（默认：0.1）
  --report-only / --no-gate           生成报告并打印 verdict，但始终 exit 0
  --no-serve                          评测后不自动启动报告 server

示例：
  omk eval --control code-review-v1 --treatment code-review-v2
  omk eval --config eval.yaml
  omk eval gold compare v1-vs-v2-20260505-1200 --gold-dir gold-dataset
`,
    en: `
omk eval — run offline skill evaluation and emit a ship/no-ship verdict

Usage:
  omk eval --control <variant> --treatment <variant> [options]
  omk eval gold <init|validate|compare> ...

Common options:
  --samples <path>                    Sample file (default: eval-samples.json)
  --skill-dir <path>                  Skill directory (default: skills)
  --control <expr>                    Control variant
  --treatment <v1,v2>                 Treatment variants, comma-separated
  --config <path>                     eval.yaml / JSON config
  --executor <name>                   Executor: claude / claude-sdk / codex / openai / gemini / custom
  --model <name>                      Task execution model (default: sonnet)
  --judge-models <list>               Judge config, e.g. claude:haiku or claude:opus,openai:gpt-4o
  --dry-run                           Preview tasks without model calls
  --batch                             Batch evaluation: each skill independently against baseline
  --bootstrap                         Enable bootstrap CI explicitly; omk eval turns it on by default
  --bootstrap-samples <n>             Bootstrap resamples (default: 1000)
  --threshold <number>                Three-layer gate threshold (default: 3.5)
  --trivial-diff <number>             Practically negligible diff (default: 0.1)
  --report-only / --no-gate           Produce the report and print verdict, but always exit 0
  --no-serve                          Do not auto-start report server after evaluation

Examples:
  omk eval --control code-review-v1 --treatment code-review-v2
  omk eval --config eval.yaml
  omk eval gold compare v1-vs-v2-20260505-1200 --gold-dir gold-dataset
`,
  },
  'cli.help.eval_gold': {
    zh: `
omk eval gold — 管理 human-gold 标注集

用法：
  omk eval gold init [--out <dir>] [--annotator <name>]
  omk eval gold validate <dir>
  omk eval gold compare <reportId> --gold-dir <dir>

选项：
  --reports-dir <path>                报告目录（compare 使用，默认：~/.oh-my-knowledge/reports）
  --variant <name>                    指定 report 中要对比的 variant
  --bootstrap-samples <n>             bootstrap 重采样次数（compare 使用）
`,
    en: `
omk eval gold — manage human-gold annotation datasets

Usage:
  omk eval gold init [--out <dir>] [--annotator <name>]
  omk eval gold validate <dir>
  omk eval gold compare <reportId> --gold-dir <dir>

Options:
  --reports-dir <path>                Reports directory for compare (default: ~/.oh-my-knowledge/reports)
  --variant <name>                    Variant in the report to compare
  --bootstrap-samples <n>             Bootstrap resamples for compare
`,
  },
  'cli.help.observe': {
    zh: `
omk observe — 分析真实 session trace，生成 skill 健康度日报

用法：
  omk observe <sessions-dir> [options]

选项：
  --kb <path>                         知识库根路径（默认：从 trace cwd 推断）
  --last <duration>                   时间窗口，例如 7d / 24h / 30m
  --from <iso>                        窗口起点，优先级高于 --last
  --to <iso>                          窗口终点，优先级高于 --last
  --skills <n1,n2,...>                只分析指定 skill
  --output-dir <path>                 输出目录（默认：~/.oh-my-knowledge/analyses）
`,
    en: `
omk observe — analyze production session traces and produce skill health reports

Usage:
  omk observe <sessions-dir> [options]

Options:
  --kb <path>                         Knowledge base root (default: infer from trace cwd)
  --last <duration>                   Time window, e.g. 7d / 24h / 30m
  --from <iso>                        Window start, overrides --last
  --to <iso>                          Window end, overrides --last
  --skills <n1,n2,...>                Only analyze selected skills
  --output-dir <path>                 Output directory (default: ~/.oh-my-knowledge/analyses)
`,
  },
  'cli.help.evolve': {
    zh: `
omk evolve — 多轮自动迭代改进 skill

用法：
  omk evolve <skill-path> [options]

选项：
  --rounds <n>                        迭代轮数（默认：3）
  --target <score>                    目标分数
  --model <name>                      改进模型
  --judge-models <executor:model>     单评委配置

示例：
  omk evolve skills/code-review/SKILL.md
  omk evolve skills/code-review/SKILL.md --rounds 10 --target 4.5
`,
    en: `
omk evolve — auto-iterate a skill through multi-round evaluation loops

Usage:
  omk evolve <skill-path> [options]

Options:
  --rounds <n>                        Iteration rounds (default: 3)
  --target <score>                    Target score
  --model <name>                      Improvement model
  --judge-models <executor:model>     Single judge config

Examples:
  omk evolve skills/code-review/SKILL.md
  omk evolve skills/code-review/SKILL.md --rounds 10 --target 4.5
`,
  },
  'cli.help.sample': {
    zh: `
omk sample — 生成或补齐 eval-samples 评测用例

用法：
  omk sample <skill-path> [options]
  omk sample --batch [--skill-dir <dir>] [options]

选项：
  --count <n>                         生成用例数量（默认：5）
  --model <name>                      生成模型（默认：sonnet）
  --batch                             为 skill 目录下缺少 eval-samples 的 skill 批量生成
  --skill-dir <path>                  skill 目录（batch 使用，默认：skills）
`,
    en: `
omk sample — generate or fill eval-samples test cases

Usage:
  omk sample <skill-path> [options]
  omk sample --batch [--skill-dir <dir>] [options]

Options:
  --count <n>                         Number of test cases to generate (default: 5)
  --model <name>                      Generation model (default: sonnet)
  --batch                             Generate for skills that are missing eval-samples
  --skill-dir <path>                  Skill directory for batch mode (default: skills)
`,
  },
  'cli.help.studio': {
    zh: `
omk studio — 打开本地知识工作台

用法：
  omk studio [options]

选项：
  --port <n>                          本地服务端口（默认：7799）
  --reports-dir <path>                报告目录（默认：~/.oh-my-knowledge/reports）
  --analyses-dir <path>               观测分析目录
  --no-open                           只启动服务，不自动打开浏览器
  --dev                               开发模式：文件变化时自动重启

示例：
  omk studio
  omk studio --port 7798
  omk studio --no-open
`,
    en: `
omk studio — open the local knowledge workbench

Usage:
  omk studio [options]

Options:
  --port <n>                          Local server port (default: 7799)
  --reports-dir <path>                Reports directory (default: ~/.oh-my-knowledge/reports)
  --analyses-dir <path>               Observation analyses directory
  --no-open                           Start the server without opening a browser
  --dev                               Dev mode: restart on file changes

Examples:
  omk studio
  omk studio --port 7798
  omk studio --no-open
`,
  },
  // ============ omk doctor 健康检查 ============
  'cli.doctor.rule.skill_readable': {
    zh: 'skill 文件可读',
    en: 'skill file readable',
  },
  'cli.doctor.rule.skill_metadata': {
    zh: 'skill 元数据合法',
    en: 'skill metadata valid',
  },
  'cli.doctor.rule.dependencies': {
    zh: '前置依赖完整',
    en: 'dependencies present',
  },
  'cli.doctor.rule.samples_contract': {
    zh: '用例 ↔ skill 输入约定',
    en: 'samples ↔ skill contract',
  },
  // pass
  'cli.doctor.skill_readable.pass': {
    zh: 'skill 内容长度 {length} 字符',
    en: 'skill content {length} chars',
  },
  'cli.doctor.skill_metadata.pass': {
    zh: '元数据格式合法',
    en: 'metadata format valid',
  },
  'cli.doctor.dependencies.pass': {
    zh: '依赖检查通过',
    en: 'all dependencies present',
  },
  'cli.doctor.samples_contract.pass': {
    zh: '用例 {count} 条,prompt 字段齐全',
    en: '{count} samples, all with prompt',
  },
  // skill_readable
  'cli.doctor.skill_readable.fail.missing': {
    zh: 'skill 文件无内容(content 为空)',
    en: 'skill file has no content (content is null)',
  },
  'cli.doctor.skill_readable.fail.empty': {
    zh: 'skill 文件 trim 后为空',
    en: 'skill file is empty after trim',
  },
  'cli.doctor.skill_readable.fail.too_short': {
    zh: 'skill 内容过短(只有 {length} 字符,最低 10)',
    en: 'skill content too short ({length} chars, minimum 10)',
  },
  'cli.doctor.skill_readable.hint.missing': {
    zh: 'skill 文件未读到内容(尝试路径: {path})。用 `ls -la {path}` 确认文件存在,用 `cat {path}` 确认可读且非空',
    en: 'no content read from skill (tried path: {path}). Run `ls -la {path}` to verify it exists and `cat {path}` to confirm it is readable and non-empty',
  },
  'cli.doctor.skill_readable.hint.too_short': {
    zh: 'skill 至少需要写一句完整的指令,过短的内容评测出来无意义',
    en: 'a skill needs at least a full instruction sentence — too short content yields meaningless eval',
  },
  // skill_metadata
  'cli.doctor.skill_metadata.fail.frontmatter_invalid': {
    zh: 'front-matter 格式错误: {error}',
    en: 'front-matter format error: {error}',
  },
  'cli.doctor.skill_metadata.fail.missing_skillmd': {
    zh: 'directory-skill 缺少 SKILL.md 入口文件',
    en: 'directory-skill missing SKILL.md entry file',
  },
  'cli.doctor.skill_metadata.hint.frontmatter': {
    zh: 'front-matter 用 YAML 语法,key: value 或 - item 形式。可参考 examples/multi-skills 下的 skill 写法',
    en: 'front-matter uses YAML syntax (key: value or - item). See examples/multi-skills for reference',
  },
  'cli.doctor.skill_metadata.hint.missing_skillmd': {
    zh: 'directory-skill 必须有 SKILL.md 文件作为入口。或将 skill 写成单文件 .md',
    en: 'directory-skills require a SKILL.md entry file. Alternatively, write the skill as a single .md file',
  },
  // dependencies
  'cli.doctor.dependencies.fail': {
    zh: '前置依赖检查失败: {summary}',
    en: 'dependency check failed: {summary}',
  },
  'cli.doctor.dependencies.hint.tool': {
    zh: '工具缺失: 安装到 PATH 或更新 skill 的 requires.tools 引用名',
    en: 'missing tool: install it on PATH or update skill\'s requires.tools entry',
  },
  'cli.doctor.dependencies.hint.file': {
    zh: '文件缺失: 检查路径是否相对 skill 目录正确,或更新 skill 的 requires.files 引用',
    en: 'missing file: verify path is relative to skill dir, or update skill\'s requires.files entry',
  },
  'cli.doctor.dependencies.hint.env': {
    zh: '环境变量缺失: 在 .env / shell profile 里 export,或在 CI secrets 中配置',
    en: 'missing env: export it in .env / shell profile, or configure it in CI secrets',
  },
  'cli.doctor.dependencies.hint.preflight': {
    zh: 'preflight 命令失败: 看上面的失败原因定位根因,或调整 skill 的 preflight 命令',
    en: 'preflight command failed: read the failure reason above, or adjust the skill\'s preflight command',
  },
  // Per-issue translated lines. dep-checker emits structured reasonCode +
  // reasonDetail (untranslated raw stderr / cwd) so doctor can localize per ctx.lang.
  'cli.doctor.dependencies.issue.tool_not_found': {
    zh: '工具 {name} 未找到 (不在 PATH 中)',
    en: 'tool {name} not found on PATH',
  },
  'cli.doctor.dependencies.issue.file_not_found': {
    zh: '文件 {name} 不存在 (cwd: {detail})',
    en: 'file {name} not found (cwd: {detail})',
  },
  'cli.doctor.dependencies.issue.env_not_set': {
    zh: '环境变量 {name} 未设置',
    en: 'env var {name} not set',
  },
  'cli.doctor.dependencies.issue.preflight_failed': {
    zh: 'preflight 命令 "{name}" 执行失败: {detail}',
    en: 'preflight command "{name}" failed: {detail}',
  },
  // samples_contract
  'cli.doctor.samples_contract.skipped': {
    zh: '未提供 samples,跳过此项检查',
    en: 'no samples provided, skipped',
  },
  'cli.doctor.samples_contract.warn.empty': {
    zh: 'samples 列表为空',
    en: 'samples list is empty',
  },
  'cli.doctor.samples_contract.warn.missing_prompt': {
    zh: '{count} 条用例缺 prompt 字段',
    en: '{count} samples missing prompt field',
  },
  'cli.doctor.samples_contract.hint': {
    zh: '用例必须至少包含 prompt 字段。详见 docs/sample-design-spec.md',
    en: 'samples must contain at least a prompt field. See docs/sample-design-spec.md',
  },
  // ============ omk doctor CLI level ============
  'cli.help.doctor_usage': {
    zh: `
oh-my-knowledge — omk doctor 健康检查

用法:
  omk doctor [path]                    在 path 上跑评测前置健康检查
  omk doctor                           在当前目录(或 ./skills)批量跑

参数:
  path                   .md 单文件、目录或省略(=cwd)。目录会批量检查所有 skill

选项:
  --json                 把 DoctorReport 打到 stdout(CI 消费用)
  --gate                 静默模式: 通过 exit 0 / 不通过 exit 1, 仅 stderr 出问题摘要
  --executor <name>      executor 名(仅向后兼容, doctor 不直接打 LLM)
  --model <name>         model 名(同上)
  --samples <path>       显式指定评测用例文件
  --timeout <seconds>    rule 执行超时(默认 8)
  --lang <zh|en>         切换输出语言

示例:
  omk doctor examples/code-review/skills/v1.md
  omk doctor examples/code-review/skills --json | jq .outcome  # passed | warnings_only | failed
  omk doctor --gate; echo $?

doctor 检查项(纯静态 / 零 LLM 调用):
  - skill 文件可读 + 内容有最小长度
  - skill 元数据合法 (front-matter 若有)
  - 前置依赖完整 (引用的 CLI 工具 / 文件 / 环境变量 / preflight 命令)
  - 用例 ↔ skill 输入约定 (warn 级, 仅传 samples 时跑)

executor / judge 连通性由 evaluation preflight 负责, 不在 doctor 范围内。
omk eval 内置 doctor 强制门禁, 不可 skip — 静态检查
零成本无理由跳过。LLM 连通性可用 --skip-connectivity 跳过 (--resume 时自动)。
`.trim() + '\n',
    en: `
oh-my-knowledge — omk doctor health check

Usage:
  omk doctor [path]                    Run pre-evaluation health check on path
  omk doctor                           Batch check current dir (or ./skills)

Arguments:
  path                   A .md file, directory, or omit (= cwd). Directory mode batches all skills.

Options:
  --json                 Print DoctorReport JSON to stdout (CI-friendly)
  --gate                 Silent mode: exit 0 if pass, exit 1 if fail; brief stderr summary only
  --executor <name>      executor name (kept for compat; doctor does not call LLM)
  --model <name>         model name (same)
  --samples <path>       Explicit eval samples file
  --timeout <seconds>    per-rule timeout (default 8)
  --lang <zh|en>         Output language

Examples:
  omk doctor examples/code-review/skills/v1.md
  omk doctor examples/code-review/skills --json | jq .outcome  # passed | warnings_only | failed
  omk doctor --gate; echo $?

Checks (pure static / zero LLM calls):
  - skill file readable + minimum content length
  - skill metadata valid (front-matter if present)
  - dependencies present (referenced CLI tools / files / env vars / preflight commands)
  - samples ↔ skill contract (warn-level, only when samples provided)

executor / judge connectivity is handled by evaluation preflight, not doctor.
omk eval runs doctor as mandatory; no skip flag — static
checks cost nothing to run. LLM connectivity can be skipped with --skip-connectivity
(auto-skipped on --resume).
`.trim() + '\n',
  },
  'cli.doctor.no_skill_found': {
    zh: '未在 {path} 下发现 skill 文件。\n  doctor 期望 .md 文件、目录(包含 .md 或 SKILL.md)或 cwd 下的 skills/ 子目录。',
    en: 'No skills found at {path}.\n  doctor expects a .md file, a directory (containing .md or SKILL.md), or skills/ under cwd.',
  },
  'cli.doctor.samples_detected': {
    zh: '✓ 使用评测用例文件：{path}',
    en: '✓ Using eval samples file: {path}',
  },
  'cli.doctor.gate_blocked': {
    zh: 'skill 健康检查未通过, 评测已中止。doctor 是评测必经环节, 无 skip 选项 — 请修复上述问题后重跑。',
    en: 'skill health check failed; evaluation aborted. doctor is mandatory and not skippable — fix the issues above and re-run.',
  },
  'cli.run.skip_connectivity_warning': {
    zh: '⚠️  --skip-connectivity 已启用: 跳过 LLM 模型连通性检测。请确保 executor / judge 已通过其他方式验证可达。',
    en: '⚠️  --skip-connectivity enabled: LLM connectivity check skipped. Verify executor / judge are reachable by other means.',
  },
};
