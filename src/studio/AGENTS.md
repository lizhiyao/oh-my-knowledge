# Studio 领域规则

本文件补充仓库根 `AGENTS.md`，适用于 `src/studio/`。Studio 只消费稳定的领域投影，不应重新解释评测或观测语义。

## 领域约束

- 用户可见 URL 使用 `server.start()` 返回的实际地址，不假设固定端口。
- 展示层消费 view-model，不直接读取或重算底层存储与评分语义。
- 修改报告 UI 后，先审查 `test/__snapshots__/html-renderer.test.ts.snap` 的实际变化，再决定是否更新 snapshot。

## Code Review Rules

- 必须拦截 presentation／http 层反向定义领域语义或绕过 view-model 读取底层数据。安全路径：在对应领域构造稳定投影，Studio 只负责呈现和传输。
- 必须拦截未转义的外部文本进入 HTML，以及敏感路径、凭证或原始异常泄漏给浏览器。安全路径：统一 escaping 与错误投影，并覆盖恶意输入测试。
- 必须拦截没有人工审阅可见差异的 snapshot 批量更新。安全路径：先核对预期 UI 变化与用户影响，再更新最小 snapshot 并做必要的真实页面验收。
