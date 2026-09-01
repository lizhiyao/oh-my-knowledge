# 自动迭代 skill

`omk evolve` 帮你跑 omk 的内层循环：**eval → 诊断 → 改写 → 再 eval**，一轮接一轮，只保留被证明有用的改动。它是"跑一次 eval、读失败、改 skill、再跑"的自动化版本。

每个 flag 见 [CLI 参考](../reference/cli)。这篇讲工作流，以及你信任它的产出之前应该懂的几个安全机制。

## 基本循环

```bash
omk evolve skills/my-skill.md
omk evolve skills/my-skill.md --rounds 10 --target 4.5
```

每一轮：评测当前 skill、让诊断 LLM 说哪儿在挂、改写 skill、评测候选、**只在确实更好时才接受**。命中 `--target`（综合分）或跑满 `--rounds`（默认 5）时停。原始版本存在 `skills/evolve/*.r0.md`。耗时按 `轮数 × 用例 × 变体` 累加——通常几分钟到几十分钟。

所有保留轮次必须维持相同的用例指纹、模型、执行器、评委配置、运行时指纹、执行策略和 skill 隔离状态；任一项漂移，Evaluation Core 都会拒绝把比较认定为「只改变知识载体」的改进。测量产物始终是不可变的 Core run，端到端 evolve 成本由 authoring loop 另行汇总。

## 它为什么不会把分数"刷"成胡来

三个默认机制挡住自动迭代的经典翻车模式：

- **Evaluation Core 决策门禁**：每个候选都作为新的 control／treatment A/B run 测量；只有 Core 返回带 `release-gates-passed` 的 `PROGRESS`，且候选分数高于当前分数时才接受。Runtime、证据、可比性、不确定性或发布策略不满足都会失败关闭，authoring loop 不能用私有分数启发式替代这项决策。
- **编辑预算**（`--edit-budget`，默认 0.2）：一轮最多改 skill 的 20% 行。超预算的改写在**评测之前**就被拒，所以失控改写不能悄悄换掉整个 skill（你也不用花钱去测它）。`--no-edit-budget` 去掉上限。
- **拒绝记忆**（默认开）：被拒的改写会喂回下一轮 prompt，改写器就不会反复提同一个输的编辑。`--no-reject-memory` 关掉。
- **最终写回门禁**：修改源文件前，evolve 会重新评测未改动的原始版本与胜出快照；最终 Core 决策失败时源文件保持不变。使用 `--snapshot-only` 可只把候选保留在 `evolve/`，不写回源文件。

## 防 train-on-test

如果你在**同一批**用例上迭代并接受、又在它们上测量，就会过拟合到它们——分数往上爬，真实质量没动。`omk evolve` 不会把选择集上的结果包装成无偏泛化估计。应在 authoring loop 外保留一套预注册、独立的验证集，并在 evolve 后重新执行发布评测：

```bash
omk evolve skills/my-skill.md --rounds 8
omk eval --control original-skill --treatment skills/my-skill.md --samples release-validation.json
```

不要把 `release-validation.json` 的失败反馈回同一次 evolve，否则它会变成新的选择集。需要人工审批时，可用 `--snapshot-only` 生成候选，审阅后再独立评测与 promote。

## 什么时候用它

- 你有一套真实用例，想要一个值得 review 的强初稿改进——evolve 提议，你决定留不留这个 diff。
- 你想**证明**一次迭代有用，而不是肉眼看。

它**不能**替代好用例：evolve 只能针对你测量的东西改进。garbage 用例进，过拟合 skill 出。从一套你信得过的用例集开始（见 [用例设计](../specs/sample-design-spec)）。

## 相关

- [三阶段](../explanation/three-stage-workflow) —— evolve 把 doctor → eval → 改写 内层循环自动化
- [统计严谨性](../explanation/statistical-rigor) —— Core 发布决策中的不确定性与可比性
- [CLI 参考：`omk evolve`](../reference/cli) —— 每个 flag
