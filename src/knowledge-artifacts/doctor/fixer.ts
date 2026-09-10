import { confirm, select, input } from '@inquirer/prompts';
import { createInterface, type Interface } from 'node:readline';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createExecutor } from '../../executors/index.js';
import type { DoctorReport, DoctorRuleResult } from './contracts.js';
import { projectLayout } from '../../evidence/storage/layout.js';

interface FixIssue {
  id: string;
  skillName: string;
  skillPath: string;
  ruleId: string;
  message: string;
  hint: string;
}

interface FixOption {
  id: string;
  label: string;
  description: string;
  recommended?: boolean;
  risk?: 'low' | 'medium' | 'high';
}

interface FixIssuePlan {
  issueId: string;
  title: string;
  summary: string;
  options: FixOption[];
}

interface FixPlan {
  issues: FixIssuePlan[];
}

function collectFixIssues(report: DoctorReport): FixIssue[] {
  const issues: FixIssue[] = [];
  for (const skill of report.skills) {
    const summaryResult = skill.results.find((r) => r.ruleId.endsWith(':_summary'));
    const summaryHint = summaryResult?.hint || '';
    const summaryTopSuggestions = (summaryResult?.detail as Record<string, unknown>)?.topSuggestions as string[] | undefined;

    for (const result of skill.results) {
      if (result.status !== 'fail') continue;
      let hint = result.hint || suggestionFromDetail(result);
      if (!hint && summaryTopSuggestions && summaryTopSuggestions.length > 0) {
        hint = summaryTopSuggestions.join('\n');
      }
      if (!hint && summaryHint) {
        hint = summaryHint;
      }
      if (!hint) continue;
      issues.push({
        id: `i${issues.length + 1}`,
        skillName: skill.skillName,
        skillPath: skill.skillPath,
        ruleId: result.ruleId,
        message: result.message,
        hint,
      });
    }
  }
  return issues;
}

function suggestionFromDetail(result: DoctorRuleResult): string {
  const detail = result.detail as Record<string, unknown> | undefined;
  if (!detail) return '';
  if (typeof detail.suggestion === 'string' && detail.suggestion) return detail.suggestion;
  if (Array.isArray(detail.suggestions) && detail.suggestions.length > 0) {
    return detail.suggestions.filter((s: unknown) => typeof s === 'string').join('\n');
  }
  if (typeof detail.topSuggestion === 'string' && detail.topSuggestion) return detail.topSuggestion;
  return '';
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const start = trimmed.indexOf('{');
  if (start < 0) throw new Error('LLM response did not contain JSON');
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(trimmed.slice(start, i + 1));
    }
  }
  throw new Error('LLM response JSON was incomplete');
}

function asFixPlan(value: unknown): FixPlan {
  const obj = value as FixPlan;
  if (!obj || !Array.isArray(obj.issues)) throw new Error('invalid fix plan JSON: missing issues[]');
  return obj;
}

function spinner(msg: string): void {
  process.stderr.write(`⏳ ${msg}\n`);
}

async function callJsonLLM(opts: {
  signal?: AbortSignal;
  executorName: string;
  model: string;
  timeoutMs: number;
  system: string;
  prompt: string;
  loading?: string;
  effort?: string;
}): Promise<unknown> {
  opts.signal?.throwIfAborted();
  if (opts.loading) spinner(opts.loading);
  const executor = createExecutor(opts.executorName);
  const result = await executor({ abortSignal: opts.signal, model: opts.model, system: opts.system, prompt: opts.prompt, timeoutMs: opts.timeoutMs, effort: opts.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined });
  opts.signal?.throwIfAborted();
  if (!result.ok) throw new Error(result.error || 'doctor fix LLM call failed');
  const raw = result.output || '';
  return extractJsonObject(raw);
}

