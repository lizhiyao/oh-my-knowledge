import {
  isRuntimeProtocolPromptText,
  isUserInteractionMetricText,
} from '../trace/message-classification.js';

export const HARD_RULE_TEXT_RE = /hard rules?|必须|不要|禁止|严格|一定要|务必|不得|不能|只允许/i;
export const USER_INTERRUPTION_RE = /\[Request interrupted by user(?: for tool use)?\]|interrupted by user|用户中断|停止任务|停一下|先别|别动|等一下|等下|等等|取消(?:任务|执行)?|先暂停|暂停一下/i;

const ASSISTANT_DELIVERY_SIGNAL_RE =
  /```(?:mermaid|plantuml|json|tsx?|jsx?|html|css|excalidraw|markdown)?|直接生成|已生成|生成如下|结果如下|如下|完成|已完成|这里是|给出|输出/i;

const ASSISTANT_PROGRESS_UPDATE_RE =
  /已发送进展|进展消息|进度更新|状态更新|正在|仍在|继续|处理中|整理中|分析中|生成中|执行中|采集中|获取中|即将|预计|稍后|子\s*Claude|后台任务/i;

const ASSISTANT_FINAL_DELIVERY_RE =
  /最终结果|最终报告|完整结果|完整报告|结果如下|报告如下|已完成[，,。:：]\s*(?:结果|报告|如下)|(?:任务|方案|文档|报告|demo|代码|页面)?已完成\s*(?:✅|[，,。:：]\s*(?:方案路径|产物路径|文档路径|结果|报告|如下))|(?:方案路径|产物路径|文档路径|结果文件|输出路径)\s*[:：]/i;

export const ASSISTANT_DELIVERABLE_ARTIFACT_RE =
  /```(?:mermaid|plantuml|json|tsx?|jsx?|html|css|excalidraw|markdown)?|https?:\/\/\S+|(?:文档|报告|方案|demo|Demo|预览|产物|文件|页面|dashboard|看板)(?:链接|地址|路径|URL)|(?:已生成|已创建|已写入|已保存|上传).{0,16}(?:文件|文档|报告|页面|demo|Demo|dashboard|看板|产物)|(?:^|[\s"'`(])(?:\/[\w.-]+){2,}\.(?:md|html|tsx?|jsx?|json|png|jpe?g|pdf|docx?|pptx?|xlsx?|csv)\b|(?:^|[\s"'`(])[\w.-]+\.(?:md|html|tsx?|jsx?|json|png|jpe?g|pdf|docx?|pptx?|xlsx?|csv)\b/i;

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
