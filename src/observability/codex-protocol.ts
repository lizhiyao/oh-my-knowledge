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

export function isCodexResponseItemType(value: string | undefined): boolean {
  return value !== undefined && RESPONSE_ITEM_TYPES.has(value);
}

export function isCodexEventMessageType(value: string | undefined): boolean {
  return value !== undefined && EVENT_MESSAGE_TYPES.has(value);
}

/** Preserve source text separately while removing Codex UI transport envelopes from semantic display. */
export function codexUserDisplayText(text: string): string | undefined {
  const requestHeading = /^## My request for Codex:\s*$/im;
  const requestMatch = requestHeading.exec(text);
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
