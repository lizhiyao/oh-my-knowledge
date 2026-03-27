# OMK 命令参考

## omk bench run

运行评测，对比不同 skill 版本的效果。

```
omk bench run [选项]

选项：
  --samples <路径>       样本文件（默认：eval-samples.json）
  --skill-dir <路径>     skill 目录（默认：skills）
  --variants <a,b>       变体名称，不指定时自动从 skill 目录发现
  --model <名称>         被测模型（默认：sonnet）
  --judge-model <名称>   评委模型（默认：haiku）
  --concurrency <n>      并行任务数（默认：1）
  --no-judge             跳过 LLM 评分
  --dry-run              仅预览任务计划
  --blind                盲测模式
  --repeat <n>           重复 N 次做方差分析
  --each                 批量模式：每个 skill 独立和 baseline 对比
  --executor <名称>      执行器（默认：claude）
```

Variant 特殊值：
- `baseline` — 无 skill 对照
- `git:name` — 从 git HEAD 读取旧版本
- `git:ref:name` — 从指定 commit 读取
- 含 `/` 的路径 — 直接读取文件

## omk bench evolve

AI 自动迭代改进 skill。

```
omk bench evolve <skill路径> [选项]

选项：
  --rounds <n>           最大迭代轮数（默认：5）
  --target <分数>        目标分数，达到即停
  --samples <路径>       样本文件（默认：eval-samples.json）
  --improve-model <名称> 改进用模型（默认：sonnet）
```

每轮版本保存在 `skills/evolve/` 目录。连续 2 轮无改进自动早停。

## omk bench gen-samples

LLM 辅助生成测评用例。

```
omk bench gen-samples <skill路径>        # 单个 skill
omk bench gen-samples --each             # 批量生成

选项：
  --count <n>            样本数（默认：5）
  --model <名称>         生成用模型（默认：sonnet）
  --skill-dir <路径>     skill 目录（配合 --each）
```

## omk bench report

启动报告服务或导出报告。

```
omk bench report                         # 启动 web 服务
omk bench report --export <报告名称>     # 导出独立 HTML

选项：
  --port <端口号>        服务端口（默认：7799）
  --reports-dir <路径>   报告目录
```

## omk bench ci

CI 流水线中运行评测，分数达标退出 0，否则退出 1。

```
omk bench ci [选项]
  --threshold <数值>     达标分数（默认：3.5）
```

## eval-samples 字段参考

| 字段 | 必填 | 说明 |
|------|------|------|
| `sample_id` | 是 | 唯一标识 |
| `prompt` | 是 | 用户提示词 |
| `context` | 否 | 附加上下文（代码片段等） |
| `cwd` | 否 | executor 工作目录，用于指定目标仓库路径 |
| `rubric` | 否 | LLM 评分标准 |
| `assertions` | 否 | 断言数组 |
| `dimensions` | 否 | 多维度评分 { 维度名: 评分标准 } |

## omk bench init

生成评测项目脚手架。

```
omk bench init [目录]
```
