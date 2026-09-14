/**
 * Studio React 渲染测试的共享比对基线：SSR 输出的两条 React 行为只在此说明一次。
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
