# 核对提炼证据与语义复核

收到一份冻结的提炼研究，或需要判断改动能否改善实体提取时，使用本指南。普通候选维护从[提炼与维护知识](extract-knowledge.md)开始。先核对其中的[能力分档](extract-knowledge.md#availability)：这里的已构建 CLI 核对入口属于当前 main，超出已发布 Beta.14 的能力。

## 零模型调用核对收到的研究

向研究作者取得 `evidence.json` 与实际已有的原始复核记录。证据包含选定原文和生成内容，只分享给明确的复核人；增加复核时保留原文件与身份。

```bash
omk observe knowledge study --evidence /absolute/study-report/evidence.json --json
```

该命令验证冻结证据并重算报告，不调用模型，不需要模型凭据或知识工作区，也不恢复或写入提炼运行。不要添加 `--workspace`、`--model` 或生成参数。输入容量见[自动生成的当前契约](../../reference/shared/knowledge-contract.md)；超限会拒绝，不截断原文。

只添加真实已有的复核文件；每项都可省略，缺失证据会继续显示：

```bash
omk observe knowledge study \
  --evidence /absolute/study-report/evidence.json \
  --author-review /absolute/reference-author.json \
  --reference-review /absolute/reference-independent.json \
  --output-review /absolute/output-review.json \
  --judge-review /absolute/agent-judge-review.json
```

| 输入 | 能证明的范围 |
|---|---|
| `--author-review` | 参考作者在输出前对冻结来源与参考义务的复核。 |
| `--reference-review` | 另行安排的独立真人在输出前完成的参考复核；作者或另一个 AI 不能提供独立真人通过。 |
| `--output-review` | 绑定实际已完成输出的逐项判断；真人独立性、时间、覆盖与声明门槛分别检查。 |
| `--judge-review` | 已保存的 AI 评委判断、所声明的模型／prompt／配置身份及单独用量；核对操作不执行评委。 |

在 Studio 的候选核对页，从操作菜单选择**核对研究证据**。选择证据与可选复核文件后，查看来源片段、输出对象、精确引文、判断与缺失目标。未选择知识工作区时也可使用。结果仅留在抽屉中，关闭即清除；选择其他文件会移除旧结论。可携带身份不会变成当前工作区里可编辑的对象。

## 先读结果，再作判断

退出码为零表示核对命令完成，不表示提取通过语义验收。分别阅读工程、参考、输出复核与校准状态。

| 结果 | 含义与下一步 |
|---|---|
| `pending` | 复核或证据不完整。查看缺失／不确定目标，补充实际复核记录。 |
| `blocked` | 声明门槛、证据检查或语义义务未通过。核对理由并保留失败观察。 |
| `exploratory_reviewed` | 探索复核完成，尚无独立真人通过，可据此确定候选修复。 |
| `accepted_within_scope` | 冻结声明范围满足独立复核与适用门槛，不代表总体准确率或普遍发布资格。 |

`goldReady` 只描述参考标注准备度，不能替代独立输出复核。精确定位、合法结构与接纳写入都不证明含义正确或提取完整。除必需漏提外，还须逐项核对输出描述、限定条件和提及理由。区分来源主张与外部证实，核对语境与角色；事实时间缺少来源依据时保留未知。

`critical_only` 参考只报告有限必需对象／提及覆盖与错误，总体匹配 precision、recall、F1 不可用。`unannotated` 只支持工程捕获与探索。经独立完整标注的参考可以支持所声明有限范围内的匹配指标。同一对话的重复窗口不是独立样本，来源分组、seen／unseen 与 development／validation 仍约束结论。

持续展示计划、完成、失败、取消与未尝试槽位。调用尝试和返回的原生结果是不同计数。报告已知用量／费用及覆盖范围，未知保持未知，不推断 provider 内部请求数；复核人投入和模型评委用量与生成成本分开。完成时间未经核实时，完成后复核、匹配指标和校准也会受到限制。

## 在仓库中准备新研究

研究执行与复核准备属于仓内工具，不是额外的已安装 `omk` 生成命令。按[贡献流程](../contributing.md)安装依赖并构建运行时。正式参考交给复核人前冻结最终运行时。历史研究与当前宿主身份不同时，应使用原冻结环境，不改写旧证据来适配今天的构建。

1. 明确选择并授权真实来源窗口及发送目的地。按[普通来源流程](extract-knowledge.md)归档，本地归档不等于授权发送给模型。
2. 输出前声明项目／对话／谱系分组、暴露状态、参考范围与允许的等价表达，保持开发集和验证集独立。正式语义验收需要作者与独立真人在输出前复核参考。没有该真人记录时，可以先开展明确的开发探索，保持参考准备度与正式验收未完成；保留分歧，不用 AI 输出填真人声明。
3. 声明比较变量、模型、政策、重复次数、基于损失的门槛、预算依据、停止与中断规则。replication 是同一条件的重复观察，不会产生新旧版本对比。完整输入格式见[语料与配置契约](../../specs/entities/entity-extraction-study.md)。

从已有快照和独立准备的语料／配置生成新计划：

```bash
yarn build:runtime
node dist-scripts/bench/knowledge-study.js prepare \
  --workspace /absolute/existing-knowledge-workspace \
  --study /private/tmp/new-frozen-study \
  --corpus /private/tmp/study-corpus.json \
  --config /private/tmp/study-configuration.json
node dist-scripts/bench/knowledge-study.js report \
  --workspace /absolute/existing-knowledge-workspace \
  --study /private/tmp/new-frozen-study \
  --output /private/tmp/new-reference-handoff
```

两条命令都不调用模型。producer 核对可能需要已配置凭据，但不会把秘密保存为研究配置。研究与报告输出必须使用明确的新绝对目录，位于检出与所选工作区之外，且父目录已存在；不覆盖已有报告。

交接包的 `report.json` 含 `referenceAuthorTemplate`、`independentReferenceTemplate` 与 `outputReviewTemplate`。追求正式参考验收时，将前两项分别提取成 JSON 复核文件，由真实复核人在输出前填写；空身份／时间／判断故意不能通过校验。软件检查声明与时间顺序，不认证真人或判断是否正确。生成前的输出模板不是完成后输出复核。

只有 `run` 会发送选定内容。授权前核对精确 `planId`、选定槽位与冻结请求，并替换为 `plan.json` 中的真实值：

```bash
node dist-scripts/bench/knowledge-study.js run \
  --workspace /absolute/existing-knowledge-workspace \
  --study /private/tmp/new-frozen-study \
  --slot '<slot-id>' --authorize-plan 'sha256:<plan-id>'
```

只按冻结停止规则执行已授权槽位。重复运行已开始的 run 只恢复，不再次生成；未知中断不授权重发或退还用量。改变 prompt、政策或超时时声明新研究，保留原结果与未执行槽位。新计划不构成替换不利槽位或只挑有利观察的理由；披露事后调整，保留原停止规则和成本证据。

捕获后，再将 `report` 输出到另一个新目录，使用其中新生成、绑定实际输出的模板，复核全部输出实体、提及、知识 statement、参考义务、语义检查与 case。明确处理分歧，不在看到输出后扩宽参考。将完成记录传给 `report --author-review ... --reference-review ... --output-review ...`，或对导出的 `evidence.json` 使用上面的已构建 CLI 只读核对命令。只有工程完成的报告仍是有效证据，语义验收继续保持未完成。

## 比较复核人并保留未决项

需要正式验收时安排独立真人。AI 可以初筛输出、组织复核，但判断必须单独标识。评委校准把同一输出上的已保存 AI 判断与独立真人判断比较；覆盖完整本身不认证评委，也不证明质量改善。

多人复核采用 prospective panel 时，须在判断前声明 roster 与独立裁决人；已有判断后声明必须使用 retrospective。缺失／不确定判断保留在覆盖中，观察到一致不代表正确。[多人复核交接](../../specs/entities/entity-extraction-study.md#_7-独立多人输出复核组)给出仓内面板命令、原始记录清单与裁决流程。裁决保留初始分歧和一致性统计，不改变 `goldReady`，也不替代语义验收。

复核人或独立验证暂不可用时，报告已经完成的工程工作与明确的语义阻塞，不能用合成例子、附近改名对话、另一个模型、绿色 CI 或零退出码填补。复核目标与证据限制见[语义复核协议](../../specs/entities/entity-extraction-semantic-review.md)。
