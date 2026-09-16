import { TAB_PARAM } from '../../http/page-params';

/**
 * 把当前面板镜像进地址：浅写 `history.replaceState`，不走路由。
 *
 * 为什么浅写而不是 `router.replace`：后者会让 Next 重新请求整页 RSC，而任务轨迹页一次渲染的 HTML
 * 实测约 870 KB，等于每点一次面板就重下一遍数据——数据本身与面板无关。地址是本地状态的镜像，不是
 * 响应式来源，所以这里既不读 `useSearchParams`（它会把子树降级成纯客户端渲染，口径见
 * `src/studio/README.md` 关于语言切换那一段），也不反过来回写组件状态。
 *
 * 默认面板不占参数：地址保持最短，也避免「参数缺席」和「参数写着默认值」留下两种分享出去看起来
 * 不一样、渲染却等价的地址。
 */
export function mirrorTabToUrl(tab: string, defaultTab: string): void {
  const url = new URL(window.location.href);
  if (tab === defaultTab) url.searchParams.delete(TAB_PARAM);
  else url.searchParams.set(TAB_PARAM, tab);
  window.history.replaceState(null, '', url);
}
