# 自动迭代 skill

`omk evolve` 帮你跑 omk 的内层循环：**eval → 诊断 → 改写 → 再 eval**，一轮接一轮，只保留被证明有用的改动。它是"跑一次 eval、读失败、改 skill、再跑"的自动化版本。

每个 flag 见 [CLI 参考](../reference/cli)。这篇讲工作流，以及你信任它的产出之前应该懂的几个安全机制。

## 基本循环

```bash
omk evolve skills/my-skill.md
omk evolve skills/my-skill.md --rounds 10 --target 4.5
```

每一轮：评测当前 skill、让诊断 LLM 说哪儿在挂、改写 skill、评测候选、**只在确实更好时才接受**。命中 `--target`（综合分）或跑满 `--rounds`（默认 5）时停。原始版本存在 `skills/evolve/*.r0.md`。耗时按 `轮数 × 用例 × 变体` 累加——通常几分钟到几十分钟。

## 它为什么不会把分数"刷"成胡来

三个默认机制挡住自动迭代的经典翻车模式：

- **显著性接受门禁**（默认开）：候选只在 diff 的 bootstrap CI 显示**统计显著**的增益时才被接受，而不是点估计高一点就要。靠噪声"看起来更好"的一轮会被拒。`--no-significance-gate` 关掉（退回点估计接受）；`--significance-alpha` 调水平（默认 0.05 = 95% CI）。
- **编辑预算**（`--edit-budget`，默认 0.2）：一轮最多改 skill 的 20% 行。超预算的改写在**评测之前**就被拒，所以失控改写不能悄悄换掉整个 skill（你也不用花钱去测它）。`--no-edit-budget` 去掉上限。
- **拒绝记忆**（默认开）：被拒的改写会喂回下一轮 prompt，改写器就不会反复提同一个输的编辑。`--no-reject-memory` 关掉。

## 防 train-on-test

如果你在**同一批**用例上迭代并接受、又在它们上测量，就会过拟合到它们——分数往上爬，真实质量没动。两个 flag 锁死这点：

- **`--holdout-ratio <0..1>`**（默认 0 = 关）：留出一部分用例；接受决策在 **holdout** 分上做，给改写器看的弱用例只来自 train 切分。这是主要的抗过拟杠杆。
- **`--test-ratio <0..1>`**（默认 0 = 关，需配 `--holdout-ratio`）：切出一个**锁定 test 集**，**绝不**用于选择——只在最后被读取一次，给一个无偏的泛化分。当你需要汇报"evolve 到底泛化得怎么样"时用它。

```bash
omk evolve skills/my-skill.md --rounds 8 --holdout-ratio 0.3 --test-ratio 0.2
```

## 什么时候用它

- 你有一套真实用例，想要一个值得 review 的强初稿改进——evolve 提议，你决定留不留这个 diff。
- 你想**证明**一次迭代有用，而不是肉眼看。

它**不能**替代好用例：evolve 只能针对你测量的东西改进。garbage 用例进，过拟合 skill 出。从一套你信得过的用例集开始（见 [用例设计](../specs/sample-design-spec)）。

## 相关

- [三阶段](../explanation/three-stage-workflow) —— evolve 把 doctor → eval → 改写 内层循环自动化
- [统计严谨性](../explanation/statistical-rigor) —— 显著性门禁背后的 bootstrap CI
- [CLI 参考：`omk evolve`](../reference/cli) —— 每个 flag