async function buildFixPlan(issues: FixIssue[], executorName: string, model: string, timeoutMs: number, _effort?: string, signal?: AbortSignal): Promise<FixPlan> {
  const system = '你是 omk doctor 修复向导。根据 doctor 结果生成用户可选择的修复方案。只输出合法 JSON，不要 markdown，不要注释，不要尾逗号。';
  const prompt = `根据以下 doctor 问题与建议，生成交互式修复选项。要求：\n- 每个 issue 生成 2-3 个 option。\n- 标出 recommended。\n- risk 只能是 low/medium/high。\n- 不要生成具体补丁，只生成方案选项。\n- 输出必须是合法 JSON，第一个字符是 {，最后一个字符是 }。\n\n输出 JSON schema：\n{"issues":[{"issueId":"i1","title":"...","summary":"...","options":[{"id":"a","label":"...","description":"...","recommended":true,"risk":"medium"}]}]}\n\nDoctor issues:\n${JSON.stringify(issues, null, 2)}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return asFixPlan(await callJsonLLM({ signal, executorName, model, timeoutMs, system, prompt, loading: attempt === 0 ? '正在根据 doctor 建议生成修复方案...' : `方案生成格式异常，重试中（${attempt + 1}/3）...` }));
    } catch (err) {
      signal?.throwIfAborted();
      if (attempt === 2) throw err;
    }
  }
  throw new Error('unreachable');
}

async function applyFixWithAgent(issues: FixIssue[], choices: Record<string, string>, plan: FixPlan, executorName: string, model: string, timeoutMs: number, effort?: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  const chosenIssues = issues.filter((i) => choices[i.id] && choices[i.id] !== 'skip');
  if (chosenIssues.length === 0) return false;

  const skillPath = resolve(chosenIssues[0].skillPath);
  const cwd = dirname(skillPath);

  const instructions = chosenIssues.map((issue) => {
    const choice = choices[issue.id];
    const planIssue = plan.issues.find((p) => p.issueId === issue.id);
    const option = planIssue?.options.find((o) => o.id === choice);
    const direction = option ? option.description : choice;
    if (choice === '__custom__') {
      return `## ${issue.id}: ${issue.message}\n用户指定的修复方向: ${direction}`;
    }
    return `## ${issue.id}: ${issue.message}\n修复方向: ${direction}\nDoctor 建议: ${issue.hint}`;
  }).join('\n\n');

  const system = `你是 omk doctor 修复 agent。你的唯一任务是用 Edit 工具对 skill 文件做最小化修改。

硬规则：
- 只用 Read 和 Edit 工具，不要用 Write 重写整个文件
- 每次 Edit 只改一处，可以多次 Edit
- 不要重新组织文档结构、不要调整格式、不要修改与问题无关的段落
- 不要删除核心约束
- 不要写真实 token、账号、工号；需要时用占位符
- 改完后用一句话说明改了什么，不要输出文件全文`;

  const prompt = `修改文件: ${skillPath}

修复任务:
${instructions}`;

  spinner('正在修复 skill 文件...');
  const executor = createExecutor(executorName);
  const result = await executor({
    model,
    system,
    prompt,
    cwd,
    skillDir: cwd,
    timeoutMs,
    abortSignal: signal,
    effort: effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined,
  });

  signal?.throwIfAborted();
  if (!result.ok) {
    process.stderr.write(`修复失败: ${result.error ?? 'unknown'}\n`);
    return false;
  }

  if (result.output) {
    process.stderr.write(`\n修复完成:\n${result.output}\n`);
  }
  return true;
}

function renderPlan(plan: FixPlan): void {
  process.stderr.write('\nDoctor fix 方案：\n');
  for (const issue of plan.issues) {
    process.stderr.write(`\n[${issue.issueId}] ${issue.title}\n${issue.summary}\n`);
    issue.options.forEach((option, index) => {
      const rec = option.recommended ? '（推荐）' : '';
      const risk = option.risk ? ` risk=${option.risk}` : '';
      process.stderr.write(`  ${index + 1}) ${option.label}${rec}${risk} [${option.id}]\n     ${option.description}\n`);
    });
    process.stderr.write('  0) 跳过此问题 [skip]\n');
  }
}

async function collectChoices(plan: FixPlan, ask: (question: string) => Promise<string>, signal?: AbortSignal): Promise<Record<string, string>> {
  const choices: Record<string, string> = {};
  for (const issue of plan.issues) {
    const recommended = issue.options.find((o) => o.recommended) ?? issue.options[0];
    if (process.stdin.isTTY) {
      const selected = await select<string>({
        message: `${issue.issueId}: ${issue.title}`,
        default: recommended?.id ?? 'skip',
        choices: [
          ...issue.options.filter((o) => o.id !== 'skip').map((option) => ({
            name: `${option.label}${option.recommended ? '（推荐）' : ''}`,
            value: option.id,
            description: option.description,
          })),
          { name: '自定义修复方向', value: '__custom__', description: '输入你自己的修复想法' },
          { name: '跳过此问题', value: 'skip', description: '不修复该问题' },
        ],
      }, { signal });
      if (selected === '__custom__') {
        const customInput = await input({ message: '请输入修复方向：' }, { signal });
        if (customInput.trim()) {
          issue.options.push({ id: '__custom__', label: '自定义', description: customInput.trim() });
          choices[issue.issueId] = '__custom__';
        } else {
          choices[issue.issueId] = 'skip';
        }
      } else {
        choices[issue.issueId] = selected;
      }
      continue;
    }

    const recommendedIndex = recommended ? issue.options.indexOf(recommended) + 1 : 0;
    const validIds = new Set(issue.options.map((o) => o.id));
    validIds.add('skip');
    const answer = await ask(`\n选择 ${issue.issueId} [默认 ${recommendedIndex || 'skip'}，输入编号 / id / 0 跳过]：`);
    const normalized = answer.trim();
    if (!normalized) {
      choices[issue.issueId] = recommended?.id ?? 'skip';
      continue;
    }
    if (normalized === '0' || normalized.toLowerCase() === 'skip') {
      choices[issue.issueId] = 'skip';
      continue;
    }
    const asNumber = Number(normalized);
    if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= issue.options.length) {
      choices[issue.issueId] = issue.options[asNumber - 1].id;
      continue;
    }
    choices[issue.issueId] = validIds.has(normalized) ? normalized : recommended?.id ?? 'skip';
  }
  return choices;
}

