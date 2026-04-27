/**
 * cc session JSONL → omk ResultEntry adapter (v0.18 skill-health)。
 *
 * 核心职责:
 *   1. 读 cc session JSONL 文件 / 目录
 *   2. 按 session 拆分、按 skill 信号切段(见 docs/skill-health-spec.md §四)
 *   3. 每段输出为一个 ResultEntry, variant key = skill 名
 *
 * skill 归属信号(spec §四):
 *   - 信号 1: tool_use name="Skill" 的 input.skill
 *   - 信号 2: user message 里的 <command-name>/X</command-name>
 *   - 无任何信号 → 'general'(裸 cc 对话,不丢弃)
 *
 * v0.18 不处理:
 *   - Skill tool 嵌套调用(扁平切段)
 *   - 信号 3 (Read .claude/skills/X/SKILL.md,留 v0.19)
 *   - 版本对齐(全部归到 skill 名下)
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { ResultEntry, ToolCallInfo, TurnInfo, VariantResult } from '../types/index.js';

// ---------- cc session JSONL raw schema (v0.18 subset) ----------

interface CcAssistantContent {
  type: 'thinking' | 'text' | 'tool_use';
  thinking?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface CcAssistantRecord {
  type: 'assistant';
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  cwd?: string;
  gitBranch?: string;
  message: {
    role: 'assistant';
    model?: string;
    content: CcAssistantContent[];
    stop_reason?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

interface CcUserToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

interface CcUserTextContent {
  type: 'text';
  text: string;
}

interface CcUserRecord {
  type: 'user';
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  message: {
    role: 'user';
    content: string | Array<CcUserTextContent | CcUserToolResultContent>;
  };
}

type CcRecord = CcAssistantRecord | CcUserRecord | { type: string; [k: string]: unknown };

// ---------- Session-level structure ----------

export interface CcSession {
  sessionId: string;
  sourcePath: string;
  // records 用 unknown[] 是有意为之: cc JSONL 里 permission-mode / file-history-snapshot /
  // 未来可能新增的 record type 都会共存, 严格 union 会拒绝合法输入。
  // segmentBySkill 内部按 type 字段做 structural type guard, 比静态类型约束更 robust。
  records: unknown[];
  cwd?: string;
  gitBranch?: string;
  startTimestamp?: string;
  endTimestamp?: string;
}

export interface SkillSegment {
  skillName: string;
  sessionId: string;
  segmentIndex: number;
  startTimestamp: string;
  endTimestamp: string;
  cwd?: string;
  turns: TurnInfo[];
  toolCalls: ToolCallInfo[];
  metrics: {
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    numTurns: number;
    numToolCalls: number;
    numToolFailures: number;
  };
}

// ---------- Load ----------

/**
 * 加载一个目录(或单个 JSONL 文件)下的所有 cc session。目录递归只一层(cc 的实际布局)。
 */
export function loadCcSessions(path: string): CcSession[] {
  const stat = statSync(path);
  if (stat.isFile()) {
    return [parseCcSessionFile(path)];
  }
  const entries = readdirSync(path)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => join(path, f));
  return entries.map(parseCcSessionFile).filter((s): s is CcSession => s !== null) as CcSession[];
}

function parseCcSessionFile(filePath: string): CcSession {
  const content = readFileSync(filePath, 'utf-8');
  const records: CcRecord[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as CcRecord);
    } catch {
      // malformed line → skip. cc 有罕见的截断 record, 不让单行 fail 整个 session
    }
  }
  const first = records.find((r) => 'sessionId' in r && typeof r.sessionId === 'string') as
    | (CcRecord & { sessionId: string; cwd?: string; gitBranch?: string; timestamp?: string })
    | undefined;
  const last = [...records].reverse().find((r) => 'timestamp' in r && typeof r.timestamp === 'string') as
    | (CcRecord & { timestamp?: string })
    | undefined;
  return {
    sessionId: first?.sessionId ?? filePath.split('/').pop()!.replace('.jsonl', ''),
    sourcePath: filePath,
    records,
    cwd: first?.cwd,
    gitBranch: first?.gitBranch,
    startTimestamp: first?.timestamp,
    endTimestamp: last?.timestamp,
  };
}

// ---------- Skill signal detection ----------

const COMMAND_NAME_RE = /<command-name>\/([^<]+)<\/command-name>/;

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
function normalizeSkillName(raw: string): string | null {
  // plugin-prefixed: pbakaus/impeccable:audit / impeccable:audit → 取最后一段
  const colonIdx = raw.lastIndexOf(':');
  const name = colonIdx >= 0 ? raw.slice(colonIdx + 1) : raw;
  if (CC_BUILTIN_COMMANDS.has(name)) return null;
  return name;
}

/**
 * 从 user message 里提取 slash-command skill 名字(信号 2)。
 * 返回 null 表示没命中。
 */
function extractCommandSkill(record: CcUserRecord): string | null {
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
  return raw ? normalizeSkillName(raw) : null;
}

