import type {
  DebugKnowledgeAccessKind,
  DebugKnowledgeEvidence,
  ExperienceTimelineEvent,
  TaskReplayStep,
  TaskReplayStepKind
} from '../../../observability/view-models/index.js';
import type { Lang } from '../../../shared/language.js';
import type { ReplayCardTone, ReplayMilestoneTone, ToolResultState } from '../../view-models/replay.js';
import { compactText, parseTimestamp } from './format.js';

export const ACCESS_LABELS: Record<DebugKnowledgeAccessKind, Record<Lang, string>> = {
  injected: { zh: '已注入', en: 'Injected' },
  read: { zh: '已读取', en: 'Read' },
  returned: { zh: '工具返回', en: 'Tool return' },
};

export const STEP_LABELS: Record<TaskReplayStepKind, Record<Lang, string>> = {
  user_request: { zh: '用户消息', en: 'User message' },
  user_message: { zh: '用户补充', en: 'User follow-up' },
  user_correction: { zh: '用户纠正', en: 'User correction' },
  runtime_context: { zh: '任务上下文', en: 'Task context' },
  skill_context: { zh: 'Skill 上下文', en: 'Skill context' },
  tool_exchange: { zh: '工具调用', en: 'Tool call' },
  unmatched_tool_result: { zh: '未配对工具结果', en: 'Unmatched tool result' },
  assistant_message: { zh: 'AI 回答', en: 'AI response' },
  model_activity: { zh: '模型思考', en: 'Model reasoning' },
  lifecycle: { zh: '运行状态', en: 'Lifecycle' },
  observation: { zh: '观测事件', en: 'Observation' },
  system_event: { zh: '系统事件', en: 'System event' },
};

export function lifecycleEventLabel(label: string | undefined, lang: Lang): string {
  const labels: Record<string, Record<Lang, string>> = {
    session_started: { zh: '会话开始', en: 'Session started' },
    session_ended: { zh: '会话结束', en: 'Session ended' },
    turn_started: { zh: '本轮开始', en: 'Turn started' },
    turn_completed: { zh: '本轮完成', en: 'Turn completed' },
    turn_failed: { zh: '本轮失败', en: 'Turn failed' },
    turn_aborted: { zh: '本轮中止', en: 'Turn aborted' },
    turn_interrupted: { zh: '本轮被打断', en: 'Turn interrupted' },
    turn_ended_unknown: { zh: '本轮结束状态未知', en: 'Turn ended with unknown status' },
    step_started: { zh: '步骤开始', en: 'Step started' },
    step_completed: { zh: '步骤完成', en: 'Step completed' },
  };
  return labels[label ?? '']?.[lang] ?? (label || (lang === 'zh' ? '运行状态变化' : 'Lifecycle event'));
}

export function lifecycleMilestoneTone(label: string | undefined): ReplayMilestoneTone {
  if (label === 'session_started' || label === 'turn_started') return 'start';
  if (label === 'session_ended' || label === 'turn_completed') return 'end';
  if (label === 'turn_failed' || label === 'turn_aborted' || label === 'turn_interrupted') return 'warning';
  return 'neutral';
}

export function replayEventModel(
  step: TaskReplayStep,
  event: ExperienceTimelineEvent | undefined,
): string | undefined {
  return step.stepKind === 'assistant_message' || step.stepKind === 'model_activity'
    ? event?.model?.trim() || undefined
    : undefined;
}

export function attachmentSummary(
  attachments: NonNullable<ExperienceTimelineEvent['attachments']>,
  lang: Lang,
): string {
  const imageCount = attachments.filter((attachment) => attachment.attachmentKind === 'image').length;
  const fileCount = attachments.length - imageCount;
  const parts = lang === 'zh'
    ? [imageCount > 0 ? `图片 ${imageCount} 张` : '', fileCount > 0 ? `文件 ${fileCount} 个` : '']
    : [imageCount > 0 ? `${imageCount} image${imageCount === 1 ? '' : 's'}` : '', fileCount > 0 ? `${fileCount} file${fileCount === 1 ? '' : 's'}` : ''];
  return parts.filter(Boolean).join(' · ');
}

export function evidenceTimestampForStep(
  evidence: DebugKnowledgeEvidence[],
  step: TaskReplayStep,
): string | undefined {
  const eventIds = new Set(step.events.map((event) => event.id));
  return evidence
    .flatMap((item) => item.evidenceRefs)
    .filter((ref) => eventIds.has(ref.id) && parseTimestamp(ref.timestamp) !== undefined)
    .map((ref) => ref.timestamp as string)
    .sort((a, b) => (parseTimestamp(a) ?? 0) - (parseTimestamp(b) ?? 0))[0];
}

