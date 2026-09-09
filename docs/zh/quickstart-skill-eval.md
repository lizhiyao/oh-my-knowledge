# omk 快速上手：跑出第一份 verdict

先用演示项目跑通“预览 → 评测 → 查看证据”，再换成自己的 skill。运行耗时与费用取决于模型、用例和重试次数。

## 安装与模型准备

需要 Node.js >=22，以及一个已认证的 runtime：Codex CLI、Claude Code 或 API 执行器。配置方法见[执行器](./reference/executors.md)。

```bash
npm i -g oh-my-knowledge@next
omk --version
```

这里安装的是持续迭代的 1.0 Beta；从 0.54 升级请先看[迁移指南](./guides/v1-preview-migration.md)。

在 Codex 任务中，OMK 默认选择 Codex，读取本机配置的模型，并沿用该模型作为评委。普通终端可显式选择：

```bash
export OMK_EXECUTOR=codex
```

模型选择、API 凭证与可选 SDK 的前置要求统一见[执行器文档](./reference/executors.md)。

## 1. 跑通演示项目

```bash
omk init demo
cd demo
omk eval --control code-review-v1 --treatment code-review-v2 --dry-run
```

`init` 创建两版 skill 和三条评测用例。`--dry-run` 预览执行计划和预估调用次数；检查后再执行真实评测：

```bash
omk eval --control code-review-v1 --treatment code-review-v2
```

真实评测会调用模型，并默认先执行 doctor 检查。模型费用与耗时以所选 runtime 为准，预览不是账单保证。完成后按 CLI 返回的实际地址查看 Studio；也可以用 `omk studio` 打开历史结果。

三条用例用于验证流程，出现 `UNDERPOWERED` 符合预期。若要使用完整起步集，在新目录运行 `omk init demo-full --samples 20`。该集合覆盖四个维度、不同难度与无缺陷对照，会产生 40 次 control／treatment 执行，另有评分与检查调用。

**起步用例标记为 `provenance: llm-generated`。** 20 条仅达到默认启发式证据下限，不代表完成先验功效规划，也不等于正式发布证据。使用前应人工复核并替换为真实领域用例。

## 2. 换成自己的 skill

在自己的项目中准备两版文件：

```text
skills/
├── my-skill-v1.md
└── my-skill-v2.md
```

需要附带参考资料时，可使用 `skills/my-skill-v2/SKILL.md` 目录布局，详见[知识载体布局](./reference/artifact-layout.md)。variant 名取文件名或目录名，例如 `my-skill-v2`。

```bash
omk sample skills/my-skill-v2.md
```

生成后先人工检查用例的准则、权重、反例与边界覆盖。比较两版时使用同一份固定用例；从演示项目继续操作时，应替换演示用例，不要把它们当成自己的领域用例。

```bash
omk eval --control my-skill-v1 --treatment my-skill-v2 --dry-run
omk eval --control my-skill-v1 --treatment my-skill-v2
```

只有一版 skill 时，用 `baseline` 作为 control，比较“无 skill”和“有 skill”。用例的格式和自动发现规则见[评测用例格式](./reference/eval-sample-format.md)。

## 3. 查看结果并决定下一步

先看 **verdict**（跨版本判定）及其 reason code，再看差异 Δ、报告给出的置信区间、证据覆盖与失败用例。默认单一比较使用 95% 置信区间，比较家族会调整置信水平；发布判定还受证据与策略门禁约束。

| Verdict | 下一步 |
|---|---|
| `PROGRESS` | 证据支持改进。复核用例代表性与告警后进入自己的发布流程；已纳管的 skill 可用 `omk promote <name>` 记录接受决定。 |
| `CAUTIOUS` | 阅读报告的具体原因和告警，处理后重新评测，暂不自动接受。 |
| `REGRESSION` | 从失败用例与变差的指标定位问题，修改后重新评测。 |
| `NOISE` | 当前证据无法区分差异。检查用例区分度与样本设计，再决定是否补充测量。 |
| `UNDERPOWERED` | 补齐预先声明的样本量要求。20 个可比较单元只是默认启发式下限；正式测量应根据外部先导假设配置 `decision.power`，或登记 `decision.minimumComparisonUnits`。 |
| `SOLO` | 添加对照组后再做跨版本判断。 |

结论只适用于本次用例、准则和运行条件。AI 生成用例可能偏向已有的成功路径，应补充真实失败、反例与误用场景。保留报告、用例来源和人工复核结论；在迭代中使用过的用例不能直接充当独立发布验证集。方法见[统计严谨性](./explanation/statistical-rigor.md)和[用例设计](./specs/sample-design-spec.md)。

## 在 Agent 中使用

```bash
omk install omk-agent-skill
```

默认安装到检测到的受支持目标：`~/.codex` 或 `~/.agents` 对应 Codex/AGENTS，`~/.claude` 对应 Claude Code。`--to all` 强制安装到当前已知的全部目标，`--dest` 指定自定义 skill 根目录。

在 Agent 中显式使用 OMK Skill，并描述目标，例如：“用 omk 比较 skills/my-skill-v1 与 skills/my-skill-v2，先预览计划。”Claude Code 可使用已安装的 `/omk` 入口；其他宿主可让 Agent 执行 `omk` CLI。生成用例后仍需复核，再执行真实评测。

## 首跑遇到问题

- **模型或认证失败：** 检查 runtime 登录状态、模型名与 API 地址，见[执行器](./reference/executors.md)。
- **doctor 拦截：** 按诊断修复知识载体后重跑；需要理解跳过检查的影响时查 [CLI 参考](./reference/cli.md)。
- **只想检查断言与报告：** `--no-judge` 跳过 LLM 评委，但目标执行仍可能调用模型，不能视为离线或免费运行。
- **预览失败：** 先修复用例、路径或 URL 解析问题，不要通过直接执行绕过失败。

## 继续使用

[自动改进 skill](./guides/auto-improve-skills.md) · [观测真实任务](./guides/observe-production.md) · [Node.js 服务接入](./guides/eval-runtime.md) · [完整文档索引](./README.md)
