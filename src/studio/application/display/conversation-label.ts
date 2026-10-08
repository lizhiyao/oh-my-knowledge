/**
 * 会话与轮次标题的展示层归一，唯一 owner。
 *
 * 标题原文来自被观测的宿主，常带行内 Markdown——`[链接](url)`、`**加粗**`、GitHub 的实体空格。
 * 摘要类展示面（侧栏行、阅读区标题、轨迹页 H1、泳道卡片）必须把同一串字符读成同一句，否则同一
 * 标题在一页上出现两种写法。证据面不套这份口径：详情抽屉、轨迹页的完整请求 Popover、原始记录
 * 仍给原串——派生视图不覆盖原始证据。
 *
 * 这份实现原先是 `web/components/observe/workspace.tsx` 里的私有函数，只服务侧栏一处（搜索匹配
 * 也按它的结果算命中），别的展示面拿不到，只能各自决定要不要归一，于是轨迹页整页保留原文。
 * 上收到 application/display 与 `format.ts` 同层：那层已经是时间、百分比等展示格式的唯一 owner。
 */
export function conversationLabel(value: string, fallback = '系统记录'): string {
  let visible = value.trim();
  // 只处理宿主放在开头的已知包装；正文中的代码、引用及原始证据不套此口径。
  if (/^(?:# Files mentioned by the user:|<in-app-browser-context\b)/i.test(visible)) {
    const request = /^## My request(?: for Codex)?:\s*$/im.exec(visible);
    if (request) visible = visible.slice(request.index + request[0].length).trim();
    else visible = visible.replace(/^<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>\s*/i, '').trim();
    if (/^(?:# Files mentioned by the user:|<in-app-browser-context\b)/i.test(visible)) return fallback;
  }
  if (/^<(?:codex_internal_context|external_codex_apps_open_page)\b/i.test(visible)) return fallback;
  return visible.replace(/&#(?:x20|32);/gi, ' ').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(issues|pull)\/(\d+)/g, (_, type, number) => `${type === 'pull' ? 'PR' : 'Issue'} #${number}`)
    .replace(/\*\*/g, '').trim();
}