export function evidenceForStep(
  step: TaskReplayStep,
  evidenceById: Map<string, DebugKnowledgeEvidence>,
): DebugKnowledgeEvidence[] {
  return step.knowledgeEvidenceIds
    .map((id) => evidenceById.get(id))
    .filter((item): item is DebugKnowledgeEvidence => Boolean(item));
}

export function toolInputPreview(event: ExperienceTimelineEvent | undefined): string {
  if (!event) return '';
  const text = event.fullText ?? event.snippet ?? '';
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const input = value as Record<string, unknown>;
      for (const key of ['cmd', 'command', 'file_path', 'path', 'url', 'query']) {
        if (typeof input[key] === 'string' && input[key]) return input[key];
      }
      return JSON.stringify(value, null, 2);
    }
  } catch {
    // Keep the source text when the tool input is not JSON.
  }
  return text;
}

export function toolOperationTitle(toolName: string, input: string, lang: Lang): string {
  const patchTargets = extractPatchTargets(input);
  if (patchTargets.length > 0) {
    const first = patchTargets[0];
    if (!first) return toolName;
    const action = first.action === 'Add'
      ? (lang === 'zh' ? '新增文件' : 'Add file')
      : first.action === 'Delete'
        ? (lang === 'zh' ? '删除文件' : 'Delete file')
        : (lang === 'zh' ? '修改文件' : 'Update file');
    const suffix = patchTargets.length > 1 ? ` +${patchTargets.length - 1}` : '';
    const separator = lang === 'zh' ? '：' : ': ';
    return `${action}${separator}${first.path}${suffix}`;
  }

  const normalized = input.replace(/\s+/g, ' ').trim();
  const scriptedOperation = scriptedOperationTitle(normalized, lang);
  if (scriptedOperation) return scriptedOperation;
  const toolOperation = semanticToolOperation(toolName, normalized, lang);
  if (toolOperation) return toolOperation.title;
  if (/bash|exec|shell/i.test(toolName)) {
    const shellOperation = shellOperationTitle(normalized, lang);
    if (shellOperation) return shellOperation;
    if (normalized && normalized.length <= 72) return normalized;
    return lang === 'zh' ? '执行 Bash 命令' : 'Run Bash command';
  }
  if (normalized && normalized.length <= 72) return normalized;
  return lang === 'zh' ? `调用 ${toolName}` : `Call ${toolName}`;
}

