# code-review 示例

omk 最基础的用法：同一组用例下，A/B 对比两个版本的 skill，看「改了到底有没有变好」。

- `skills/code-review-v1/`：最简审查 prompt（对照基线）
- `skills/code-review-v2/`：结构化四维审查 prompt（处理组）
- `eval-samples.json`：5 条代码审查用例（注入 / 健壮性 / XSS / 越权 / 日志泄露），混合 `contains` + `regex` 断言与 `rubric` 评委评分

## 跑

```bash
cd examples/code-review
omk eval --control code-review-v1 --treatment code-review-v2
```

会跑出 HTML 报告 + 一行 verdict（PROGRESS / NEUTRAL / …），告诉你 v2 相对 v1 是否有统计上可信的提升。

只想预览任务、不调用模型：加 `--dry-run`。不想用 Claude / 没有 API key：见 [`../custom-executor`](../custom-executor)。

## 看点

这就是 `omk init` 脚手架出来的同款结构——目录式 `SKILL.md`（含 frontmatter）是 omk 与 Claude Skills 通用的 canonical 形态。把 `code-review-v2` 换成你自己的 skill，就是你的第一个真实评测。