function backupRelativePath(projectRoot: string, path: string): string {
  const rel = relative(projectRoot, path);
  if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\')) {
    return rel;
  }
  const hash = createHash('sha256').update(path).digest('hex').slice(0, 12);
  return join('external', hash, basename(path));
}

function backupSkillFiles(issues: FixIssue[], projectRoot: string): void {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
  const paths = [...new Set(issues.map((i) => resolve(i.skillPath)))];
  const layout = projectLayout(projectRoot);
  const backupDir = join(layout.doctorFixBackupsDir, stamp);
  for (const abs of paths) {
    if (!existsSync(abs)) continue;
    const target = join(backupDir, backupRelativePath(projectRoot, abs));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(abs, target);
  }
}

export interface FixOptions {
  signal?: AbortSignal;
  report: DoctorReport;
  executorName: string;
  model: string;
  timeoutMs: number;
  effort?: string;
  verify?: () => Promise<DoctorReport>;
  resolveSkillPath?: (reportPath: string) => string;
}

export async function runDoctorFix(opts: FixOptions): Promise<boolean> {
  let reader: Interface | undefined;
  let answers: AsyncIterator<string> | undefined;
  const ask = async (question: string): Promise<string> => {
    opts.signal?.throwIfAborted();
    process.stderr.write(question);
    reader ??= createInterface({ input: process.stdin, terminal: false, signal: opts.signal });
    answers ??= reader[Symbol.asyncIterator]();
    const answer = await answers.next();
    opts.signal?.throwIfAborted();
    return (answer.value ?? '').trim();
  };
  try {
    return await runDoctorFixWithAnswers(opts, ask);
  } finally {
    reader?.close();
    if (reader) process.stdin.pause();
  }
}

async function runDoctorFixWithAnswers(opts: FixOptions, ask: (question: string) => Promise<string>): Promise<boolean> {
  opts.signal?.throwIfAborted();
  const issues = collectFixIssues(opts.report);
  if (opts.resolveSkillPath) {
    for (const issue of issues) {
      issue.skillPath = opts.resolveSkillPath(issue.skillPath);
    }
  }
  if (issues.length === 0) {
    process.stderr.write('\n没有可自动修复的 doctor 建议。\n');
    return false;
  }
  const plan = await buildFixPlan(issues, opts.executorName, opts.model, opts.timeoutMs, opts.effort, opts.signal);
  renderPlan(plan);
  const choices = await collectChoices(plan, ask, opts.signal);
  if (Object.values(choices).every((v) => v === 'skip')) {
    process.stderr.write('\n所有问题已跳过，未修改文件。\n');
    return false;
  }

  const chosenIssues = issues.filter((i) => choices[i.id] && choices[i.id] !== 'skip');

  let shouldApply: boolean;
  if (process.stdin.isTTY) {
    shouldApply = await confirm({ message: `确认修复 ${chosenIssues.length} 个问题？`, default: true }, { signal: opts.signal });
  } else {
    const answer = await ask(`\n确认修复 ${chosenIssues.length} 个问题？[Y/n] `);
    shouldApply = !/^n(o)?$/i.test(answer);
  }
  if (!shouldApply) {
    process.stderr.write('已取消，未修改文件。\n');
    return false;
  }

  opts.signal?.throwIfAborted();
  backupSkillFiles(chosenIssues, opts.report.cwd);
  const changed = await applyFixWithAgent(issues, choices, plan, opts.executorName, opts.model, opts.timeoutMs, opts.effort, opts.signal);

  if (changed && opts.verify) {
    const shouldVerify = process.stdin.isTTY
      ? await confirm({ message: '是否重新运行 doctor 验证修复结果？', default: true }, { signal: opts.signal })
      : false;
    if (shouldVerify) {
      spinner('重新运行 doctor 验证中...');
      const after = await opts.verify();
      let detailFails = 0;
      let detailWarns = 0;
      let detailPass = 0;
      for (const sk of after.skills) {
        for (const r of sk.results) {
          if (r.status === 'fail') detailFails++;
          else if (r.status === 'warn') detailWarns++;
          else if (r.status === 'pass') detailPass++;
        }
      }
      process.stderr.write(`验证结果：错误 ${detailFails} / 警告 ${detailWarns} / 通过 ${detailPass}\n`);
    }
  }
  return changed;
}
