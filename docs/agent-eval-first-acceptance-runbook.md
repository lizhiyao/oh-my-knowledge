# Agent 能力验收执行手册

## 一、目标

这份手册用于把 OMK 的第一轮 agent 能力验收跑成一套固定动作。

目标不是证明业务价值，而是验证下面四件事是否已经稳定：

- 对照组语义清晰
- `cwd` / cache 隔离正确
- trace 足够完整可解释
- agent 断言真的有区分度

## 二、开始前

先确认：

- 已安装并认证 Claude Code
- 使用 `claude-sdk` 执行器
- 当前仓库已经能正常运行 `omk bench run`
- 当前分支的代码与验收样本保持一致

建议先做一次最小检查：

```bash
omk bench run --dry-run \
  --executor claude-sdk \
  --samples examples/agent-eval/control-experiments/env-isolation.eval-samples.json \
  --variants baseline,project-a-env@examples/code-review,project-b-env@examples/prd-agent
```

这一步只看一件事：

- dry-run 里每个 variant 的 `experimentRole`、`executionStrategy`、`cwd` 是否符合预期

## 三、推荐执行顺序

第一轮验收固定按下面顺序跑：

1. 环境隔离实验
2. 显式 artifact 注入实验
3. agent 断言区分实验

不要跳顺序。

原因是：

- 先验证 runtime context 是否真的生效
- 再验证显式 artifact 注入是否能稳定改变行为
- 最后再验证断言能不能把这些差异测出来

## 四、实验 A：环境隔离

### 1. 执行命令

```bash
omk bench run \
  --executor claude-sdk \
  --samples examples/agent-eval/control-experiments/env-isolation.eval-samples.json \
  --variants baseline,project-a-env@examples/code-review,project-b-env@examples/prd-agent
```

### 2. 必看项

- `baseline` 与两个 `project-*-env` 的输出是否明显不同
- trace 里是否真的读取了不同项目下的文件
- `project-a-env` 与 `project-b-env` 的 `cwd` 是否不同
- 报告里的 `variantConfigs` 是否正确标出 `runtime-context-only`

### 3. 通过标准

- 三组结果能拉开差异
- 差异能被 runtime context 解释
- 没有出现错误复用缓存的迹象

### 4. 常见失败信号

- 三组回答几乎一样
- trace 看不出读取了什么
- 报告里无法解释为什么 project-a 和 project-b 不同

## 五、实验 B：显式 Artifact 注入

### 1. 执行命令

```bash
omk bench run \
  --executor claude-sdk \
  --samples examples/agent-eval/control-experiments/artifact-injection.eval-samples.json \
  --variants baseline,examples/agent-eval/control-experiments/skills/strict-reader.md@examples/code-review
```

### 2. 必看项

- 显式 artifact 注入组是否更稳定地读取目标文件
- 工具路径是否更短、更受控
- 输出是否更贴近 artifact 里定义的行为约束
- trace 中是否能看到更一致的执行顺序

### 3. 通过标准

- artifact 注入组在关键断言上优于 baseline
- 行为差异能被 artifact 本身解释
- 没有出现“看起来更高分但说不清为什么”的情况

### 4. 常见失败信号

- baseline 和 artifact 组几乎没有差异
- 结果有差异，但 trace 解释不出来
- artifact 组仍然存在大量无关探索

## 六、实验 C：Agent 断言区分度

### 1. 执行命令

```bash
omk bench run \
  --executor claude-sdk \
  --samples examples/agent-eval/control-experiments/assertion-discrimination.eval-samples.json \
  --variants baseline,project-env@examples/code-review,examples/agent-eval/control-experiments/skills/strict-reader.md@examples/code-review
```

### 2. 必看项

- 哪些断言三组都过
- 哪些断言三组都挂
- 哪些断言只有 `runtime-context-only` 或 `artifact-injection` 组能过
- 报告分析里是否出现 agent assertion discrimination 的提示

### 3. 通过标准

- 至少 30% 的 agent 断言具备真实区分度
- 没有大面积“全过”或“全挂”却无法解释
- 可以明确说出哪类断言最有用、哪类断言需要重写

### 4. 常见失败信号

- 大部分断言完全拉不开差异
- 工具路径确实不同，但断言测不出来
- 断言设计过严，导致所有组一起失败

