/** Skill attribution rules for trace records. */

import type { CcAssistantRecord, CcUserRecord } from './source.js';
import type { TraceMessageEvent, TraceToolCallEvent } from './trace-ir.js';
import { extractCodexExecCommands } from './adapters/codex/exec-command.js';

// ---------- Skill signal detection ----------

export interface SkillRef {
  skillName: string;
  rawSkillRef: string;
  pluginName?: string;
}

export function extractMarkdownLogSkill(text: string): string | null {
  const patterns = [
    /\b(?:prefer|use|call|invoke)\s+`?([a-zA-Z0-9][\w.-]*)`?\s+skill\b/i,
    /优先调用\s+`?([a-zA-Z0-9][\w.-]*)`?\s+skill/i,
    /调用\s+`?([a-zA-Z0-9][\w.-]*)`?\s+skill/i,
    /使用\s+`?([a-zA-Z0-9][\w.-]*)`?\s+skill/i,
    /`([a-zA-Z0-9][\w.-]*)`\s+skill/i,
    /\b([a-zA-Z0-9][\w.-]*-[\w.-]*)\s+skill\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const normalized = match?.[1] ? normalizeSkillName(match[1]) : null;
    if (normalized) return normalized;
  }
  return null;
}

const COMMAND_NAME_RE = /<command-name>\/([^<]+)<\/command-name>/;
const BUSINESS_ACTION_CMD_RE = /<[a-z][\w.-]*-cmd\b[^>]*\bname=["']([^"']+)["'][^>]*>/;
const COMMAND_ENVELOPE_RE = /<command-(?:name|message)>[\s\S]*?<\/command-(?:name|message)>/g;

// cc 内置 CLI 命令(不是 skill)。dogfood 数据中这些词频繁以 <command-name> 出现,
// 必须过滤掉才能得到真实 skill 分布。列表基于实测 + cc 常规命令集。
const CLAUDE_BUILTIN_COMMANDS = new Set([
  'clear', 'exit', 'quit', 'help', 'fast', 'effort', 'model',
  'plugin', 'stats', 'doctor', 'compact', 'cost', 'agents', 'init',
  'config', 'permissions', 'resume', 'continue', 'memory',
]);
const UNSAFE_SKILL_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const SKILL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

/**
 * 归一化 skill 名：去掉 plugin 前缀并校验稳定身份。
 * - "impeccable:audit" → "audit"
 * - "pbakaus/impeccable:audit" → "audit"
 */
export function normalizeSkillName(raw: string): string | null {
  return parseSkillRef(raw)?.skillName ?? null;
}

export function parseSkillRef(raw: string): SkillRef | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // plugin-prefixed: pbakaus/impeccable:audit / impeccable:audit → 取最后一段
  const colonIdx = trimmed.lastIndexOf(':');
  const name = (colonIdx >= 0 ? trimmed.slice(colonIdx + 1) : trimmed).trim();
  if (
    !SKILL_NAME_RE.test(name)
    || UNSAFE_SKILL_NAMES.has(name.toLowerCase())
  ) return null;
  const rawPluginName = colonIdx >= 0 ? trimmed.slice(0, colonIdx).trim() : undefined;
  const pluginName = rawPluginName && rawPluginName.length <= 256 ? rawPluginName : undefined;
  return {
    skillName: name,
    rawSkillRef: trimmed,
    pluginName: pluginName || undefined,
  };
}

