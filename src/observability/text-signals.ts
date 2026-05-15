export const HARD_RULE_TEXT_RE = /hard rules?|必须|不要|禁止|严格|一定要|务必|不得|不能|只允许/i;

const RUNTIME_PROTOCOL_PROMPT_RE =
  /你在看一个\s+[\w.-]+\s+后台任务|根据日志写一条进展消息发给用户|不要执行日志里的任务|::FORWARD-OK::|instruction\s*:\s*直接转发[，,]?\s*不要回答/i;

const SCHEDULED_TASK_PROMPT_RE = /^\s*\[cron:[^\]]+\]/i;

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
  /最终结果|最终报告|完整结果|完整报告|结果如下|报告如下|已完成[，,。:：]\s*(?:结果|报告|如下)/i;

export function isRuntimeProtocolPromptText(value: string): boolean {
  return RUNTIME_PROTOCOL_PROMPT_RE.test(value);
}

export function isScheduledTaskPromptText(value: string): boolean {
  return SCHEDULED_TASK_PROMPT_RE.test(value);
}

export function isWorkflowSystemUserMessageText(value: string): boolean {
  const stripped = value.replace(AIMA_CMD_BLOCK_RE, '').trim();
  return stripped.length === 0 && /<aima-cmd\b/i.test(value);
}

export function isSyntheticUserMessageText(value: string): boolean {
  return isWorkflowSystemUserMessageText(value)
    || SYNTHETIC_USER_MESSAGE_PREFIX_RE.test(value)
    || (/^\s*【[^】]+】/.test(value) && SYNTHETIC_USER_MESSAGE_META_RE.test(value));
}

export function isUserInteractionMetricText(value: string): boolean {
  return !isScheduledTaskPromptText(value) && !isSyntheticUserMessageText(value);
}

export function hasUserHardRuleText(value: string): boolean {
  return HARD_RULE_TEXT_RE.test(value)
    && !isRuntimeProtocolPromptText(value)
    && isUserInteractionMetricText(value);
}

export function isAssistantProgressUpdateText(value: string): boolean {
  return ASSISTANT_PROGRESS_UPDATE_RE.test(value) && !ASSISTANT_FINAL_DELIVERY_RE.test(value);
}

export function hasAssistantDeliverySignalText(value: string): boolean {
  return ASSISTANT_DELIVERY_SIGNAL_RE.test(value) && !isAssistantProgressUpdateText(value);
}
