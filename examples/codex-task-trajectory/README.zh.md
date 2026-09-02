# 真实 Codex 任务轨迹

这个示例把一条脱敏后的真实 Codex Desktop 任务还原为 OMK 任务轨迹。用户询问 Codex Memory 是否默认开启，随后 Codex：

1. 读取 `openai-docs` Skill；
2. 尝试获取 Codex 手册；
3. 首次命令失败后重试；
4. 检索已获取的手册；
5. 回答用户。

事件顺序、时间戳、用户问题、AI 消息、工具输入、执行状态和工具输出都来自当时的真实任务。样本移除了无关轮次和系统上下文，替换了用户路径、临时路径、会话标识及事件标识，并在脱敏后截断过长的工具输出。

最终回答记录的是采集时的产品行为，只用于演示 trace 证据，不应当作当前 Codex 文档。

## 在 Studio 中体验

在仓库根目录运行：

```bash
yarn build
node dist/cli/index.js observe ingest \
  examples/codex-task-trajectory/trace \
  --output-dir .omk/task-trajectory-demo
node dist/cli/index.js studio \
  --observations-dir .omk/task-trajectory-demo
```

从观测收件箱打开任务轨迹。语义轨迹按操作顺序等间距排列，Knowledge、执行与结果在同一操作列对齐；完整过程可横向滚动，超过一分钟且没有可观测事件的时段会压缩标注。点击操作可查看关联证据，切换到「规范化事件」可核对 Trace IR，再用「源记录」查看随报告归档的 JSONL 输入。

## 证据边界

这份 fixture 只能证明一条脱敏任务可以在保留可观测证据的前提下完成摄取和展示回读。它不能证明已经覆盖全部 Codex 事件变体，不能推断隐藏思维，也不能证明采集时的产品回答至今仍然有效。
