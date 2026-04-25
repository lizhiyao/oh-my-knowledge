# gold-dataset 示例

omk 的人工锚点 (human gold) 工作流示范。10 条样本 × 5 个领域，演示如何用 Krippendorff α / 加权 κ / Pearson r 度量 LLM 评委与外部标注的一致性。

## 为什么需要它

omk v0.21 的 Bootstrap CI 解决了 _评委稳不稳_——同一份输入重新采样跑出来的分数差多少。但它不能告诉你 _评委对不对_。一个 judge 可以非常稳定地给出错误结论：CI 极窄、α 极低，这是最危险的"自信偏差"。

人工锚点引入外部标注作为参考点，把"自洽"升级到"和外部一致"。两个数（CI 宽度 + α 值）必须同时可接受，结论才值得信。

## 目录结构

```
examples/gold-dataset/
├── README.md
├── eval-samples.yaml        # omk 评测的样本集 (10 条)
└── gold/
    ├── metadata.yaml        # 标注者 / 时间 / 量程
    └── annotations.yaml     # 每条 sample 对应的 gold 评分 + 理由
```

## 运行示例

第一步：用任意 skill 跑一次评测（这里以 baseline vs 一个 skill 为例）。

```bash
omk bench run \
  --samples examples/gold-dataset/eval-samples.yaml \
  --control baseline \
  --treatment your-skill \
  --gold-dir examples/gold-dataset/gold
```

`--gold-dir` 让 omk 跑完后自动计算 α/κ/Pearson 并把结果写到 report.meta.humanAgreement，HTML 报告中会显示「人工锚点」一栏。

第二步：单独对比已有 report。

```bash
omk bench gold compare <reportId> --gold-dir examples/gold-dataset/gold
```

第三步：校验 gold 数据集结构是否合法。

```bash
omk bench gold validate examples/gold-dataset/gold
```

## 重要约束

1. **annotator 不应与 judge 同名。** 本数据集的 annotator 是 `claude-opus-4-7-1m`。omk 默认 judge 是 `claude-sonnet-4-6`，所以两者错开。如果你显式让 omk 用 Opus 当 judge 跑此数据集，CLI 会触发污染警告——这是正确的，因为同一模型给自己打分会人为推高 α。

2. **10 条不构成基准。** 这只是演示规模。真实评估场景下，gold 应有 50-200 条样本，覆盖你 rubric 在意的所有难度区间。bootstrap CI 在 N=10 时宽度可达 0.3-0.4，足以演示，但不足以下结论。

3. **stronger-model proxy ≠ 真人标注。** Opus 4.7 标的 gold 能挡住 judge 的随机噪声和明显校准偏差，但挡不住"两个模型共同的盲区"——例如训练语料相近的偏见。任何对外发表的评测都应至少跨厂商交叉，最理想是真人多轮标注。

## α 解读阈值

omk 的 HTML 报告会按下面的阈值给 α 上色：

| α 值 | 解读 | 行动 |
|------|------|------|
| ≥ 0.80 | 高度一致 | 结论可放心使用 |
| [0.67, 0.80) | 可接受 | 结论需谨慎，CI 必须辅证 |
| [0.40, 0.67) | 较弱一致 | 结论需配合人工抽检 |
| [0, 0.40) | 偏差较大 | 排查 rubric / judge prompt |
| < 0 | 系统性反向 | 重新审视判分逻辑 |

阈值参考 Krippendorff (2011)。0.80 是社会科学界的经验门槛；技术评委场景下 0.67 已可接受。

## 自己扩展 gold

把这份当作起点，按你自己的领域扩样：

```bash
# 1. 用 omk 生成 starter 模板
omk bench gold init --out my-gold --annotator your-team-or-model-id

# 2. 编辑 annotations.yaml,填入对应你 sample_id 的标注
# 3. 校验
omk bench gold validate my-gold

# 4. 跑评测时挂上
omk bench run --gold-dir my-gold ...
```
