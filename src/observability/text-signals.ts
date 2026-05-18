export const HARD_RULE_TEXT_RE = /hard rules?|必须|不要|禁止|严格|一定要|务必|不得|不能|只允许/i;

const RUNTIME_PROTOCOL_PROMPT_RE =
  /你在看一个\s+[\w.-]+\s+后台任务|根据日志写一条进展消息发给用户|不要执行日志里的任务|::FORWARD-OK::|instruction\s*:\s*直接转发[，,]?\s*不要回答|\[OpenClaw\s+heartbeat\s+poll\]|\[Queued messages while agent was busy\]/i;

const SCHEDULED_TASK_PROMPT_RE = /^\s*\[cron:[^\]]+\]/i;

const ASSISTANT_PROTOCOL_REPLY_RE =
  /^\s*(?:HEARTBEAT_OK|HEARTBEAT|PING_OK|PONG|ACK|OK|::FORWARD-OK::)(?:\s|\n|$)/i;

const AIMA_CMD_BLOCK_RE = /<aima-cmd\b[^>]*>[\s\S]*?<\/aima-cmd>|<aima-cmd\b[^>]*\/>/gi;

const SYNTHETIC_USER_MESSAGE_PREFIX_RE =
  /^\s*【(?:用户上传产物|上传产物|附件|产物|系统补充|系统生成|回放补充|trace\s*后处理|Trace\s*后处理)[^】]*】/i;

const SYNTHETIC_USER_MESSAGE_META_RE =
  /\b(?:artifact_id|artifactId|file_id|fileId|version)\b|用户手动上传|上传了.+文件/i;

const ASSISTANT_DELIVERY_SIGNAL_RE =
  /```(?:mermaid|plantuml|json|tsx?|jsx?|html|css|excalidraw|markdown)?|直接生成|已生成|生成如下|结果如下|如下|完成|已完成|这里是|给出|输出/i;

const ASSISTANT_PROGRESS_UPDATE_RE =
  /已发送进展|进展消息|进度更新|状态更新|正在|仍在|继续|处理中|整理中|分析中|生成中|执行中|采集中|获取中|即将|预计|稍后|子\s*Claude|后台任务/i;

const ASSISTANT_FINAL_DELIVERY_RE =
  /最终结果|最终报告|完整结果|完整报告|结果如下|报告如下|已完成[，,。:：]\s*(?:结果|报告|如下)|(?:任务|方案|文档|报告|demo|代码|页面)?已完成\s*(?:✅|[，,。:：]\s*(?:方案路径|产物路径|文档路径|结果|报告|如下))|(?:方案路径|产物路径|文档路径|结果文件|输出路径)\s*[:：]/i;

export const ASSISTANT_DELIVERABLE_ARTIFACT_RE =
  /```(?:mermaid|plantuml|json|tsx?|jsx?|html|css|excalidraw|markdown)?|https?:\/\/\S+|(?:文档|报告|方案|demo|Demo|预览|产物|文件|页面|dashboard|看板)(?:链接|地址|路径|URL)|(?:已生成|已创建|已写入|已保存|上传).{0,16}(?:文件|文档|报告|页面|demo|Demo|dashboard|看板|产物)|(?:^|[\s"'`(])(?:\/[\w.-]+){2,}\.(?:md|html|tsx?|jsx?|json|png|jpe?g|pdf|docx?|pptx?|xlsx?|csv)\b|(?:^|[\s"'`(])[\w.-]+\.(?:md|html|tsx?|jsx?|json|png|jpe?g|pdf|docx?|pptx?|xlsx?|csv)\b/i;

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
  const stripped = value.replace(AIMA_CMD_BLOCK_RE, '').trim();
  return stripped.length === 0 && /<aima-cmd\b/i.test(value);
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

export function hasUserHardRuleText(value: string): boolean {
  if (isRuntimeProtocolPromptText(value) || !isUserInteractionMetricText(value)) return false;
  if (/hard rules?/i.test(value)) return true;
  if (/必须|严格|一定要|务必|不得|只允许/i.test(value)) return true;
  if (/(?:不要|禁止)(?:省略|遗漏|改动|修改|执行|输出|使用|调用|生成|删除|跳过|猜|编|问|返回|展示|写入|覆盖|提交|发布|发送|回复)/i.test(value)) return true;
  if (/不能(?:省略|遗漏|改动|修改|执行|输出|使用|调用|生成|删除|跳过|猜|编|问|返回|展示|写入|覆盖|提交|发布|发送|回复)/i.test(value)) return true;
  return false;
}

export function isAssistantProgressUpdateText(value: string): boolean {
  return ASSISTANT_PROGRESS_UPDATE_RE.test(value) && !ASSISTANT_FINAL_DELIVERY_RE.test(value);
}

export function hasAssistantDeliverySignalText(value: string): boolean {
  return ASSISTANT_FINAL_DELIVERY_RE.test(value)
    || (ASSISTANT_DELIVERY_SIGNAL_RE.test(value) && !isAssistantProgressUpdateText(value));
}

export function hasAssistantDeliverableArtifactText(value: string): boolean {
  return ASSISTANT_DELIVERABLE_ARTIFACT_RE.test(value);
}

export function isToolResultFailureText(value: string): boolean {
  if (toolResultFailureJson(value)) return true;
  return /(?:^|\b)(?:status|state)\s*[:=]\s*["']?(?:error|failed|failure)["']?/i.test(value)
    || /\berror\s*[:=]\s*(?!false|null|0\b).+/i.test(value);
}

function toolResultFailureJson(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return false;
  try {
    return containsToolFailureSignal(JSON.parse(trimmed), 0);
  } catch {
    return false;
  }
}

function containsToolFailureSignal(value: unknown, depth: number): boolean {
  if (depth > 5 || value === null || value === undefined) return false;
  if (typeof value === 'string') return toolResultFailureJson(value);
  if (typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => containsToolFailureSignal(item, depth + 1));

  const record = value as Record<string, unknown>;
  for (const [key, raw] of Object.entries(record)) {
    const normalizedKey = key.toLowerCase();
    if ((normalizedKey === 'status' || normalizedKey === 'state') && typeof raw === 'string' && /^(error|failed|failure)$/i.test(raw.trim())) return true;
    if ((normalizedKey === 'iserror' || normalizedKey === 'is_error') && raw === true) return true;
    if (normalizedKey === 'success' && raw === false) return true;
    if (normalizedKey === 'error' && raw !== false && raw !== null && raw !== undefined && raw !== '') return true;
    if ((normalizedKey === 'body' || normalizedKey === 'result' || normalizedKey === 'data') && containsToolFailureSignal(raw, depth + 1)) return true;
  }
  return false;
}
