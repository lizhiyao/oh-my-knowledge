/** Stable inventory of Codex rollout record shapes understood by OMK. */

const RESPONSE_ITEM_TYPES: ReadonlySet<string> = new Set([
  'message',
  'reasoning',
  'tool_search_call',
  'tool_search_output',
  'web_search_call',
  'image_generation_call',
  'function_call',
  'custom_tool_call',
  'function_call_output',
  'custom_tool_call_output',
  'agent_message',
]);

const EVENT_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'token_count',
  'task_started',
  'task_complete',
  'turn_aborted',
  'turn_interrupted',
  'user_message',
  'agent_message',
  'mcp_tool_call_end',
  'patch_apply_end',
  'agent_reasoning',
  'thread_settings_applied',
  'web_search_end',
  'context_compacted',
  'image_generation_end',
  'thread_goal_updated',
  'sub_agent_activity',
]);

const IN_APP_BROWSER_CONTEXT_RE = /<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/gi;
const CODEX_RUNTIME_MESSAGE_RE = /^# AGENTS\.md instructions\b|^<(?:app-context|environment_context|permissions instructions|collaboration_mode|apps_instructions|plugins_instructions|skills_instructions|recommended_plugins)>/i;
const CODEX_USER_REQUEST_HEADING_RE = /^## My request(?: for Codex)?:\s*$/im;
const CODEX_USER_FILES_HEADING_RE = /^# Files mentioned by the user:\s*$/im;
const IMAGE_ATTACHMENT_RE = /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|webp)$/i;

export interface CodexUserAttachment {
  attachmentKind: 'image' | 'file';
  name: string;
}

export function isCodexResponseItemType(value: string | undefined): boolean {
  return value !== undefined && RESPONSE_ITEM_TYPES.has(value);
}

export function isCodexEventMessageType(value: string | undefined): boolean {
  return value !== undefined && EVENT_MESSAGE_TYPES.has(value);
}

/** Preserve source text separately while removing Codex UI transport envelopes from semantic display. */
export function codexUserDisplayText(text: string): string | undefined {
  const requestMatch = CODEX_USER_REQUEST_HEADING_RE.exec(text);
  const request = requestMatch
    ? text.slice(requestMatch.index + requestMatch[0].length)
    : text;
  const visible = request
    .replace(IN_APP_BROWSER_CONTEXT_RE, ' ')
    .replace(/<image\b[^>]*>[\s\S]*?<\/image>/gi, ' ')
    .replace(/\[Image\s+#\d+\]/gi, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return visible || undefined;
}

/** Extract privacy-safe attachment metadata without projecting local paths into Trace IR. */
export function codexUserAttachments(text: string): CodexUserAttachment[] {
  const attachments = new Map<string, CodexUserAttachment>();
  const requestMatch = CODEX_USER_REQUEST_HEADING_RE.exec(text);
  const filesMatch = CODEX_USER_FILES_HEADING_RE.exec(text);
  if (filesMatch && (!requestMatch || filesMatch.index < requestMatch.index)) {
    const sectionEnd = requestMatch?.index ?? text.length;
    const section = text.slice(filesMatch.index + filesMatch[0].length, sectionEnd);
    for (const match of section.matchAll(/^##\s+(.+?):\s+(.+)\s*$/gm)) {
      addCodexUserAttachment(attachments, match[1], match[2]);
    }
  }

  for (const match of text.matchAll(/<image\b[^>]*\bpath="([^"]+)"[^>]*>/gi)) {
    addCodexUserAttachment(attachments, undefined, match[1]);
  }
  return [...attachments.values()];
}

function addCodexUserAttachment(
  attachments: Map<string, CodexUserAttachment>,
  declaredName: string | undefined,
  sourcePath: string | undefined,
): void {
  const normalizedPath = sourcePath?.trim();
  const inferredName = normalizedPath?.split(/[\\/]/).at(-1);
  const name = declaredName?.trim() || inferredName?.trim();
  if (!name) return;
  const key = name.toLocaleLowerCase('en-US');
  if (attachments.has(key)) return;
  attachments.set(key, {
    attachmentKind: IMAGE_ATTACHMENT_RE.test(name) || IMAGE_ATTACHMENT_RE.test(normalizedPath ?? '')
      ? 'image'
      : 'file',
    name,
  });
}

export function codexUserMessageOrigin(text: string): 'human' | 'runtime' {
  const trimmed = text.trimStart();
  if (CODEX_RUNTIME_MESSAGE_RE.test(trimmed)) return 'runtime';
  if (/^<in-app-browser-context\b/i.test(trimmed) && !codexUserDisplayText(text)) return 'runtime';
  return 'human';
}

/**
 * Records consumed by correlation or retained only as source provenance do not
 * emit a standalone Trace IR event. Keeping this inventory explicit preserves
 * `unknown` as a forward-compatibility warning.
 */
export function isCodexRecordConsumedWithoutDirectEvent(
  recordType: unknown,
  payloadType: string | undefined,
): boolean {
  if (recordType === 'world_state') return true;
  if (recordType === 'inter_agent_communication_metadata') return true;
  if (recordType !== 'event_msg') return false;
  return payloadType === 'web_search_end'
    || payloadType === 'image_generation_end';
}
