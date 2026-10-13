# 复现历史提炼质量记录


本节两项采集命令属于历史 v3 工具，只能在对应报告冻结的源码与构建中复现。当前运行会在配置模型前拒绝这些历史命令；仅替换 `--prompt` 不能绕过格式边界。保留原依赖、语料、指南与测量身份，不用当前运行产物重算旧结果。当前协议见[实体提取评测规范](../entity-extraction-evaluation.md)，历史记录见[实体证据索引](../index.md)。

实体覆盖使用 16 场景语料 `test/fixtures/entity-extraction-quality.json`（`omk-entity-quality/v2`）：原有 12 类场景外，增加工具与日志粒度、跨项目路径及明确改名、跨轮纠正与环境区分、方案与执行分开。关键位置、必须分开的身份、歧义和角色标准在输出前冻结；模型只接收来源消息及覆盖限制，不接收这些答案。这仍是合成场景，不代表真实日志分布。

```bash
yarn build:runtime
node dist-scripts/bench/entity-extraction-quality.js --model <fixed-model> --repeat 2 --output /absolute/outside/repository/new-entity-run
```

默认每个场景调用一次；`--repeat 2` 是两次独立采样，最多 32 次调用，无自动重试。每次输出保存在独立子目录，`critical-checks.json` 按 `omk-entity-critical-checks/v1` 分开记录精确／包含位置、身份组、分离、歧义及已观察到的知识角色；遗漏可选知识与角色错误分开，额外对象仍需语义复核。重复调用不是重放保证，也不证明总体稳定性。可用 `--prompt /absolute/previous-run/prompt.json` 选择历史 v3 格式的冻结提示词；保留精确提示词字节、语料及输入摘要，另行复核输出。输出必须是仓库外的新目录。退出成功表示采集与结构接纳完成，不代表语义通过。调用前核对并授权发送消息；未报告费用仍为未知。已完成的[v2／v3 报告](entity-extraction-quality.md)提供原始证据及自审限制；v2 是历史证据，当前工具不再支持重放。

历史 16 场景的实际结果见[两轮实体验收报告](entity-extraction-repeat-quality.md)：集合指代、引用定位、环境身份范围与案例组织仍有失败。原始输出、拒绝和自行复核分别保留，没有用重试覆盖失败。

贡献者可运行 `test/fixtures/knowledge-extraction-quality.json` 中的 6 个固定场景：无可复用内容、未验证的成功自述、后续纠正、条件性规则、评测证据不足，以及存在缺口的单次结果。场景来自合成消息和仓库规则摘录，复核标准在生成前确定；它们尚不是经过独立复核的金标准，也不代表真实对话总体。

```bash
yarn build:runtime
node dist-scripts/bench/knowledge-extraction-quality.js --model <fixed-model> --output /absolute/outside/repository/new-run
```

该开发工具使用既有 Codex 执行器，每个场景调用一次，无自动重试。运行前核对选定消息并授权发送，费用在执行器未报告时仍为未知。输入包含仅覆盖消息的限制，不发送复核标准。输出只写入仓库外的新目录，保存提示词、场景、摘要、原始输出、拒绝原因及运行信息；中断后不再发起后续调用。退出成功表示采集与结构校验成功，语义复核仍为待完成。

逐项对照场景标准和原文复核输出，记录遗漏、误解及多余候选，并区分自主复核与独立人工复核。比较提示词时保留首轮 `prompt.json`，可用 `--prompt /absolute/first-run/prompt.json` 复现历史 v3 格式的提示词，固定模型和场景，并核对输入摘要一致。每个场景单次运行可暴露失败，不能证明稳定提取质量、总体改进或载体有效性；没有实际失败依据时保留现有提示词。
