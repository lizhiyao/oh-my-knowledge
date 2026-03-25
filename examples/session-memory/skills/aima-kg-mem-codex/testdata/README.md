`testdata/` 现在是面向评估的对话测试集，不只是 hook 样例。

主要文件：

- `conversation-cases.json`
  统一维护多组 Claude Code 场景测试数据
- `sample-transcript.jsonl`
  单个 Stop hook 冒烟测试 transcript
- `stop-hook-input.json`
  单个 Stop hook 冒烟测试输入

`conversation-cases.json` 中每个 case 都包含：

- `id`: 用例 ID
- `category_under_test`: 目标分类
- `should_store`: 预期是否应存储
- `conversation`: 模拟用户与 Claude Code 的对话过程
- `expected_extraction`: 预期提炼结果

覆盖的类型：

- `error_resolution`
- `user_preference`
- `workflow_pattern`
- `debugging_method`
- `project_convention`
- `reusable_reference`
- `skip_low_signal`

如果要做自动评估，建议把每个 `conversation` 渲染成 transcript，再将模型输出与 `expected_extraction` 做字段级比对。