## 七、每次都要记录什么

每次实验至少记录下面 6 项：

- 实验目标
- 命令
- 对照组
- 关键差异
- 是否通过
- 下一步动作

建议直接按这个模板记：

```md
## 实验名

- 命令：
- 对照组：
- 关键差异：
- 是否通过：
- 失败原因：
- 下一步：
```

## 八、第一轮结束后的判断

只有下面四件事同时成立，才算第一轮 agent 能力验收通过：

- runtime context 差异能稳定复现
- artifact 注入差异能稳定复现
- trace 足够解释实验结论
- agent 断言区分度达标

只要其中一条不成立，就继续修尺子，不进入更复杂的新功能或更大规模业务试点。

## 九、下一步优先级

如果第一轮通过，下一步按这个顺序推进：

1. 固化团队统一实验模板
2. 增加 1 组真实业务小样本试点
3. 再扩展更多 agent 能力或新功能

如果第一轮没通过，下一步按这个顺序修：

1. 先修 trace
2. 再修断言
3. 再修报告解释
4. 最后再补实验样本

## 十、值班版速查

如果你是第一次值班跑验收，只按下面顺序执行：

### 1. 先跑 dry-run

```bash
omk bench run --dry-run \
  --executor claude-sdk \
  --samples examples/agent-eval/control-experiments/env-isolation.eval-samples.json \
  --variants baseline,project-a-env@examples/code-review,project-b-env@examples/prd-agent
```

只检查 3 件事：

- `baseline` 是否是 `baseline`
- `project-*-env` 是否是 `runtime-context-only`
- `cwd` 是否分别指向不同项目目录

### 2. 再跑三组正式实验

按顺序跑：

- 环境隔离
- artifact 注入
- 断言区分度

### 3. 每跑完一组只问 1 个问题

- 这组差异，到底是 artifact 引起的，还是 runtime context 引起的？

如果答不清，就先不要进入下一组。

### 4. 每组都写记录

直接复制这里的模板：

- [agent-eval-acceptance-record-template.md](file:///Users/lizhiyao/Documents/oh-my-knowledge/docs/agent-eval-acceptance-record-template.md)

### 5. 最终放行标准

只有以下四项都成立，才允许进入真实业务试点：

- runtime context 差异稳定
- artifact 差异稳定
- trace 可解释
- 断言有区分度

## 十一、失败排查顺序

如果实验跑出来“不对劲”，按下面顺序排：

### 1. 先排实验语义

看：

- dry-run 的 `experimentRole`
- dry-run 的 `executionStrategy`
- dry-run 的 `cwd`

如果这里就错了，不要继续看分数。

### 2. 再排 trace

看：

- 有没有 `turns`
- 有没有 `toolCalls`
- `traceCoverage` 是否偏低
- 是否能看出读了哪个文件、走了哪条工具路径

如果 trace 解释不了行为差异，先修 trace，不要先改断言。

### 3. 再排断言

看：

- 哪些断言三组都过
- 哪些断言三组都挂
- 报告里是否提示 `agent_assertion_discrimination_low`

如果大量断言全过或全挂，先重写断言，不要急着改 artifact。

### 4. 最后才排 artifact 本身

只有在前面三层都没问题时，才判断是 artifact 设计不够好。

## 十二、常见问题与处理动作

| 现象 | 优先怀疑 | 处理动作 |
|---|---|---|
| 三组结果几乎一样 | runtime context 没生效 / trace 不完整 | 先看 dry-run 的 `cwd` 和 `experimentRole`，再看 trace 是否真的读了不同文件 |
| 报告分数有差异，但说不清原因 | trace 不完整 | 优先补 trace，不先改样本 |
| 工具路径明显不同，但断言没测出来 | 断言区分度不足 | 重写 `tools_called` / `tool_input_contains` / `turns_max` |
| 所有组都高分 | 断言过弱 | 增加工具路径约束、关键文件读取约束 |
| 所有组都低分 | 断言过严 / 样本不合理 | 先放宽 turns/tool count，再检查 prompt 是否过难 |
| baseline 与 artifact 组无差异 | artifact 注入不稳定 | 先检查 artifact 内容是否真的约束了行为，再看 trace 是否体现差异 |
