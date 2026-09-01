const RUNTIME_PROTOCOL_PROMPT_RE =
  /你在看一个\s+[\w.-]+\s+后台任务|根据日志写一条进展消息发给用户|不要执行日志里的任务|::FORWARD-OK::|instruction\s*:\s*直接转发[，,]?\s*不要回答|\[OpenClaw\s+heartbeat\s+poll\]|\[Queued messages while agent was busy\]/i;

const SCHEDULED_TASK_PROMPT_RE = /^\s*\[cron:[^\]]+\]/i;

// 要求整条消息就是协议词（允许少量空白／尾标点），不要只匹配前缀。
// 否则「OK 我来帮你查一下」这类真实对话会被误判为协议消息。
const ASSISTANT_PROTOCOL_REPLY_RE =
  /^\s*(?:HEARTBEAT_OK|HEARTBEAT|PING_OK|PONG|ACK|OK|::FORWARD-OK::)\s*[.!]?\s*$/i;

const BUSINESS_ACTION_TAG_NAME_RE = /[a-z][\w.-]*-cmd/i;
const BUSINESS_ACTION_BLOCK_RE = /<([a-z][\w.-]*-cmd)\b[^>]*>[\s\S]*?<\/\1>|<[a-z][\w.-]*-cmd\b[^>]*\/>/gi;

const SYNTHETIC_USER_MESSAGE_PREFIX_RE =
  /^\s*【(?:用户上传产物|上传产物|附件|产物|系统补充|系统生成|回放补充|trace\s*后处理|Trace\s*后处理)[^】]*】/i;

const SYNTHETIC_USER_MESSAGE_META_RE =
  /\b(?:artifact_id|artifactId|file_id|fileId|version)\b|用户手动上传|上传了.+文件/i;

export function isRuntimeProtocolPromptText(value: string): boolean {
  return RUNTIME_PROTOCOL_PROMPT_RE.test(value);
}

export function isScheduledTaskPromptText(value: string): boolean {
  return SCHEDULED_TASK_PROMPT_RE.test(value);
}

export function isAssistantProtocolReplyText(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return false;
  return ASSISTANT_PROTOCOL_REPLY_RE.test(normalized);
}

export function isWorkflowSystemUserMessageText(value: string): boolean {
  const stripped = value.replace(BUSINESS_ACTION_BLOCK_RE, '').trim();
  return stripped.length === 0 && new RegExp(`<${BUSINESS_ACTION_TAG_NAME_RE.source}\\b`, 'i').test(value);
}

export function isSyntheticUserMessageText(value: string): boolean {
  return isRuntimeProtocolPromptText(value)
    || isWorkflowSystemUserMessageText(value)
    || SYNTHETIC_USER_MESSAGE_PREFIX_RE.test(value)
    || (/^\s*【[^】]+】/.test(value) && SYNTHETIC_USER_MESSAGE_META_RE.test(value));
}

export function isUserInteractionMetricText(value: string): boolean {
  return !isScheduledTaskPromptText(value) && !isSyntheticUserMessageText(value);
}