function scriptedOperationTitle(input: string, lang: Lang): string | undefined {
  if (!input) return undefined;
  if (/\bALL_TOOLS\.filter\s*\(/.test(input)) return lang === 'zh' ? '筛选可用工具' : 'Filter available tools';
  if (/\btools\.update_plan\s*\(/.test(input)) return lang === 'zh' ? '更新任务计划' : 'Update task plan';
  if (/\btools\.apply_patch\s*\(/.test(input)) return lang === 'zh' ? '应用代码修改' : 'Apply code changes';
  const toolCall = input.match(/\btools\.([A-Za-z0-9_]+)\s*\(/)?.[1];
  return toolCall ? (lang === 'zh' ? `调用 ${toolCall}` : `Call ${toolCall}`) : undefined;
}

function shellOperationTitle(input: string, lang: Lang): string | undefined {
  if (!input) return undefined;
  const searchCommand = input.match(/^\s*(?:rg|grep)\b/i);
  if (searchCommand) {
    const quotedTerm = input.match(/["']([^"']+)["']/)?.[1];
    const term = quotedTerm ? compactText(quotedTerm, 42) : undefined;
    return term
      ? (lang === 'zh' ? `搜索：${term}` : `Search: ${term}`)
      : (lang === 'zh' ? '搜索内容' : 'Search content');
  }

  const sedRead = input.match(/^\s*sed\s+-n\s+(?:"[^"]*"|'[^']*'|\S+)\s+(?:"([^"]+)"|'([^']+)'|([^\s;|]+))/i);
  const simpleRead = input.match(/^\s*(?:cat|head|tail)\b(?:\s+-\S+(?:\s+\S+)?)?\s+(?:"([^"]+)"|'([^']+)'|([^\s;|]+))/i);
  const readTarget = sedRead?.slice(1).find(Boolean) ?? simpleRead?.slice(1).find(Boolean);
  if (readTarget) return lang === 'zh' ? `读取：${compactText(readTarget, 48)}` : `Read: ${compactText(readTarget, 48)}`;

  const nodeCommand = parseNodeCommand(input);
  if (nodeCommand) {
    const semanticTitle = semanticNodeOperation(nodeCommand.args, lang)?.title;
    if (semanticTitle) return semanticTitle;
    if (nodeCommand.args[0]?.toLocaleLowerCase() === 'call' && nodeCommand.args[1]) {
      return lang === 'zh' ? `调用：${nodeCommand.args[1]}` : `Call: ${nodeCommand.args[1]}`;
    }
    const scriptName = nodeCommand.script.split('/').at(-1) ?? nodeCommand.script;
    const suffix = nodeCommand.args[0] ? ` ${nodeCommand.args[0]}` : '';
    return lang === 'zh' ? `运行：${scriptName}${suffix}` : `Run: ${scriptName}${suffix}`;
  }

  const gitCommand = input.match(/^\s*git\s+([^\s;|]+)/i)?.[1];
  if (gitCommand) return lang === 'zh' ? `运行：git ${gitCommand}` : `Run: git ${gitCommand}`;
  return undefined;
}

type SemanticAction = 'list' | 'read' | 'resolve' | 'create' | 'update' | 'delete' | 'export' | 'import' | 'search' | 'verify' | 'publish' | 'wait';

interface SemanticOperation {
  action: SemanticAction;
  title: string;
}

function semanticToolOperation(toolName: string, input: string, lang: Lang): SemanticOperation | undefined {
  const normalized = toolName.trim().toLocaleLowerCase().replace(/[\s-]+/g, '_');
  if (/^(?:edit|patch|apply_patch)$/.test(normalized)) {
    return { action: 'update', title: lang === 'zh' ? '编辑内容' : 'Edit content' };
  }
  if (/^(?:wait|write_stdin)$/.test(normalized)) {
    const background = /(?:cell_id|session_id)/i.test(input);
    return {
      action: 'wait',
      title: lang === 'zh'
        ? (background ? '等待后台任务' : '等待任务完成')
        : (background ? 'Wait for background task' : 'Wait for task'),
    };
  }
  if (/^(?:view_image|image_view)$/.test(normalized)) {
    return { action: 'read', title: lang === 'zh' ? '查看图片' : 'View image' };
  }
  return undefined;
}

function parseNodeCommand(input: string): { script: string; args: string[] } | undefined {
  const tokens = tokenizeShellCommand(input);
  if (tokens[0]?.toLocaleLowerCase() !== 'node') return undefined;
  const scriptIndex = tokens.findIndex((token, index) => index > 0 && !token.startsWith('-'));
  const script = scriptIndex >= 0 ? tokens[scriptIndex] : undefined;
  if (!script) return undefined;
  return { script, args: tokens.slice(scriptIndex + 1) };
}

function tokenizeShellCommand(input: string): string[] {
  const tokens: string[] = [];
  const matcher = /"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s;|]+)/g;
  for (const match of input.matchAll(matcher)) {
    tokens.push((match[1] ?? match[2] ?? match[3] ?? '').replace(/\\(["\\])/g, '$1'));
  }
  return tokens;
}

function semanticNodeOperation(args: string[], lang: Lang): SemanticOperation | undefined {
  const mode = args[0]?.toLocaleLowerCase();
  if (!mode) return undefined;
  if (mode === 'call') {
    const operation = args[1];
    if (!operation) return undefined;
    return semanticIdentifierOperation(operation, lang);
  }
  return semanticIdentifierOperation(mode, lang);
}

function semanticIdentifierOperation(identifier: string, lang: Lang): SemanticOperation | undefined {
  const tokens = identifier
    .split(/[._:/-]+/)
    .map((token) => token.toLocaleLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return undefined;

  const actionByToken: Record<string, SemanticAction> = {
    list: 'list', query: 'search', search: 'search', find: 'search',
    get: 'read', read: 'read', fetch: 'read', detail: 'read', details: 'read', toc: 'read',
    resolve: 'resolve', create: 'create', add: 'create', new: 'create',
    update: 'update', edit: 'update', modify: 'update', delete: 'delete', remove: 'delete',
    export: 'export', import: 'import', verify: 'verify', check: 'verify', validate: 'verify',
    publish: 'publish',
  };
  const actionTokenIndex = tokens.findIndex((token) => actionByToken[token]);
  if (actionTokenIndex < 0) return undefined;
  const actionToken = tokens[actionTokenIndex] ?? '';
  const action = actionByToken[actionToken];
  if (!action) return undefined;

  const knownResourceTokens = new Set([
    'api', 'book', 'content', 'detail', 'details', 'doc', 'docs', 'document', 'documents',
    'file', 'files', 'issue', 'markdown', 'md', 'page', 'plan', 'report', 'result', 'results',
    'toc', 'tool', 'tools', 'url', 'urls',
  ]);
  const firstMeaningfulIndex = tokens.findIndex((token) => actionByToken[token] || knownResourceTokens.has(token));
  const meaningfulTokens = tokens.slice(Math.max(0, firstMeaningfulIndex));
  const targetTokens = meaningfulTokens.filter((token) =>
    !actionByToken[token] || token === 'detail' || token === 'details' || token === 'toc');
  const target = semanticResourceLabel(targetTokens, lang);
  const actionLabels: Record<SemanticAction, Record<Lang, string>> = {
    list: { zh: '列出', en: 'List' },
    read: { zh: '读取', en: 'Read' },
    resolve: { zh: '解析', en: 'Resolve' },
    create: { zh: '创建', en: 'Create' },
    update: { zh: '更新', en: 'Update' },
    delete: { zh: '删除', en: 'Delete' },
    export: { zh: '导出', en: 'Export' },
    import: { zh: '导入', en: 'Import' },
    search: { zh: '查询', en: 'Search' },
    verify: { zh: '校验', en: 'Verify' },
    publish: { zh: '发布', en: 'Publish' },
    wait: { zh: '等待', en: 'Wait for' },
  };
  const fallbackTarget = lang === 'zh' ? '可用项' : 'available items';
  const displayTarget = target || fallbackTarget;
  const separator = lang === 'en' || /^[A-Za-z0-9]/.test(displayTarget) ? ' ' : '';
  return { action, title: `${actionLabels[action][lang]}${separator}${displayTarget}` };
}

function semanticResourceLabel(tokens: string[], lang: Lang): string {
  if (tokens.length === 0) return '';
  const joined = tokens.join('_');
  const compoundLabels: Record<string, Record<Lang, string>> = {
    book_toc: { zh: '知识库目录', en: 'knowledge base contents' },
    doc_detail: { zh: '文档详情', en: 'document details' },
    document_detail: { zh: '文档详情', en: 'document details' },
    markdown_doc: { zh: 'Markdown 文档', en: 'Markdown document' },
    markdown_document: { zh: 'Markdown 文档', en: 'Markdown document' },
  };
  const compound = compoundLabels[joined];
  if (compound) return compound[lang];
  const labels: Record<string, Record<Lang, string>> = {
    api: { zh: 'API', en: 'API' }, book: { zh: '知识库', en: 'knowledge base' },
    content: { zh: '内容', en: 'content' }, detail: { zh: '详情', en: 'details' },
    details: { zh: '详情', en: 'details' }, doc: { zh: '文档', en: 'document' },
    docs: { zh: '文档', en: 'documents' }, document: { zh: '文档', en: 'document' },
    documents: { zh: '文档', en: 'documents' }, file: { zh: '文件', en: 'file' },
    files: { zh: '文件', en: 'files' }, issue: { zh: 'Issue', en: 'issue' },
    markdown: { zh: 'Markdown', en: 'Markdown' }, md: { zh: 'Markdown', en: 'Markdown' },
    page: { zh: '页面', en: 'page' }, plan: { zh: '计划', en: 'plan' },
    report: { zh: '报告', en: 'report' }, result: { zh: '结果', en: 'result' },
    results: { zh: '结果', en: 'results' }, toc: { zh: '目录', en: 'contents' },
    tool: { zh: '工具', en: 'tool' }, tools: { zh: '工具', en: 'tools' },
    url: { zh: 'URL', en: 'URL' }, urls: { zh: 'URL', en: 'URLs' },
  };
  const translated = tokens.map((token) => labels[token]?.[lang] ?? token);
  return lang === 'zh' ? translated.join('') : translated.join(' ');
}

function extractPatchTargets(input: string): Array<{ action: 'Add' | 'Update' | 'Delete'; path: string }> {
  const expanded = input.replace(/\\r\\n|\\n/g, '\n');
  return [...expanded.matchAll(/\*\*\*\s+(Add|Update|Delete) File:\s*([^\n\\"']+)/g)]
    .map((match) => ({
      action: match[1] as 'Add' | 'Update' | 'Delete',
      path: match[2]?.trim() ?? '',
    }))
    .filter((target) => target.path.length > 0);
}

export function inferToolActionLabel(evidence: DebugKnowledgeEvidence[], lang: Lang): string {
  if (evidence.some((item) => item.accessKind === 'read')) return lang === 'zh' ? '文件读取' : 'File read';
  return lang === 'zh' ? '工具执行' : 'Tool execution';
}

export function resultTitle(
  step: TaskReplayStep,
  evidence: DebugKnowledgeEvidence[],
  lang: Lang,
  input = '',
  toolName = '',
  resultState = resolveToolResultState(step, false),
): string {
  const zh = lang === 'zh';
  if (resultState === 'pending') return zh ? '结果获取中' : 'Waiting for result';
  if (resultState === 'missing') return zh ? '结果缺失' : 'Result missing';
  if (resultState === 'failure') return zh ? '工具执行失败' : 'Tool execution failed';
  if (resultState === 'cancelled') return zh ? '工具执行已取消' : 'Tool execution cancelled';
  const result = step.events[1];
  const skillRead = evidence.some((item) => item.knowledgeKind === 'skill' && item.accessKind === 'read');
  if (skillRead && result) {
    const text = result.fullText ?? result.snippet ?? '';
    const lineCount = text ? text.split(/\r?\n/).length : 0;
    return zh ? `返回 ${lineCount} 行内容` : `Returned ${lineCount} line${lineCount === 1 ? '' : 's'}`;
  }
  const facts = structuredResultFacts(result);
  if (facts.ok === false) return zh ? '返回错误信息' : 'Returned an error';
  const nodeCommand = parseNodeCommand(input);
  const action = nodeCommand
    ? semanticNodeOperation(nodeCommand.args, lang)?.action
    : semanticToolOperation(toolName, input, lang)?.action;
  if (facts.itemCount !== undefined) {
    return zh ? `返回 ${facts.itemCount} 项` : `Returned ${facts.itemCount} item${facts.itemCount === 1 ? '' : 's'}`;
  }
  if (facts.title) {
    const title = compactText(facts.title, 52);
    if (action === 'create') return zh ? `已创建：${title}` : `Created: ${title}`;
    if (action === 'update') return zh ? `已更新：${title}` : `Updated: ${title}`;
    return zh ? `返回：${title}` : `Returned: ${title}`;
  }
  const completionLabels: Partial<Record<SemanticAction, Record<Lang, string>>> = {
    create: { zh: '创建完成', en: 'Creation completed' },
    update: { zh: '更新完成', en: 'Update completed' },
    delete: { zh: '删除完成', en: 'Deletion completed' },
    export: { zh: '导出完成', en: 'Export completed' },
    import: { zh: '导入完成', en: 'Import completed' },
    publish: { zh: '发布完成', en: 'Publish completed' },
    wait: { zh: '等待结束', en: 'Wait completed' },
  };
  if (action && completionLabels[action]) return completionLabels[action][lang];
  return zh ? '工具返回结果' : 'Tool returned a result';
}

interface StructuredResultFacts {
  ok?: boolean;
  itemCount?: number;
  title?: string;
}

function structuredResultFacts(event: ExperienceTimelineEvent | undefined): StructuredResultFacts {
  const facts: StructuredResultFacts = {};
  const text = event?.fullText ?? event?.snippet ?? '';
  const parsed = parseStructuredResultText(text);
  if (parsed !== undefined) collectStructuredResultFacts(parsed, facts, undefined, 0);
  return facts;
}

function parseStructuredResultText(text: string): unknown {
  const trimmed = text.trim();
  const outputIndex = trimmed.indexOf('Output:');
  const candidates = outputIndex >= 0
    ? [trimmed.slice(outputIndex + 'Output:'.length).trim(), trimmed]
    : [trimmed];
  for (const candidate of candidates) {
    if (!candidate || !['{', '['].includes(candidate[0] ?? '')) continue;
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next observable representation.
    }
  }
  return undefined;
}

function collectStructuredResultFacts(
  value: unknown,
  facts: StructuredResultFacts,
  parentKey: string | undefined,
  depth: number,
): void {
  if (depth > 7 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    const parsed = parseStructuredResultText(value);
    if (parsed !== undefined) collectStructuredResultFacts(parsed, facts, parentKey, depth + 1);
    return;
  }
  if (Array.isArray(value)) {
    if (['data', 'items', 'results', 'tools'].includes(parentKey ?? '') && facts.itemCount === undefined) {
      facts.itemCount = value.length;
    }
    value.slice(0, 4).forEach((item) => collectStructuredResultFacts(item, facts, parentKey, depth + 1));
    return;
  }
  if (typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (typeof record.ok === 'boolean' && facts.ok === undefined) facts.ok = record.ok;
  if (typeof record.title === 'string' && record.title.trim() && facts.title === undefined) {
    facts.title = record.title.trim();
  }
  for (const key of ['output', 'result', 'data', 'items', 'results', 'tools', 'content', 'text']) {
    if (key in record) collectStructuredResultFacts(record[key], facts, key, depth + 1);
  }
}

export function resolveToolResultState(step: TaskReplayStep, pendingToolResults: boolean): ToolResultState {
  if (step.toolStatus === 'failure') return 'failure';
  if (step.toolStatus === 'cancelled') return 'cancelled';
  if (step.events.length > 1) return 'success';
  return pendingToolResults ? 'pending' : 'missing';
}

export function resultCardTone(state: ToolResultState): ReplayCardTone {
  if (state === 'failure') return 'failure';
  if (state === 'pending') return 'pending';
  if (state === 'missing' || state === 'cancelled') return 'warning';
  return 'result';
}

export function resultCardStatusLabel(state: ToolResultState, lang: Lang): string {
  if (state === 'pending') return lang === 'zh' ? '获取中' : 'Pending';
  if (state === 'missing') return lang === 'zh' ? '结果缺失' : 'Missing';
  if (state === 'failure') return lang === 'zh' ? '失败' : 'Failed';
  if (state === 'cancelled') return lang === 'zh' ? '已取消' : 'Cancelled';
  return lang === 'zh' ? '成功' : 'Success';
}

export function resultCardDetail(
  step: TaskReplayStep,
  event: ExperienceTimelineEvent | undefined,
  duration: string,
  lang: Lang,
): string {
  if (!event) return '';
  if (step.toolStatus !== 'failure' && !event.isError) return duration;
  const failure = compactText(
    event.fullText ?? event.snippet ?? (lang === 'zh' ? '未记录失败信息' : 'Failure details not recorded'),
    72,
  );
  return [duration, failure].filter(Boolean).join(' · ');
}

export function toolStatusLabel(state: ToolResultState, lang: Lang): string {
  const zh = lang === 'zh';
  if (state === 'pending') return zh ? '结果获取中' : 'Waiting for result';
  if (state === 'failure') return zh ? '失败' : 'Failed';
  if (state === 'cancelled') return zh ? '已取消' : 'Cancelled';
  if (state === 'success') return zh ? '成功返回' : 'Returned';
  return zh ? '结果缺失' : 'Result missing';
}

export function knowledgeKindLabel(item: DebugKnowledgeEvidence, lang: Lang): string {
  if (item.knowledgeKind === 'project_instruction') return lang === 'zh' ? '项目规则' : 'Project instruction';
  if (item.knowledgeKind === 'skill') return 'Skill';
  return lang === 'zh' ? '运行时证据' : 'Runtime evidence';
}

export function roleLabel(event: ExperienceTimelineEvent | undefined, lang: Lang): string {
  if (event?.role === 'user') return lang === 'zh' ? '用户' : 'User';
  if (event?.role === 'assistant') return 'AI';
  if (event?.role === 'tool') return lang === 'zh' ? '工具' : 'Tool';
  return event?.role ?? (lang === 'zh' ? '系统' : 'System');
}

export function reasoningContentSourceLabel(
  source: ExperienceTimelineEvent['contentSource'],
  lang: Lang,
): string {
  if (source === 'summary') return lang === 'zh' ? '来源：reasoning summary' : 'Source: reasoning summary';
  if (source === 'content') return lang === 'zh' ? '来源：reasoning content' : 'Source: reasoning content';
  return lang === 'zh' ? '来源：reasoning text' : 'Source: reasoning text';
}

export function eventPreview(event: ExperienceTimelineEvent | undefined, fallback: string): string {
  return event?.fullText?.trim() || event?.snippet?.trim() || fallback;
}

export function observableContextContent(event: ExperienceTimelineEvent | undefined): string | undefined {
  const fullText = event?.fullText?.trim();
  if (fullText && fullText !== '{}') return fullText;
  return event?.snippet?.trim() || undefined;
}
