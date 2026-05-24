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
  | 'cli.common.skill_dir_no_skill_md'
  | 'cli.common.report_not_found'
  | 'cli.common.no_judge_model'
  | 'cli.common.judge_models_single_only'
  | 'cli.common.warn_load_samples_failed'
  // studio 操作反馈
  | 'cli.studio.started'
  | 'cli.studio.stop_hint'
  | 'cli.studio.open_failed'
  // sample (generate eval-samples)
  | 'cli.gen.skill_skipped_existing'
  | 'cli.gen.skill_generating'
  | 'cli.gen.skill_generating_auto'
  | 'cli.gen.skill_done'
  | 'cli.gen.skill_failed'
  | 'cli.gen.batch_none_needed'
  | 'cli.gen.batch_summary'
  | 'cli.gen.specify_skill_path'
  | 'cli.gen.samples_already_exists'
  | 'cli.gen.single_generating'
  | 'cli.gen.single_generating_auto'
  | 'cli.gen.single_done'
  | 'cli.gen.review_hint'
  | 'cli.gen.failed'
  | 'cli.gen.focus_applied'
  // evolve (auto-iterate skill)
  | 'cli.evolve.specify_skill_path'
  | 'cli.evolve.section_header'
  | 'cli.evolve.round_baseline'
  | 'cli.evolve.round_baseline_reused'
  | 'cli.evolve.round_error'
  | 'cli.evolve.round_done'
  | 'cli.evolve.summary'
  | 'cli.evolve.best_path'
  | 'cli.evolve.versions_saved'
  | 'cli.evolve.report_link'
  // observe usage prose（observe.ts 的 ingest/inbox/show sub-dispatch 在 unknown / no-arg 时打）
  | 'cli.help.observe'
  | 'cli.help.observe_ingest'
  | 'cli.help.observe_inbox'
  | 'cli.help.observe_show'
  | 'cli.help.evolve'
  | 'cli.help.sample'
  | 'cli.help.studio'
  // omk doctor — CLI level(其余 doctor 文案归 src/doctor/messages.ts)
  | 'cli.doctor.no_skill_found'
  | 'cli.doctor.samples_detected'
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
    zh: '\n注: omk 评测时把 SKILL.md 整文(含 frontmatter)作为 system prompt 注入——跨 executor 一致(claude / codex / openai-api / gemini 都走同一条路径,不依赖任何 executor 的 native skill auto-discovery 或 Skill 工具机制)。frontmatter 在 prompt 头部对 model 行为无显著影响。\n模板带 Claude Code 兼容的 frontmatter(name + description)是为了让同一份 directory-skill 也能 deploy 到 Claude Code:把整个目录复制到 ~/.claude/skills/code-review-v1/(整目录,不是单个 SKILL.md),Claude SDK 才能识别。这是 omk 评测之外的 bonus,一份文件双向 dogfood。',
    en: '\nNote: during omk evaluation the full SKILL.md (frontmatter included) is injected as the system prompt — uniformly across executors (claude / codex / openai-api / gemini all take the same path; omk does not rely on any executor\'s native skill auto-discovery or Skill tool). Frontmatter has no measurable impact on model behavior in this position.\nThe template ships with Claude Code-compatible frontmatter (name + description) so the same directory-skill can also be deployed to Claude Code: copy the whole directory to ~/.claude/skills/code-review-v1/ (the directory, not just SKILL.md) so Claude SDK can recognize it. That is a bonus beyond omk evaluation — one source, two-way dogfood.',
  },
  'cli.update.new_version_available': {
    zh: '\n💡 新版本可用: {old} → {new}, 运行 npm update {pkg} -g 升级\n\n',
    en: '\n💡 New version available: {old} → {new}, run npm update {pkg} -g to upgrade\n\n',
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
  'cli.common.skill_dir_no_skill_md': {
    zh: '目录下未找到 SKILL.md: {path}',
    en: 'SKILL.md not found in directory: {path}',
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
  'cli.gen.skill_generating_auto': {
    zh: '🔄 {name}: 正在生成评测用例（数量由 LLM 按 skill 类型自动判断）...\n',
    en: '🔄 {name}: generating test cases (count auto-decided by LLM based on skill type)...\n',
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
  'cli.gen.single_generating_auto': {
    zh: '🔄 正在生成评测用例（数量由 LLM 按 skill 类型自动判断）...\n',
    en: '🔄 Generating test cases (count auto-decided by LLM based on skill type)...\n',
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
  'cli.gen.focus_applied': {
    zh: '🎯 场景重点（--focus）：{focus}\n',
    en: '🎯 Focus scenarios (--focus): {focus}\n',
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
    zh: '第 0 轮（基线）：score={score}（{cost}）\n',
    en: 'Round 0 (baseline): score={score} ({cost})\n',
  },
  'cli.evolve.round_baseline_reused': {
    zh: '第 0 轮（基线）：score={score}（复用最新 eval 报告）\n',
    en: 'Round 0 (baseline): score={score} (reused latest eval report)\n',
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
  'cli.help.observe': {
    zh: `
omk observe——分析真实 session trace，生成 skill 健康度日报

用法：
  omk observe <sessions-dir> [options]
  omk observe ingest <sessions-dir> [options]
  omk observe inbox [options]
  omk observe show <inbox_id> [options]

选项：
  --kb <path>                         知识库根路径（默认：从 trace cwd 推断）
  --last <duration>                   时间窗口，例如 7d / 24h / 30m
  --from <iso>                        窗口起点，优先级高于 --last
  --to <iso>                          窗口终点，优先级高于 --last
  --skills <n1,n2,...>                只分析指定 skill
  --output-dir <path>                 输出目录（默认：~/.oh-my-knowledge/analyses）

Inbox:
  ingest --output-dir <path>           写入 observe inbox 数据（默认：.omk/observations；读取时兜底到 ~/.oh-my-knowledge/observations）
  inbox --input-dir <path>             读取 observe inbox 数据
  inbox --limit <n>                    展示 top N（默认：20）
  inbox --skill <name>                 只看指定 skill
  inbox --explore <n>                  从最近 50 条 medium/low 问题里抽样查看长尾
  inbox --include-noise                --explore 时显式包含 noise 桶
  inbox --by-skill                     按 skill 输出资产看板
  inbox --json                         输出 JSON
  show <inbox_id> --input-dir <path>    查看单条 observation 的前后上下文
`,
    en: `
omk observe — analyze production session traces and produce skill health reports

Usage:
  omk observe <sessions-dir> [options]
  omk observe ingest <sessions-dir> [options]
  omk observe inbox [options]
  omk observe show <inbox_id> [options]

Options:
  --kb <path>                         Knowledge base root (default: infer from trace cwd)
  --last <duration>                   Time window, e.g. 7d / 24h / 30m
  --from <iso>                        Window start, overrides --last
  --to <iso>                          Window end, overrides --last
  --skills <n1,n2,...>                Only analyze selected skills
  --output-dir <path>                 Output directory (default: ~/.oh-my-knowledge/analyses)

Inbox:
  ingest --output-dir <path>           Write observe inbox data (default: .omk/observations; read fallback: ~/.oh-my-knowledge/observations)
  inbox --input-dir <path>             Read observe inbox data
  inbox --limit <n>                    Show top N (default: 20)
  inbox --skill <name>                 Only show one skill
  inbox --explore <n>                  Sample long-tail issues from the latest 50 medium/low items
  inbox --include-noise                Explicitly include the noise bucket with --explore
  inbox --by-skill                     Print the skill-level asset board
  inbox --json                         Print JSON
  show <inbox_id> --input-dir <path>    Show context around one observation
`,
  },
  'cli.help.observe_ingest': {
    zh: `
omk observe ingest — 读取真实 session trace，写入 observe inbox 数据

用法：
  omk observe ingest <sessions-dir-or-file> [options]

选项：
  --output-dir <path>                输出目录（默认：.omk/observations；读取时兜底到 ~/.oh-my-knowledge/observations）

支持：
  Claude Code JSONL
  Markdown 对话日志（.log）
`,
    en: `
omk observe ingest — read real session traces and write observe inbox data

Usage:
  omk observe ingest <sessions-dir-or-file> [options]

Options:
  --output-dir <path>                Output directory (default: .omk/observations; read fallback: ~/.oh-my-knowledge/observations)

Supported:
  Claude Code JSONL
  Markdown conversation logs (.log)
`,
  },
  'cli.help.observe_inbox': {
    zh: `
omk observe inbox — 查看已写入的 observe inbox 问题列表

用法：
  omk observe inbox [options]

选项：
  --input-dir <path>                 读取目录（默认：.omk/observations；兜底到 ~/.oh-my-knowledge/observations）
  --limit <n>                        展示 top N（默认：20）
  --skill <name>                     只看指定 skill
  --explore <n>                      从最近 50 条 medium/low 问题里抽样查看长尾
  --include-noise                    --explore 时显式包含 noise 桶
  --by-skill                         按 skill 输出资产看板
  --llm-enhanced-review              显式调用模型进行链路增强复盘
  --model <name>                     LLM 增强复盘使用的模型（默认：sonnet）
  --executor <name>                  LLM 增强复盘使用的执行器
  --refresh                          强制重新生成 LLM 增强复盘
  --json                             输出 JSON
`,
    en: `
omk observe inbox — inspect previously ingested observe inbox items

Usage:
  omk observe inbox [options]

Options:
  --input-dir <path>                 Input directory (default: .omk/observations; fallback: ~/.oh-my-knowledge/observations)
  --limit <n>                        Show top N (default: 20)
  --skill <name>                     Only show one skill
  --explore <n>                      Sample long-tail issues from the latest 50 medium/low items
  --include-noise                    Explicitly include the noise bucket with --explore
  --by-skill                         Print the skill-level asset board
  --llm-enhanced-review              Explicitly run model-based enhanced chain review
  --model <name>                     Model for LLM enhanced review (default: sonnet)
  --executor <name>                  Executor for LLM enhanced review
  --refresh                          Force LLM enhanced review refresh
  --json                             Print JSON
`,
  },
  'cli.help.observe_show': {
    zh: `
omk observe show — 查看单条 observation 的原始上下文

用法：
  omk observe show <inbox_id> [options]

选项：
  --input-dir <path>                 读取目录（默认：.omk/observations；兜底到 ~/.oh-my-knowledge/observations）
`,
    en: `
omk observe show — inspect the raw context around one observation

Usage:
  omk observe show <inbox_id> [options]

Options:
  --input-dir <path>                 Input directory (default: .omk/observations; fallback: ~/.oh-my-knowledge/observations)
`,
  },
  'cli.help.evolve': {
    zh: `
omk evolve——多轮自动迭代改进 skill

用法：
  omk evolve <skill-path> [options]

选项：
  --rounds <n>                        迭代轮数（默认：5）
  --target <score>                    目标分数
  --model <name>                      任务执行模型，每轮跑 eval samples 的被测模型（默认：sonnet）
  --improve-model <name>              skill 改写模型，每轮根据反馈改写 skill 的模型（默认：sonnet）
  --judge-models <executor:model>     单评委配置（默认：claude:haiku）

示例：
  omk evolve skills/code-review/SKILL.md
  omk evolve skills/code-review/SKILL.md --rounds 10 --target 4.5
  omk evolve skills/code-review/SKILL.md --model sonnet --improve-model opus
`,
    en: `
omk evolve — auto-iterate a skill through multi-round evaluation loops

Usage:
  omk evolve <skill-path> [options]

Options:
  --rounds <n>                        Iteration rounds (default: 5)
  --target <score>                    Target score
  --model <name>                      Task executor model — runs eval samples each round (default: sonnet)
  --improve-model <name>              Skill rewriter model — rewrites the skill each round (default: sonnet)
  --judge-models <executor:model>     Single judge config (default: claude:haiku)

Examples:
  omk evolve skills/code-review/SKILL.md
  omk evolve skills/code-review/SKILL.md --rounds 10 --target 4.5
  omk evolve skills/code-review/SKILL.md --model sonnet --improve-model opus
`,
  },
  'cli.help.sample': {
    zh: `
omk sample——生成或补齐 eval-samples 评测用例

用法：
  omk sample <skill-path> [options]
  omk sample --batch [--skill-dir <dir>] [options]

输出位置（默认）：
  <skill>/SKILL.md  → <skill>/.omk/samples.json（omk 标准约定）
  其他 .md 路径    → 当前目录的 eval-samples.json（兜底）

选项：
  --count <n>                         强制生成 N 条（不指定时由 LLM 按 skill 类型自动判断：
                                       工作流型 6-8 条 / 原子型 4-6 条 / 混合型 5-7 条）
  --model <name>                      生成模型（默认：opus；lean+effort-low 已自动开,想省钱可改 sonnet/haiku）
  --focus <text>                      自然语言指定希望覆盖的场景（追加到 prompt，优先级高于自由发挥）
  --batch                             为 skill 目录下缺少 eval-samples 的 skill 批量生成
  --skill-dir <path>                  skill 目录（batch 使用，默认：skills）

示例：
  omk improve samples skills/req-tool.md
  omk improve samples skills/req-tool.md --count 8 \\
    --focus "重点覆盖 tag 查询走 PROJECT 空 → WORKSPACE 兜底的多步流程，以及 search 失败的错误路径"
`,
    en: `
omk sample — generate or fill eval-samples test cases

Usage:
  omk sample <skill-path> [options]
  omk sample --batch [--skill-dir <dir>] [options]

Output path (default):
  <skill>/SKILL.md  → <skill>/.omk/samples.json (omk standard layout)
  other .md paths   → ./eval-samples.json in current directory (fallback)

Options:
  --count <n>                         Force N samples (omit to let LLM auto-decide by skill type:
                                       workflow 6-8 / atomic 4-6 / mixed 5-7)
  --model <name>                      Generation model (default: opus; lean+effort-low applied; pass --model sonnet/haiku to save cost)
  --focus <text>                      Natural-language scenario hints appended to the prompt (overrides freeform diversity)
  --batch                             Generate for skills that are missing eval-samples
  --skill-dir <path>                  Skill directory for batch mode (default: skills)

Examples:
  omk improve samples skills/req-tool.md
  omk improve samples skills/req-tool.md --count 8 \\
    --focus "Cover PROJECT-empty → WORKSPACE-fallback multi-step tag lookup and the search-failure error path"
`,
  },
  'cli.help.studio': {
    zh: `
omk studio——打开本地知识工作台

用法：
  omk studio [options]

选项：
  --port <n>                          本地服务端口（默认：7799）
  --host <host>                       监听地址（默认：127.0.0.1；局域网访问可用 0.0.0.0）
  --reports-dir <path>                报告目录（默认：~/.oh-my-knowledge/reports）
  --analyses-dir <path>               观测分析目录
  --observations-dir <path>           observe inbox 数据目录（默认：.omk/observations）
  --no-open                           只启动服务，不自动打开浏览器
  --dev                               开发模式：文件变化时自动重启

示例：
  omk studio
  omk studio --port 7798
  omk studio --host 0.0.0.0 --observations-dir .omk/observations
  omk studio --no-open
`,
    en: `
omk studio — open the local knowledge workbench

Usage:
  omk studio [options]

Options:
  --port <n>                          Local server port (default: 7799)
  --host <host>                       Listen address (default: 127.0.0.1; use 0.0.0.0 for LAN access)
  --reports-dir <path>                Reports directory (default: ~/.oh-my-knowledge/reports)
  --analyses-dir <path>               Observation analyses directory
  --observations-dir <path>           Observe inbox data directory (default: .omk/observations)
  --no-open                           Start the server without opening a browser
  --dev                               Dev mode: restart on file changes

Examples:
  omk studio
  omk studio --port 7798
  omk studio --host 0.0.0.0 --observations-dir .omk/observations
  omk studio --no-open
`,
  },
  // ============ omk doctor CLI level ============
  // 注:doctor 子系统内部的规则/健康度/composer 文案已迁移到 src/doctor/messages.ts;
  // 这里只留 CLI 调用层(commands/doctor.ts)直接使用的两条。
  'cli.doctor.no_skill_found': {
    zh: '未在 {path} 下发现 skill 文件。\n  doctor 期望 .md 文件、目录(包含 .md 或 SKILL.md)或 cwd 下的 skills/ 子目录。',
    en: 'No skills found at {path}.\n  doctor expects a .md file, a directory (containing .md or SKILL.md), or skills/ under cwd.',
  },
  'cli.doctor.samples_detected': {
    zh: '✓ 使用评测用例文件：{path}',
    en: '✓ Using eval samples file: {path}',
  },
  'cli.run.skip_connectivity_warning': {
    zh: '⚠️  --skip-connectivity 已启用: 跳过 LLM 模型连通性检测。请确保 executor / judge 已通过其他方式验证可达。',
    en: '⚠️  --skip-connectivity enabled: LLM connectivity check skipped. Verify executor / judge are reachable by other means.',
  },
};