/**
 * 从 assistant message 的 tool_use 里提取 Skill tool 调用的 skill 名字(信号 1)。
 * 返回 null 表示没命中。
 */
function extractSkillToolUse(record: CcAssistantRecord): string | null {
  for (const part of record.message.content) {
    if (part.type === 'tool_use' && part.name === 'Skill') {
      const skill = part.input?.skill;
      if (typeof skill === 'string') return normalizeSkillName(skill);
    }
  }
  return null;
}

const SKILL_READ_FILE_RE = /\.claude\/skills\/([^/]+)\/SKILL\.md$/;

/**
 * 从 assistant message 的 Read tool_use 里提取 skill 名字(信号 3, fallback)。
 * 匹配 file_path 形如 ".claude/skills/<name>/SKILL.md" 的模式。
 * 返回 null 表示没命中。
 */
function extractSkillReadFile(record: CcAssistantRecord): string | null {
  for (const part of record.message.content) {
    if (part.type === 'tool_use' && part.name === 'Read') {
      const filePath = part.input?.file_path;
      if (typeof filePath === 'string') {
        const m = SKILL_READ_FILE_RE.exec(filePath);
        if (m) return normalizeSkillName(m[1]);
      }
    }
  }
  return null;
}

// ---------- Segment by skill ----------

/**
 * 扫描 session records, 按 skill 信号把 tool calls 切成多段。
 * 一个 session 可能产生 1-N 个 SkillSegment。
 */
export function segmentBySkill(session: CcSession): SkillSegment[] {
  const segments: SkillSegment[] = [];
  let currentSkill = 'general';
  let currentSegment = createEmptySegment(session, currentSkill, 0);
  let segmentIndex = 0;

  // 用 tool_use_id → ToolCallInfo 的映射, 收到 tool_result 时回填 output / success
  const pendingToolUses = new Map<string, { toolCall: ToolCallInfo; segmentRef: SkillSegment }>();

  const flushCurrent = (): boolean => {
    if (currentSegment.turns.length > 0 || currentSegment.toolCalls.length > 0) {
      segments.push(currentSegment);
      return true;
    }
    return false;
  };

  const startNewSegment = (skillName: string, timestamp?: string): void => {
    // 空段被新信号替换时,不推进 segmentIndex(保持整洁的 0-based 编号)
    const wasNonEmpty = flushCurrent();
    if (wasNonEmpty) segmentIndex += 1;
    currentSegment = createEmptySegment(session, skillName, segmentIndex, timestamp);
    currentSkill = skillName;
  };

  for (const raw of session.records) {
    // records 是 unknown[], 按 type 字段做 structural type guard
    if (!raw || typeof raw !== 'object' || !('type' in raw)) continue;
    const rec = raw as { type: string };
    if (rec.type === 'user') {
      const u = rec as CcUserRecord;
      // 检测 skill 信号 2 (slash command)
      const cmdSkill = extractCommandSkill(u);
      if (cmdSkill && cmdSkill !== currentSkill) {
        startNewSegment(cmdSkill, u.timestamp);
      }
      // 处理 tool_result(回填之前的 tool_use)
      if (typeof u.message.content !== 'string') {
        for (const part of u.message.content) {
          if (part.type === 'tool_result') {
            const pending = pendingToolUses.get(part.tool_use_id);
            if (pending) {
              pending.toolCall.output = part.content;
              pending.toolCall.success = part.is_error !== true;
              if (part.is_error === true) {
                pending.segmentRef.metrics.numToolFailures += 1;
              }
              pendingToolUses.delete(part.tool_use_id);
            }
          }
        }
      }
      // user text 合并到 tool turn(简化处理, 不强区分角色)
      const textContent = extractUserText(u);
      if (textContent) {
        currentSegment.turns.push({ role: 'tool', content: textContent });
        currentSegment.metrics.numTurns += 1;
      }
      updateSegmentTimestamp(currentSegment, u.timestamp);
      continue;
    }
    if (rec.type === 'assistant') {
      const a = rec as CcAssistantRecord;
      // 检测 skill 信号 1 (Skill tool_use); 信号 3 (Read SKILL.md) 作 fallback,
      // 仅在当前段仍是 'general'(未被信号 1/2 命中过)时触发,避免压过更强信号。
      const skillTool = extractSkillToolUse(a);
      if (skillTool && skillTool !== currentSkill) {
        startNewSegment(skillTool, a.timestamp);
      } else if (!skillTool && currentSkill === 'general') {
        const readSkill = extractSkillReadFile(a);
        if (readSkill) {
          startNewSegment(readSkill, a.timestamp);
        }
      }
      // 提取 tool_use → ToolCallInfo(success 先标 true, 等 tool_result 回填)
      const toolCalls: ToolCallInfo[] = [];
      let assistantText = '';
      for (const part of a.message.content) {
        if (part.type === 'text' && part.text) assistantText += part.text;
        if (part.type === 'tool_use' && part.id && part.name) {
          const tc: ToolCallInfo = {
            tool: part.name,
            input: part.input ?? {},
            output: '',
            success: true,
          };
          toolCalls.push(tc);
          pendingToolUses.set(part.id, { toolCall: tc, segmentRef: currentSegment });
        }
      }
      if (toolCalls.length > 0 || assistantText) {
        currentSegment.turns.push({
          role: 'assistant',
          content: assistantText,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        });
        currentSegment.metrics.numTurns += 1;
        currentSegment.toolCalls.push(...toolCalls);
        currentSegment.metrics.numToolCalls += toolCalls.length;
      }
      // 累加 token usage
      const usage = a.message.usage;
      if (usage) {
        currentSegment.metrics.inputTokens += usage.input_tokens ?? 0;
        currentSegment.metrics.outputTokens += usage.output_tokens ?? 0;
        currentSegment.metrics.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
        currentSegment.metrics.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
      }
      updateSegmentTimestamp(currentSegment, a.timestamp);
      continue;
    }
    // 其他 type(permission-mode / file-history-snapshot) 直接 skip
  }

  flushCurrent();
  // 孤儿 tool_use(没对应 tool_result 的)保持 success=true, 但标记为未闭合
  return segments;
}

