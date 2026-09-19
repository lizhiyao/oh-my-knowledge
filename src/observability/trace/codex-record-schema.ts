import type { RecordSchemaNode } from './jsonl-record-schema.js';

/**
 * Codex 记录族的**装配声明**：大日志的读取层按它一趟取出一条记录真正被消费的字段，
 * 不再逐条 `JSON.parse` 整行（#974 判据②）。
 *
 * 只有实测从不产出 `unknown` 事件的分支才进这张表。原因：`unknown` 事件把整条记录带走，
 * `rawBytes`／`rawDigest` 按「整条记录的序列化」算，少装一个键就改变产物数字。没进表的分支
 * 由读取层退回整条 `JSON.parse`，语义与改造前逐字相同；将来出现的新记录族默认走整体解析。
 *
 * 本表由仓库外的一次性生成器从真实语料的消费侧读面枚举生成（探针要把会话结果也序列化一遍——
 * 事件会把记录子树整个带走，只数「被逐个读过的键」会少装字段）。改动适配器读取面后重新生成，
 * 并以全量语料的「装配视图 ≡ 整档解析」逐文件指纹对照把关。
 */


const V: RecordSchemaNode = { read: 'value' };

const compacted: RecordSchemaNode = {
  read: 'object',
  members: { timestamp: V, type: V, payload: { read: 'branch', on: 'type', cases: { "-": { read: 'object', members: { id: V, message: V, replacement_history: V, summary: V, type: V } } } } },
};

const event_msg: RecordSchemaNode = {
  read: 'object',
  members: { timestamp: V, type: V, payload: { read: 'branch', on: 'type', cases: { agent_message: { read: 'object', members: { id: V, message: V, type: V } }, agent_reasoning: { read: 'object', members: { id: V, message: V, text: V, type: V } }, task_complete: { read: 'object', members: { id: V, message: V, type: V } }, task_started: { read: 'object', members: { id: V, message: V, turn_id: V, type: V } }, thread_goal_updated: { read: 'object', members: { goal: { read: 'object', members: { objective: V, status: V } }, id: V, message: V, summary: V, type: V } }, thread_settings_applied: { read: 'object', members: { id: V, message: V, thread_settings: { read: 'object', members: { approval_policy: V, approvals_reviewer: V, collaboration_mode: { read: 'object', members: { mode: V } }, cwd: V, model: V, model_provider_id: V, permission_profile: { read: 'object', members: { type: V } }, personality: V, reasoning_effort: V, reasoning_summary: V, sandbox_policy: V, service_tier: V, summary: V } }, type: V } }, token_count: { read: 'object', members: { id: V, info: { read: 'object', members: { last_token_usage: { read: 'object', members: { cache_write_input_tokens: V, cached_input_tokens: V, input_tokens: V, output_tokens: V, reasoning_output_tokens: V, total_tokens: V } }, total_token_usage: { read: 'object', members: { cache_write_input_tokens: V, cached_input_tokens: V, input_tokens: V, output_tokens: V, reasoning_output_tokens: V, total_tokens: V } } } }, message: V, rate_limits: V, type: V } }, turn_aborted: { read: 'object', members: { duration_ms: V, id: V, message: V, reason: V, turn_id: V, type: V } }, user_message: { read: 'object', members: { id: V, message: V, type: V } } } } },
};

const inter_agent_communication_metadata: RecordSchemaNode = {
  read: 'object',
  members: { timestamp: V, type: V, payload: { read: 'branch', on: 'type', cases: { "-": { read: 'object', members: { id: V, type: V } } } } },
};

const response_item: RecordSchemaNode = {
  read: 'object',
  members: { timestamp: V, type: V, payload: { read: 'branch', on: 'type', cases: { agent_message: V, custom_tool_call: { read: 'object', members: { arguments: V, call_id: V, id: V, input: V, name: V, namespace: V, type: V } }, custom_tool_call_output: { read: 'object', members: { call_id: V, id: V, output: { read: 'array', element: { read: 'object', members: { output_text: V, text: V, type: V } } }, status: V, type: V } }, function_call: { read: 'object', members: { arguments: V, call_id: V, id: V, input: V, name: V, namespace: V, type: V } }, function_call_output: { read: 'object', members: { call_id: V, id: V, output: { read: 'array', element: { read: 'object', members: { output_text: V, text: V, type: V } } }, status: V, type: V } }, message: { read: 'object', members: { content: { read: 'array', element: { read: 'object', members: { output_text: V, text: V, type: V } } }, id: V, role: V, type: V } }, reasoning: { read: 'object', members: { content: V, encrypted_content: V, id: V, reasoning_text: V, reasoningText: V, summary: { read: 'array', element: { read: 'object', members: { text: V } } }, text: V, type: V } }, tool_search_call: { read: 'object', members: { arguments: V, call_id: V, id: V, type: V } }, tool_search_output: { read: 'object', members: { call_id: V, execution: V, id: V, status: V, tools: V, type: V } }, web_search_call: { read: 'object', members: { action: V, id: V, query: V, status: V, type: V } } } } },
};

const session_meta: RecordSchemaNode = {
  read: 'object',
  members: { timestamp: V, type: V, payload: { read: 'branch', on: 'type', cases: { "-": { read: 'object', members: { base_instructions: { read: 'object', members: { text: V } }, cli_version: V, context_window: { read: 'object', members: { window_id: V } }, cwd: V, dynamic_tools: { read: 'array', element: { read: 'object', members: { name: V, namespace: V } } }, git: { read: 'object', members: { branch: V } }, history_mode: V, id: V, memory_mode: V, model_provider: V, multi_agent_version: V, originator: V, parent_thread_id: V, source: { read: 'object', members: { subagent: { read: 'object', members: { other: V } } } }, thread_source: V, timestamp: V, type: V } } } } },
};

const turn_context: RecordSchemaNode = {
  read: 'object',
  members: { timestamp: V, type: V, payload: { read: 'branch', on: 'type', cases: { "-": { read: 'object', members: { approval_policy: V, approvals_reviewer: V, collaboration_mode: { read: 'object', members: { mode: V } }, current_date: V, cwd: V, effort: V, id: V, model: V, multi_agent_mode: V, multi_agent_version: V, permission_profile: { read: 'object', members: { type: V } }, personality: V, realtime_active: V, sandbox_policy: { read: 'object', members: { type: V } }, summary: V, timezone: V, turn_id: V, type: V, user_instructions: V, workspace_roots: { read: 'array', element: V } } } } } },
};

const world_state: RecordSchemaNode = {
  read: 'object',
  members: { timestamp: V, type: V, payload: { read: 'branch', on: 'type', cases: { "-": { read: 'object', members: { id: V, type: V } } } } },
};

export const CODEX_RECORD_SCHEMA_CASES: Readonly<Record<string, RecordSchemaNode>> = {
  compacted: compacted,
  event_msg: event_msg,
  inter_agent_communication_metadata: inter_agent_communication_metadata,
  response_item: response_item,
  session_meta: session_meta,
  turn_context: turn_context,
  world_state: world_state,
};

export const CODEX_RECORD_SCHEMA: RecordSchemaNode = {
  read: 'branch',
  on: 'type',
  cases: CODEX_RECORD_SCHEMA_CASES,
};
