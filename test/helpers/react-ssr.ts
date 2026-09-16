/**
 * Studio React 渲染测试的共享比对基线：SSR 输出的 React 行为只在此说明一次。
 */

/**
 * React 文本节点的转义结果，用作「载荷必须仍在输出里」的正向断言基线：
 * 只断言注入串没有变成标记是不够的，值被整体丢弃同样算失败。
 */
export function reactText(payload: string): string {
  return payload
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;');
}

/** React 会在相邻动态文本之间插 `<!-- -->` 定界，剥掉注释后才能按可见顺序断言。 */
export function visibleText(html: string): string {
  return html.replaceAll('<!-- -->', '');
}

/**
 * SSR 输出里当前高亮的 antd Tabs 面板键。
 *
 * 判据来自两处 antd 行为：页签容器把面板键留在 `data-node-key` 上，而内容侧只渲染当前面板。
 * 返回键而不是断言整段类名，是为了让失败信息直接说出实际渲染了哪个面板；出现 0 个或多个高亮
 * 面板同样算失败，因为那意味着「地址决定面板」这条根本没有落地。
 */
export function activeTabKey(html: string): string {
  const matches = [...html.matchAll(/<div data-node-key="([^"]+)" class="ant-tabs-tab ant-tabs-tab-active">/g)];
  if (matches.length !== 1) throw new Error(`期望恰好一个高亮面板，实际 ${String(matches.length)} 个`);
  return matches[0][1];
}
