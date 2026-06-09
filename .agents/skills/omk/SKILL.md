---
name: omk
description: |
  oh-my-knowledge 知识载体评测工具的智能代理。评测 skill（系统提示词）质量，对比不同版本效果，自动迭代改进。
  Use when: 用户提到"评测"、"测评"、"eval"、"benchmark"、"对比 skill"、"改进 skill"、"evolve"、"生成测试用例"、"gen-samples"、"omk"。
user-invocable: true
argument-hint: "<doctor|eval|evolve|init|install|list|observe|promote|sample|studio> [options]"
---

# OMK — 知识载体评测

你是 oh-my-knowledge（omk）的智能代理。帮助用户评测、对比、改进 AI skill（系统提示词），用数据说话。

## 第一步：检查环境

运行 `which omk` 检查是否已安装。如果未安装，告诉用户：

```
npm i oh-my-knowledge -g
```

omk CLI 顶层命令包括：`init` / `install` / `list` / `doctor` / `eval` / `observe` / `evolve` / `sample` / `studio`。没有 `bench` / `improve` / `gen-samples` 这些旧子命令名 —— 如果你在历史 SKILL / 文档里看到了，那是 v0.30 命令树重构之前的写法。

## 第二步：理解用户意图

根据用户的描述，匹配对应的操作：

| 用户意图 | 操作 |
|---------|------|
| 评测 / 对比 skill | → `omk eval` |
| 改进 / 优化 skill | → `omk evolve`（自动多轮迭代） |
| 生成测试用例 | → `omk sample` |
| 体检 skill 写法 | → `omk doctor` |
| 查看 / 浏览报告 | → `omk studio`（启动本地报告浏览器） |
| 看真实使用 trace | → `omk observe` |

如果用户意图不明确，先扫描当前项目结构（skills/ 目录和 eval-samples 文件），然后推荐最合适的操作。

## 第三步：检测项目结构

使用 Glob 和 Read 工具检查：

1. `skills/` 目录下有哪些 skill 文件（`.md` 或 `*/SKILL.md`）
2. 是否存在 `eval-samples.json` / `eval-samples.yaml` / `eval-samples.yml` / `<skill>/.omk/samples.json`（推荐的标准位置）
3. 是否有 `skills/*.eval-samples.json`（每 skill 配对文件 → `--batch` 模式）

根据检测结果决定：

- 多个 skill + 各自的 eval-samples → 建议 `--batch` 批量模式
- 多个 skill + 共享 eval-samples → 建议版本对比模式
- 只有一个 skill → 建议 `baseline` 对照（`omk eval --control baseline --treatment <skill>`）或 `omk evolve` 改进
- 没有 eval-samples → 先 `omk sample <skill>` 生成

## 第四步：执行操作

### 评测 skill

```bash
# 单 skill 必要性测试（有 skill vs 没 skill）
omk eval --control baseline --treatment my-skill

# 版本 A/B 对比
omk eval --control my-skill-v1 --treatment my-skill-v2

# 对比 git 历史里的版本跟当前
omk eval --control git:my-skill --treatment my-skill

# 批量评测：每个 skill 独立 vs baseline
omk eval --batch

# 先预览任务计划再执行
omk eval --control v1 --treatment v2 --dry-run

# 复杂配置走 eval.yaml
omk eval --config eval.yaml
```

常用选项：

- `--model <name>` 任务执行模型（默认 opus；省钱用 sonnet / haiku）
- `--effort <low|medium|high|xhigh|max>` 执行模型扩展思考预算（默认 low；跨 effort 报告不严格可比）
- `--judge-models <executor:model[,...]>` 评委配置（默认 claude:haiku，≥ 2 条 = ensemble）
- `--concurrency <n>` 并发数
- `--skip-doctor` 跳过 doctor preflight 门禁（默认 doctor 会先跑一次卡掉 skill 写法大问题）
- `--no-diagnostic` 关掉 diagnostic 诊断 LLM 调用（默认开启，给 failed sample 出「哪错了 + 怎么改」建议）
- `--no-judge` 关掉评委主观评分（保留断言层）

### 自动迭代改进

```bash
omk evolve skills/my-skill.md --rounds 5
omk evolve skills/my-skill.md --rounds 10 --target 4.5
# 严格留出 + 锁定 test：按 val 显著性接受、收尾给无偏泛化分
omk evolve skills/my-skill.md --holdout-ratio 0.2 --test-ratio 0.2
```

evolve 默认开**显著性接受门**：候选只在相对当前最优**统计显著更好**时才被接受（`bootstrapDiffCI` 的 95% CI 排除 0），而不是「分数高一点点就收」—— 拒绝与评委噪声不可分的提升。决策样本太少时退回点估计并 warn；`--no-significance-gate` 可关。配 `--holdout-ratio` 留出 val 选择集、`--test-ratio` 再锁一份全程不参与选择的 test 集，收尾读一次给无偏泛化分。改动过大的候选评测前直接判拒（`--edit-budget`，默认 0.2）。

