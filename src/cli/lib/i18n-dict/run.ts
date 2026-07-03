import type { CliMessage } from './types.js';

export type RunMessageKey =
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
  | 'cli.run.invalid_repeat'
  | 'cli.run.invalid_holdout_ratio'
  | 'cli.run.invalid_judge_repeat'
  | 'cli.run.no_debias_length_active'
  | 'cli.run.invalid_bootstrap_samples'
  | 'cli.run.bootstrap_samples_too_large'
  | 'cli.run.dry_run_no_scores'
  | 'cli.run.skill_section'
  | 'cli.run.run_section'
  | 'cli.run.batch_complete'
  | 'cli.run.batch_verdict_header'
  | 'cli.run.batch_verdict_next_step'
  | 'cli.run.batch_child_report_missing'
  | 'cli.run.eval_complete'
  | 'cli.run.tally'
  | 'cli.run.report_saved'
  | 'cli.run.evidence_recorded'
  | 'cli.run.evidence_recorded_unbound'
  | 'cli.run.report_only_gate_skipped'
  | 'cli.run.report_server_running'
  | 'cli.run.report_server_view'
  | 'cli.run.report_server_stop'
  | 'cli.run.no_serve_in_non_tty'
  | 'cli.run.no_serve_view_hint'
  | 'cli.run.gold_load_failed'
  | 'cli.run.gold_load_issue'
  | 'cli.run.contamination_warning'
  | 'cli.run.skip_connectivity_warning';

export const runDict: Record<RunMessageKey, CliMessage> = {
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
  'cli.run.invalid_holdout_ratio': {
    zh: '⚠ --holdout-ratio "{value}" 无效 (期望 0 到 1 之间的小数), 已忽略、不做 holdout 切分\n',
    en: '⚠ --holdout-ratio "{value}" is invalid (expected a fraction in (0, 1)), ignored — no holdout split\n',
  },
  'cli.run.no_debias_length_active': {
    zh: 'ℹ --no-debias-length 已生效：judge prompt 去掉长度去偏指令（debias-off 变体），hash 与默认开启时不同。\n',
    en: 'ℹ --no-debias-length is active: the judge prompt drops the length-debias instruction (debias-off variant); its hash differs from the default.\n',
  },
  'cli.run.invalid_bootstrap_samples': {
    zh: '⚠ --bootstrap-samples "{value}" 无效 (期望 ≥ 100 的整数), 已按 1000 执行\n',
    en: '⚠ --bootstrap-samples "{value}" is invalid (expected an integer ≥ 100), falling back to 1000\n',
  },
  'cli.run.bootstrap_samples_too_large': {
    zh: '⚠ --bootstrap-samples {n} 较大, 可能耗时数秒。1000 是业内标准, 通常已够用。\n',
    en: '⚠ --bootstrap-samples {n} is large and may take several seconds. 1000 is the industry standard and usually sufficient.\n',
  },
  'cli.run.dry_run_no_scores': {
    zh: 'eval dry-run：仅预览任务，不检查分数',
    en: 'Eval dry-run: no scores to check',
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
  'cli.run.batch_verdict_next_step': {
    zh: '  下一步：{next}',
    en: '  Next: {next}',
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
  'cli.run.evidence_recorded': {
    zh: '🔖 已为受管 skill「{name}」记录评测证据 → measurable\n',
    en: '🔖 Recorded eval evidence for managed skill "{name}" → measurable\n',
  },
  'cli.run.evidence_recorded_unbound': {
    zh: '🔖 受管 skill「{name}」：评测内容与当前安装版本指纹不一致，证据已留存但不绑当前版本\n',
    en: '🔖 Managed skill "{name}": eval content differs from the installed version; evidence kept but not bound to current\n',
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
  'cli.run.skip_connectivity_warning': {
    zh: '⚠️  --skip-connectivity 已启用: 跳过 LLM 模型连通性检测。请确保 executor / judge 已通过其他方式验证可达。',
    en: '⚠️  --skip-connectivity enabled: LLM connectivity check skipped. Verify executor / judge are reachable by other means.',
  },
};
