# Studio 领域规则

本文件补充仓库根 `AGENTS.md`，适用于 `src/studio/`。Studio 只消费稳定的领域投影，不应重新解释评测或观测语义。

## 渲染与查询边界

- Studio 应用页面统一向 Next.js 收敛；手写 HTML 渲染层已删除，新页面不再增加它。API、SSE 按各自职责维护，不为迁移页面而复制领域查询。
- view-models 仅存放类型契约；泳道布局、证据引用与活动快照的运行时计算放在 application 中，HTTP 与 React 消费同一实现；application 不得依赖 http 或 web，view-models 不得反向依赖这些层或 application。
- 客户端组件（`'use client'`）按值 import 的模块会进浏览器 chunk，因此其运行时依赖闭包不得触达 Node 宿主能力；只是取类型就用 `import type`，该边会被 TS 擦除、不算闭包成员。口径由 `test/architecture/studio-client-runtime-closure.test.ts` 钉住；`next build` 里的报错只是同一件事的下游后果，不能当防线用。
- Knowledge 页面与 API 共用 application 查询入口。缓存由服务实例持有，目录按请求解析，返回值不得暴露缓存内部的可变引用。
- 清理旧渲染器前检查实际调用者；仍服务于调试入口的实现不算死代码。具体迁移路由与剩余工作记录在 PR，不在本规则中维护易过期的路由清单。

## 领域约束

- 品牌名称统一为“OMK Studio”，品牌入口在 hover、focus、active 状态保持文字颜色稳定，键盘焦点使用轮廓提示。
- Studio 定位为全屏应用：所有页面默认占满视口，页面根节点及页面外壳禁止横向、纵向滚动。导航、页面操作与关键摘要固定，不能靠整页滚动容纳内容。
- 先通过紧凑布局、分页、标签页与按需详情分配空间；只有确有长内容的表格、时间轴、证据面板和抽屉允许显式的内部滚动，并约束高度、最小尺寸与滚动传播。不能仅用 overflow:hidden 裁掉内容或操作；所有内容仍须可达。
- 所有表格的表头和单元格文字禁止自动换行，不靠拆字或换行适配列宽。为状态、数量和操作列保留足够宽度；长文本使用单行省略并提供完整内容提示／详情，或通过表格内部横向滚动查看，不得裁掉无法访问的内容。
- 改造或新增页面时，验收 Observe、Measure、Knowledge 及报告／异常页面的布局边界；至少检查正常桌面和较矮窗口，页面无双向溢出，四条泳道完整可见，表格操作列不换行，普通双行列表优先采用约 56px 行高。独立于 Studio 挂载的报告不强制使用应用外壳。

- 人工预览的端口选择遵循根规则；用户可见 URL 使用 `server.start()` 返回的实际地址，不以默认端口拼接 URL。
- 展示层消费 view-model，不直接读取或重算底层存储与评分语义。
- 修改页面 UI 后用渲染输出断言验证：用户实际读到的文字、链接与转义写在 `test/studio/web/*.test.tsx`，展示无关的事实口径写在 `test/studio/application/*-format.test.ts`。Studio 不使用 snapshot 测试。

## Code Review Rules

- 必须拦截 http／web 层反向定义领域语义或绕过 view-model 读取底层数据。安全路径：在对应领域构造稳定投影，Studio 只负责呈现和传输。
- 必须拦截未转义的外部文本进入 HTML，以及敏感路径、凭证或原始异常泄漏给浏览器。安全路径：统一 escaping 与错误投影，并覆盖恶意输入测试。
- 必须拦截没有人工审阅可见差异的 snapshot 批量更新。安全路径：先核对预期 UI 变化与用户影响，再更新最小 snapshot 并做必要的真实页面验收。