function createEmptySegment(session: CcSession, skillName: string, index: number, timestamp?: string): SkillSegment {
  const ts = timestamp ?? session.startTimestamp ?? new Date().toISOString();
  return {
    skillName,
    sessionId: session.sessionId,
    segmentIndex: index,
    startTimestamp: ts,
    endTimestamp: ts,
    cwd: session.cwd,
    turns: [],
    toolCalls: [],
    metrics: {
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      numTurns: 0,
      numToolCalls: 0,
      numToolFailures: 0,
    },
  };
}

function updateSegmentTimestamp(seg: SkillSegment, timestamp?: string): void {
  if (!timestamp) return;
  if (!seg.endTimestamp || timestamp > seg.endTimestamp) seg.endTimestamp = timestamp;
  // 重算 durationMs
  try {
    const start = new Date(seg.startTimestamp).getTime();
    const end = new Date(seg.endTimestamp).getTime();
    if (!Number.isNaN(start) && !Number.isNaN(end)) seg.metrics.durationMs = Math.max(0, end - start);
  } catch { /* skip */ }
}

function extractUserText(record: CcUserRecord): string {
  const content = record.message.content;
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const p of content) {
    if (p.type === 'text') parts.push(p.text);
    if (p.type === 'tool_result' && typeof p.content === 'string') parts.push(p.content);
  }
  return parts.join('\n');
}

// ---------- Segment → ResultEntry ----------

/**
 * SkillSegment[] → ResultEntry[] (omk 内部分析路径的标准输入)。
 *
 * 映射规则(详见 docs/skill-health-spec.md):
 *   - 每 segment 一个 ResultEntry
 *   - sample_id = `${sessionId}:${segmentIndex}`
 *   - variant key = skill 名(复用 omk 的 variant 维度作为 skill 分组维度)
 */
export function segmentsToResultEntries(segments: SkillSegment[]): ResultEntry[] {
  return segments.map((seg): ResultEntry => ({
    sample_id: `${seg.sessionId}:${seg.segmentIndex}`,
    variants: {
      [seg.skillName]: buildVariantResult(seg),
    },
  }));
}

function buildVariantResult(seg: SkillSegment): VariantResult {
  const totalTokens = seg.metrics.inputTokens + seg.metrics.outputTokens;
  const toolSuccessRate = seg.metrics.numToolCalls > 0
    ? (seg.metrics.numToolCalls - seg.metrics.numToolFailures) / seg.metrics.numToolCalls
    : 1;
  return {
    ok: true,
    durationMs: seg.metrics.durationMs,
    durationApiMs: seg.metrics.durationMs,
    inputTokens: seg.metrics.inputTokens,
    outputTokens: seg.metrics.outputTokens,
    totalTokens,
    cacheReadTokens: seg.metrics.cacheReadTokens,
    cacheCreationTokens: seg.metrics.cacheCreationTokens,
    execCostUSD: 0,
    judgeCostUSD: 0,
    costUSD: 0,
    numTurns: seg.metrics.numTurns,
    numToolCalls: seg.metrics.numToolCalls,
    numToolFailures: seg.metrics.numToolFailures,
    toolSuccessRate,
    toolNames: Array.from(new Set(seg.toolCalls.map((tc) => tc.tool))),
    outputPreview: null,
    turns: seg.turns,
    toolCalls: seg.toolCalls,
  };
}

// ---------- 顶层便捷入口 ----------

/**
 * 一站式:目录 → ResultEntry[]。
 */
export function ccTracesToResultEntries(path: string): { entries: ResultEntry[]; sessions: CcSession[]; segments: SkillSegment[] } {
  const sessions = loadCcSessions(path);
  const segments = sessions.flatMap(segmentBySkill);
  const entries = segmentsToResultEntries(segments);
  return { entries, sessions, segments };
}
