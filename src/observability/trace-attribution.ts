/** Skill attribution rules for trace records. */

import type { CcAssistantRecord, CcUserRecord } from './trace-source.js';

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
const AIMA_CMD_RE = /<aima-cmd\b[^>]*\bname=["']([^"']+)["'][^>]*>/;
const COMMAND_ENVELOPE_RE = /<command-(?:name|message)>[\s\S]*?<\/command-(?:name|message)>/g;

// cc 内置 CLI 命令(不是 skill)。dogfood 数据中这些词频繁以 <command-name> 出现,
// 必须过滤掉才能得到真实 skill 分布。列表基于实测 + cc 常规命令集。
const CC_BUILTIN_COMMANDS = new Set([
  'clear', 'exit', 'quit', 'help', 'fast', 'effort', 'model',
  'plugin', 'stats', 'doctor', 'compact', 'cost', 'agents', 'init',
  'config', 'permissions', 'resume', 'continue', 'memory',
]);

/**
 * 归一化 skill 名: 去掉 plugin 前缀, 过滤 cc 内置命令。
 * - "impeccable:audit" → "audit"
 * - "pbakaus/impeccable:audit" → "audit"
 * - "clear" / "exit" 等 → null(表示不是 skill)
 */
export function normalizeSkillName(raw: string): string | null {
  return parseSkillRef(raw)?.skillName ?? null;
}

export function parseSkillRef(raw: string): SkillRef | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // plugin-prefixed: pbakaus/impeccable:audit / impeccable:audit → 取最后一段
  const colonIdx = trimmed.lastIndexOf(':');
  const name = colonIdx >= 0 ? trimmed.slice(colonIdx + 1) : trimmed;
  if (CC_BUILTIN_COMMANDS.has(name)) return null;
  const pluginName = colonIdx >= 0 ? trimmed.slice(0, colonIdx) : undefined;
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
  return raw ? parseSkillRef(raw) : null;
}

/**
 * 从 OpenClaw / AIMA user message 里提取 aima-cmd skill 名字(信号 4)。
 *
 * 注意: 真实 OpenClaw 数据里 name 可能是业务动作展示名, 例如 "生成PRD" / "生成Demo",
 * 这不是稳定 skill id。只有 name 本身像 "prd-create" 这种 slug 时才用于 skill 归因;
 * 中文动作名继续保留在 sourceMetadata.aimaCommands 里, 不切 skill。
 */
export function extractAimaCmdSkillRef(record: CcUserRecord): SkillRef | null {
  const content = record.message.content;
  let raw: string | null = null;
  if (typeof content === 'string') {
    const m = AIMA_CMD_RE.exec(content);
    raw = m ? m[1] : null;
  } else {
    for (const part of content) {
      if (part.type === 'text') {
        const m = AIMA_CMD_RE.exec(part.text);
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

const SKILL_READ_FILE_RE = /(?:\.claude\/skills|\.openclaw\/workspace\/skills)\/([^/]+)\/SKILL\.md$/;

/**
 * 从 assistant message 的 Read tool_use 里提取 skill 名字(信号 3, fallback)。
 * 匹配 file_path 形如 ".claude/skills/<name>/SKILL.md"
 * 或 ".openclaw/workspace/skills/<name>/SKILL.md" 的模式。
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
        const m = SKILL_READ_FILE_RE.exec(filePath);
        if (m) return parseSkillRef(m[1]);
      }
    }
  }
  return null;
}
