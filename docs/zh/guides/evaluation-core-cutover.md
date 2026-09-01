# Evaluation Core 生产切换

> **BREAKING-SCHEMA：**`omk eval` 现在只读写 Evaluation Core 产物。

本次切换不提供旧 reader、双写、shadow run、schema migration 或自动转换。切换前生成的 evaluation report 不能再由 Studio 打开，不能 resume，不能做 Gold 对比，也不能供 `omk evolve` 使用。如需查看旧文件，请保留对应的旧版 OMK。

新评测以 Core `runId` 定位目录。每个目录发布 manifest，以及完整的 sealed Run Plan、Execution Bundle、Evaluation Bundle、Analysis Bundle 和 Evaluation Report。任一文档缺失、digest 不匹配、lineage 断裂或内容引用无法解析，都会 fail closed。

操作变化：

- `omk eval --resume` 只接受 Core `runId`，不接受报告路径；
- `omk eval gold compare` 接受 Core `runId`，并要求显式提供 `--target`、`--evaluator` 和 `--metric`；
- Studio 只列出 Core evaluation run；doctor 与 observe 文档继续保持独立；
- managed evidence 与 evolve 接受决定只接纳通过验证的 Core projection；
- 诊断后处理只投影经过验证的 Core 失败、缺失证据、排除项和稳定 reason code，不读取旧结果行，也不虚构建议；
- 独立 `--repeat` run 只把 run-level variance 发布为 Series analysis；没有预注册的 Series 总体决定时，release gate 会失败关闭，单次 member 也不会写入受管证据；
- `--dry-run` 只完成 Runtime assembly 与 sealed plan prepare，不打开 Target 或 Evaluator。

这是存储和应用 schema 的切换，不改变测量 construct。冻结的评分类 prompt、五层评分、Bootstrap CI、Krippendorff alpha 与 length-debias 语义保持不变。