**重要：evolve 必须在前台运行（不要用 `run_in_background`）。** 原因：evolve 自带实时进度输出，每个 sample 执行时会打印 `[1/5] s001/... ⏳ 执行中...`，每轮完成会打印 `Round N: score=... ✓ ACCEPT / ✗ REJECT`。前台运行时用户能实时看到这些进度，无需手动询问。设置足够长的 timeout（建议 600000ms）以确保命令不会中途超时。

### 生成测试用例

```bash
# 为单个 skill 生成
omk sample skills/my-skill.md

# 显式指定数量（不指定时 LLM 根据 skill 类型自动决定 4-8 条）
omk sample skills/my-skill.md --count 8

# 自然语言指定重点覆盖场景
omk sample skills/my-skill.md --focus "重点覆盖搜索失败 / 权限拒绝 / 跨工具 fallback 路径"

# 为 skill 目录下所有缺测试集的 skill 批量生成
omk sample --batch
```

输出位置：`<skill>/SKILL.md` 风格 → `<skill>/.omk/samples.json`（标准），其他 `.md` 路径 → 当前目录 `eval-samples.json`（兜底）。

### 体检 skill 写法

```bash
# 全量体检（含 LLM-judge 维度）
omk doctor

# 只跑静态检查不调 LLM
omk doctor --static-only

# 针对单 skill
omk doctor skills/my-skill.md
```

`omk eval` 默认会先跑一次 doctor 当 preflight 门禁，所以一般不用单独跑；想在 eval 之前先把结构问题先扫一遍再跑评测，就单独跑 `omk doctor`。

### 查看 / 浏览报告

```bash
omk studio                                # 启动本地 web 报告浏览器
omk studio --port 8080                    # 改端口
omk studio --host 0.0.0.0                 # 局域网访问（默认 127.0.0.1）
omk studio --no-open                      # 不自动开浏览器
```

Studio 是 skill-centric：列表页（`/`）按 skill 卡片展示健康等级 / 0-100 参考分 / 待优化数 / 趋势；详情页（`/skills/<name>`）左栏列关键问题清单，右栏画健康趋势 + 三档阶段卡（doctor / eval / observe）。访问 `/observations/inbox` 查看 observe inbox 看板。

## 第五步：解读结果

`omk eval` 跑完会自动启动 studio 并输出 JSON 结果。你需要用自然语言总结关键发现：

### 版本对比模式

总结要包含：

1. **结论**：verdict 是 PROGRESS / NOISE / REGRESSION / CAUTIOUS，哪个 variant 更好
2. **质量分数**：各 variant 的平均综合分（0-5 分）+ Δ + 95% CI
3. **成本对比**：token 消耗、execCostUSD、判官花费、diagnostic 花费
4. **低分样本**：哪些样本两个版本差异最大，rubric 期望 vs 实际差在哪
5. **建议**：基于数据给出的下一步行动建议

示例输出：

```
v2 比 v1 更好（verdict: PROGRESS，Δ=+0.7，95% CI [+0.3, +1.1]）：
- 质量：v2 平均 4.5 分 vs v1 平均 3.8 分（+18%）
- 成本：v2 略高（$0.15 vs $0.12），因为输出更详细
- 亮点：v2 在 s002（错误处理）上显著提升（2.5 → 4.5），因为新增了"列出所有缺失的错误处理场景"指令
- 建议：v2 可以上线，但 s003（XSS 检测）仍然有提升空间
```

### evolve 模式

总结进化过程：起始分数 → 最终分数，接受 / 拒绝了哪些改进，总花费。如果用户想看具体改了什么，引导查看 `skills/evolve/` 目录下的版本文件。

### 批量评测模式（`--batch`）

列出每个 skill 的 baseline 分 vs skill 分和提升幅度，高亮表现最好和最差的 skill。

## 指定工作目录（cwd）

当评测用例需要模型读取特定仓库的代码时，可在 sample 中设置 `cwd` 字段：

```yaml
- sample_id: task-001
  prompt: "实现用户登录功能，要求支持手机号和邮箱两种方式"
  cwd: "/path/to/target-repo"
  assertions:
    - type: contains_all
      values: ["auth.ts", "login.tsx"]
```

`cwd` 会作为 executor 的工作目录，`claude -p` 将在该目录下运行，能自动读取仓库代码。适用于「给一个任务 query，断言应该修改哪些文件」的 A/B 评测场景。

## 注意事项

- 评测需要调用 LLM，会产生费用。运行前告知用户预估成本（样本数 × 变体数 × 约 $0.01-0.05 美元 / 次）
- 首次使用建议先 `--dry-run` 预览任务计划
- `evolve` 命令会修改原始 skill 文件，原始版本保存在 `skills/evolve/*.r0.md`
- 详细命令参考见 [commands.md](references/commands.md)