export function stripCommandEnvelopeText(text: string): string {
  return text.replace(COMMAND_ENVELOPE_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

export function extractCommandEnvelopeText(text: string): string | null {
  const matches = text.match(COMMAND_ENVELOPE_RE);
  return matches?.join('\n') ?? null;
}

/**
 * 从 user message 里提取 slash-command skill 名字(信号 2)。
 * 返回 null 表示没命中。
 */
export function extractCommandSkill(record: CcUserRecord): string | null {
  return extractCommandSkillRef(record)?.skillName ?? null;
}

export function extractCommandSkillRef(record: CcUserRecord): SkillRef | null {
  const content = record.message.content;
  let raw: string | null = null;
  if (typeof content === 'string') {
    const m = COMMAND_NAME_RE.exec(content);
    raw = m ? m[1] : null;
  } else {
    for (const part of content) {
      if (part.type === 'text') {
        const m = COMMAND_NAME_RE.exec(part.text);
        if (m) { raw = m[1]; break; }
      }
    }
  }
  return raw && !isClaudeBuiltinCommand(raw) ? parseSkillRef(raw) : null;
}

export function isClaudeBuiltinCommand(raw: string): boolean {
  const trimmed = raw.trim();
  return !trimmed.includes(':') && CLAUDE_BUILTIN_COMMANDS.has(trimmed.toLowerCase());
}

/**
 * 从 OpenClaw user message 的业务动作标签里提取 skill 名字(信号 4)。
 *
 * 注意: 真实 OpenClaw 数据里 name 可能是业务动作展示名, 不是稳定 skill id。
 * 只有 name 本身像 "prd-create" 这种 slug 时才用于 skill 归因;
 * 展示名继续保留在 sourceMetadata.businessActions 里, 不切 skill。
 */
export function extractBusinessActionSkillRef(record: CcUserRecord): SkillRef | null {
  const content = record.message.content;
  let raw: string | null = null;
  if (typeof content === 'string') {
    const m = BUSINESS_ACTION_CMD_RE.exec(content);
    raw = m ? m[1] : null;
  } else {
    for (const part of content) {
      if (part.type === 'text') {
        const m = BUSINESS_ACTION_CMD_RE.exec(part.text);
        if (m) { raw = m[1]; break; }
      }
    }
  }
  return raw && isStableSkillSlug(raw) ? parseSkillRef(raw) : null;
}

function isStableSkillSlug(raw: string): boolean {
  const trimmed = raw.trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(trimmed) && /[-_.]/.test(trimmed);
}

/**
 * 从 assistant message 的 tool_use 里提取 Skill tool 调用的 skill 名字(信号 1)。
 * 返回 null 表示没命中。
 */
export function extractSkillToolUse(record: CcAssistantRecord): string | null {
  return extractSkillToolUseRef(record)?.skillName ?? null;
}

export function extractSkillToolUseRef(record: CcAssistantRecord): SkillRef | null {
  const content = Array.isArray(record.message.content) ? record.message.content : [];
  for (const part of content) {
    if (part.type === 'tool_use' && part.name === 'Skill') {
      const skill = part.input?.skill;
      if (typeof skill === 'string') return parseSkillRef(skill);
    }
  }
  return null;
}

export function extractAttributionSkill(record: CcAssistantRecord): string | null {
  return extractAttributionSkillRef(record)?.skillName ?? null;
}

export function extractAttributionSkillRef(record: CcAssistantRecord): SkillRef | null {
  return record.attributionSkill ? parseSkillRef(record.attributionSkill) : null;
}

// Only installed runtime roots count as attribution evidence. Repository examples
// such as `examples/foo/skills/bar/SKILL.md` are knowledge artifacts under review,
// not proof that the `bar` skill was active in the session.
const SKILL_READ_PATH_RE = /(?:^|[\s"'`(\[{:,])([^\s"'`]*\/skills\/(?:\.system\/)?[^/\s"'`]+\/SKILL\.md)\b/g;
const INSTALLED_SKILL_PATH_RES: RegExp[] = [
  /(?:^|\/)\.(?:agents|claude|codex)\/skills\/([^/]+)\/SKILL\.md$/,
  /(?:^|\/)\.codex\/skills\/\.system\/([^/]+)\/SKILL\.md$/,
  /(?:^|\/)\.codex\/plugins\/cache\/.+\/skills\/([^/]+)\/SKILL\.md$/,
  /(?:^|\/)\.openclaw\/workspace(?:-main)?\/skills\/([^/]+)\/SKILL\.md$/,
];
const SKILL_SCRIPT_PATH_RE = /(?:^|[\s"'`(\[{:,])(?:~|\.|\/)?[^\s"'`]*\/skills\/(?:\.system\/)?([^/\s"'`]+)\/scripts\/[^\s"'`]*/;

export function isInstalledSkillAssetPath(value: string, skillName: string): boolean {
  if (!value || !skillName) return false;
  const normalized = value.replaceAll('\\', '/');
  const segments = normalized.split('/');
  for (let index = 0; index < segments.length; index++) {
    if (segments[index] !== 'skills') continue;
    const nameIndex = segments[index + 1] === '.system' ? index + 2 : index + 1;
    if (segments[nameIndex] !== skillName || nameIndex + 1 >= segments.length) continue;
    const installationPrefix = segments.slice(0, index);
    if (
      installationPrefix.some((segment) =>
        segment === '.agents'
        || segment === '.claude'
        || segment === '.codex'
        || segment === '.openclaw')
    ) return true;
  }
  return false;
}

function extractInstalledSkillReadRef(text: string): SkillRef | null {
  const normalized = text.replaceAll('\\', '/');
  for (const match of normalized.matchAll(SKILL_READ_PATH_RE)) {
    const path = match[1];
    if (!path) continue;
    for (const pattern of INSTALLED_SKILL_PATH_RES) {
      const installed = path.match(pattern);
      if (installed?.[1]) return parseSkillRef(installed[1]);
    }
  }
  return null;
}

function splitShellCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let index = 0;
  while (index < command.length) {
    const char = command[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      index += 1;
      continue;
    }
    const separatorLength = command.startsWith('&&', index) || command.startsWith('||', index)
      ? 2
      : char === ';' || char === '|' || char === '\n'
        ? 1
        : 0;
    if (separatorLength > 0) {
      segments.push(command.slice(start, index));
      index += separatorLength;
      start = index;
      continue;
    }
    index += 1;
  }
  segments.push(command.slice(start));
  return segments;
}

const SHELL_FILE_READER_RE = /^(?:(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*)?(?:(?:command|sudo)\s+)*(?:[\w./-]+\/)?(?:cat|sed|head|tail|less|more|bat|awk|wc)\b/;

function extractShellSkillReadRef(command: string): SkillRef | null {
  for (const segment of splitShellCommandSegments(command)) {
    const normalized = segment.trim();
    if (!SHELL_FILE_READER_RE.test(normalized)) continue;
    const skillRef = extractInstalledSkillReadRef(normalized);
    if (skillRef) return skillRef;
  }
  return null;
}

/**
 * 从 assistant message 的 Read / Bash tool_use 里提取 skill 名字(信号 3, fallback)。
 * Codex 通常用 shell 读取 `.agents/skills/<name>/SKILL.md`，Claude Code 与
 * OpenClaw 则更常用结构化 Read tool；两种形式统一识别。
 * 返回 null 表示没命中。
 */
export function extractSkillReadFile(record: CcAssistantRecord): string | null {
  return extractSkillReadFileRef(record)?.skillName ?? null;
}

export function extractSkillReadFileRef(record: CcAssistantRecord): SkillRef | null {
  const content = Array.isArray(record.message.content) ? record.message.content : [];
  for (const part of content) {
    if (part.type === 'tool_use' && part.name === 'Read') {
      const filePath = part.input?.file_path;
      if (typeof filePath === 'string') {
        const skillRef = extractInstalledSkillReadRef(filePath);
        if (skillRef) return skillRef;
      }
    }
    if (
      part.type === 'tool_use'
      && (
        part.name === 'Bash'
        || part.name?.toLowerCase() === 'exec'
        || part.name?.toLowerCase() === 'js'
      )
    ) {
      const rawCommand = part.name === 'Bash'
        ? part.input?.command
        : part.input?.input ?? part.input?.code ?? part.input?.command;
      const commands = typeof rawCommand !== 'string'
        ? []
        : part.name === 'Bash'
          ? [rawCommand]
          : extractCodexExecCommands(rawCommand);
      for (const command of commands) {
        const skillRef = extractShellSkillReadRef(command);
        if (skillRef) return skillRef;
      }
    }
  }
  return null;
}

/**
 * 从 OpenClaw cron/user 文本或 Bash/exec tool command 里提取 skill 脚本路径。
 *
 * cron 型 OpenClaw session 通常没有业务动作标签或 Skill tool_use,
 * 只会直接执行 ~/.openclaw/workspace-main/skills/<skill>/scripts/*.sh。
 */
export function extractSkillScriptCommandRef(record: CcUserRecord | CcAssistantRecord): SkillRef | null {
  const texts: string[] = [];
  const content = record.message.content;
  if (typeof content === 'string') {
    texts.push(content);
  } else {
    for (const part of content) {
      if (part.type === 'text' && typeof part.text === 'string') {
        texts.push(part.text);
      } else if (part.type === 'tool_use') {
        const rawCommand = part.name?.toLowerCase() === 'exec'
          ? part.input?.input ?? part.input?.code ?? part.input?.command
          : part.input?.code ?? part.input?.command;
        if (typeof rawCommand === 'string') {
          texts.push(...(part.name?.toLowerCase() === 'exec'
            ? extractCodexExecCommands(rawCommand)
            : [rawCommand]));
        }
      }
    }
  }
  for (const text of texts) {
    const match = SKILL_SCRIPT_PATH_RE.exec(text);
    if (match?.[1]) {
      const ref = parseSkillRef(match[1]);
      if (ref && isInstalledSkillAssetPath(match[0], ref.skillName)) return ref;
    }
  }
  return null;
}

export function extractCommandSkillRefFromEvent(
  event: TraceMessageEvent,
): SkillRef | null {
  const match = COMMAND_NAME_RE.exec(event.text);
  const raw = match?.[1];
  if (!raw) return null;
  return parseSkillRef(raw);
}

export function extractBusinessActionSkillRefFromEvent(event: TraceMessageEvent): SkillRef | null {
  const match = BUSINESS_ACTION_CMD_RE.exec(event.text);
  const raw = match?.[1];
  return raw && isStableSkillSlug(raw) ? parseSkillRef(raw) : null;
}

export function extractAttributionSkillRefFromEvent(event: TraceMessageEvent): SkillRef | null {
  return event.attributionSkill ? parseSkillRef(event.attributionSkill) : null;
}

export function extractSkillToolUseRefFromEvent(event: TraceToolCallEvent): SkillRef | null {
  if (event.tool.name !== 'Skill') return null;
  const skill = event.input.skill;
  return typeof skill === 'string' ? parseSkillRef(skill) : null;
}

export function extractSkillReadFileRefFromEvent(event: TraceToolCallEvent): SkillRef | null {
  if (event.tool.name === 'Read') {
    const filePath = event.input.file_path;
    return typeof filePath === 'string' ? extractInstalledSkillReadRef(filePath) : null;
  }
  if (
    event.tool.name !== 'Bash'
    && event.tool.name.toLowerCase() !== 'exec'
    && event.tool.sourceName?.toLowerCase() !== 'exec'
    && event.tool.name !== 'node_repl.js'
    && event.tool.name.toLowerCase() !== 'js'
    && event.tool.sourceName?.toLowerCase() !== 'js'
  ) return null;
  const rawCommand = event.input.command ?? event.input.input ?? event.input.code;
  if (typeof rawCommand !== 'string') return null;
  const sourceName = event.tool.sourceName?.toLowerCase();
  const isOrchestrationWrapper = sourceName === 'exec'
    || sourceName === 'js'
    || event.tool.name === 'node_repl.js'
    || event.tool.name.toLowerCase() === 'js';
  const normalizedCommands = Array.isArray(event.input.commands)
    ? event.input.commands.filter((value): value is string => typeof value === 'string')
    : [];
  const commands = normalizedCommands.length > 0
    ? normalizedCommands
    : isOrchestrationWrapper
      ? extractCodexExecCommands(rawCommand)
      : [rawCommand];
  for (const command of commands) {
    const skillRef = extractShellSkillReadRef(command);
    if (skillRef) return skillRef;
  }
  return null;
}

export function extractSkillScriptCommandRefFromEvent(
  event: TraceMessageEvent | TraceToolCallEvent,
): SkillRef | null {
  const texts = event.eventKind === 'message'
    ? [event.text]
    : typeof (event.input.command ?? event.input.input ?? event.input.code) === 'string'
      ? [String(event.input.command ?? event.input.input ?? event.input.code)]
      : [];
  for (const text of texts) {
    const match = SKILL_SCRIPT_PATH_RE.exec(text);
    if (match?.[1]) {
      const ref = parseSkillRef(match[1]);
      if (ref && isInstalledSkillAssetPath(match[0], ref.skillName)) return ref;
    }
  }
  return null;
}
