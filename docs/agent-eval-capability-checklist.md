# Agent 评测能力验收清单

## 一、这份清单解决什么问题

当我们开始用 OMK 评测 Agent 时，最容易犯的错不是“样本写得不够多”，而是：

- 还没有确认自己到底在测什么
- baseline 语义不稳定
- artifact、runtime context、system prompt 注入混在一起
- 结果看起来很漂亮，但结论解释不清

所以在大规模跑真实业务案例之前，建议先把 Agent 评测能力本身做一次验收。

这份清单的目标不是证明业务价值，而是证明：

> OMK 已经是一把足够稳定、足够可解释的尺子，可以开始测真实 Agent 了。

当前阶段的优先级建议也很明确：

- 先把 agent 评测能力本身做扎实
- 暂时不以“多加新功能”为第一优先级
- 先把语义、对照组、trace、断言、报告解释性打稳
- 等这把尺子稳定之后，再去扩更复杂的新能力

---

## 二、验收目标

Agent 评测能力第一阶段至少要满足 5 个目标：

1. **实验对象可控**
2. **对照组语义清晰**
3. **trace 与断言可信**
4. **报告结论可解释**
5. **团队成员能稳定复现**

只有这 5 条成立，再去测真实业务案例，结论才有价值。

---

## 三、能力验收清单

建议按下面 8 个维度逐项打勾。

### 1. baseline 语义是否清晰

至少要区分清楚三种 artifact / runtime context 组合：

- `baseline`
  - 无 system prompt
  - 不进入带知识的项目目录
- `project-env@/path/to/project`
  - 推荐写法
  - 表达“空 artifact + 项目级 runtime context”
- `/path/to/SKILL.md@/path/to/project`
  - 显式 artifact 注入
  - 同时进入指定项目目录运行

这里统一使用更直接的三分法：

- **CLI 暴露的是 variant 表达式，解析后得到 artifact 与 runtime context**
- **skill、agent 是 artifact kind，不是所有场景的总称**
- **agent 更多是运行时形态**：是否有工具调用、是否在 Claude Code/SDK 下运行、是否消费 `CLAUDE.md` 和项目内知识
- 所以在命令层，建议先把对照组写成：
  - `baseline`
  - `project-env@/path/to/project`
  - `/path/to/SKILL.md@/path/to/project`

**通过标准：**

- 团队成员能清楚说出“裸 baseline”与“空 artifact + 项目级 runtime context”的差异
- README/命令示例能明确表达这三者

### 2. cwd 粒度是否正确

要确认 `cwd` 是 **variant/artifact 级别** 生效，而不是只在 sample 级别共享。

**通过标准：**

- 同一组样本下，不同 variant 可以绑定不同 `cwd`
- 报告里能回溯到 request 中的 artifact + cwd 配置

### 3. cache 是否隔离实验

对 Claude Code / Claude SDK 场景来说，`cwd` 本身就是 runtime context 的一部分。

**通过标准：**

- 相同 prompt + 相同 system + 不同 `cwd` 不会命中同一缓存
- 相同 prompt + 相同 system + 相同 `cwd` 会命中同一缓存

### 4. trace 是否完整可信

至少要稳定采集这些字段：

- `turns`
- `toolCalls`
- `toolSuccessRate`
- `numTurns`
- `numToolCalls`
- `toolNames`
- timing

**通过标准：**

- 工具调用条目与实际执行过程一致
- 报告中能解释“为什么这轮多调用了工具”

### 5. agent 断言是否有区分度

不要只写“所有变体都能过”的弱断言。

第一阶段建议重点看这些断言是否稳定：

- `tools_called`
- `tools_not_called`
- `tool_input_contains`
- `tool_output_contains`
- `tools_count_min`
- `tools_count_max`
- `turns_min`
- `turns_max`

**通过标准：**

- 同一批样本中，至少有一部分断言能够区分 baseline 与 knowledge/artifact 组
- 不会出现大量“全部变体都通过”的无效断言

### 6. 报告是否可解释

报告不只是展示分数，还要能说明：

- 是 runtime context 起作用，还是显式 artifact 起作用
- 是工具路径改善了，还是内容判断改善了
- 是效率提升了，还是业务正确性提升了

**通过标准：**

- 读报告的人能复述出“这次实验到底证明了什么”
- 不会把“空 artifact + 项目级 runtime context vs 显式 artifact”误读成“裸模型 vs artifact”

### 7. CLI/README 是否足够防误用

如果语义正确，但使用门槛高，团队还是会反复跑偏。

**通过标准：**

- README 里有 agent 场景的对照组示例
- README 里明确说明 `variant@cwd`
- 新人第一次跑不会把 baseline 跑成 project baseline

### 8. 最小实验范式是否固定

团队必须知道“第一轮正确实验长什么样”。

**通过标准：**

- 有统一的最小实验模板
- 大家不会自己发明五花八门的对照方式

---

## 四、三组最小控制实验

不要一上来测真实 PRD 价值，先做控制实验校准评测能力。

### 实验 A：环境隔离实验

#### 目标

验证不同 `cwd` 是否真的代表不同 runtime context，且缓存不会串。

#### 对照组

```bash
baseline
project-a-env@/path/to/project-a
project-b-env@/path/to/project-b
```

#### 样本建议

选 2~3 条明显依赖项目级 runtime context 的问题：

- 项目里有哪些领域原则
- 某个本地 CLAUDE.md 里要求的分析步骤是什么
- 某个项目 skills 中定义的约束是什么

#### 看什么

- 输出内容是否明显不同
- trace 是否读取了不同项目里的知识文件
- cache 是否正确隔离

#### 通过标准

- 三组输出能拉开差异
- `project-a` 与 `project-b` 的 trace 指向不同 runtime context 来源
- 重跑时不存在错误复用缓存

---

### 实验 B：显式 artifact 注入实验

#### 目标

验证显式 artifact 注入是否带来可观察差异。

#### 对照组

```bash
baseline
/path/to/SKILL.md
/path/to/SKILL.md@/path/to/project
```

#### 样本建议

选 2~3 条明显应该被显式 artifact 约束的样本：

- 必须先读某个知识文件
- 禁止反问用户
- 必须采用某种固定输出结构

#### 看什么

- system prompt 注入后，行为是否稳定变化
- 是否更早进入目标工具路径
- 是否显著减少无关探索

#### 通过标准

- 显式 artifact 组在断言通过率或效率上明显优于 `baseline`
- `/path/to/SKILL.md@/path/to/project` 与 `/path/to/SKILL.md` 的差异可被解释

---

### 实验 C：Agent 断言区分实验

#### 目标

验证断言本身不是摆设，而是真的能测出 agent 行为差异。

#### 对照组

选择一组能明显产生工具路径差异的变体，例如：

```bash
baseline
project-env@/path/to/project
/path/to/SKILL.md@/path/to/project
```

#### 样本建议

只用 2~3 条，但要求每条都能明确区分：

- 是否必须调用 `Read`
- 是否必须读取某个关键文件
- 工具调用是否应限制在某个范围
- turns 是否应控制在某个上限

#### 看什么

- 哪些断言所有组都过
- 哪些断言只有 knowledge/artifact 组能过
- 哪些断言设计过严，导致全部失败

#### 通过标准

- 至少 30% 的断言具备真实区分度
- 不存在大面积“全过”或“全挂”而毫无解释

---

## 五、推荐的第一轮验收样本规模

不要太大，建议控制在：

- **3 组实验**
- **每组 2~3 条样本**
- **总样本数 6~9 条**

这已经足够回答：

- 评测对象语义是否清晰
- cwd/caching 是否正确
- trace/断言是否可信

---

## 六、验收结果记录模板

每组实验建议都记录以下内容：

| 项目 | 记录方式 |
|---|---|
| 实验目标 | 一句话说明要验证什么 |
| 对照组 | baseline / project-env@cwd / /path/to/SKILL.md@cwd |
| 样本数 | 2~3 |
| 关键断言 | 3~5 个 |
| 主要差异 | 输出、trace、分数、效率 |
| 是否通过 | 通过 / 部分通过 / 不通过 |
| 问题定位 | 语义、实现、断言、文档哪一层出问题 |
| 后续动作 | 修代码 / 改断言 / 改 README / 调整实验设计 |

---

## 七、第一轮验收结束后，才进入真实业务试点

只有下面这些条件都满足，才建议开始测真实业务价值：

- baseline 语义已稳定
- `cwd` 对照行为已验证
- cache 不污染实验
- trace 可解释
- 断言有区分度
- README/命令示例能让他人复现

如果这些还没打稳，就不要急着上复杂业务 case。

---

## 八、真实业务试点前的最小标准

在进入真实业务试点前，至少做到：

1. 有一份固定的 agent eval 最小实验模板
2. 有 1 轮通过的控制实验结果
3. 团队内至少 2 个人可以独立复现实验
4. 能清楚区分：
   - 裸 baseline
   - 空 artifact + 项目级 runtime context
   - 显式 artifact 注入

做到这一步，再去测 PRD skill、领域知识 agent，结论才会稳。

---

## 九、建议的下一步

如果接下来要继续推进，建议顺序如下：

### 第 1 步：先跑三组控制实验

不要先跑大案例。

### 第 2 步：把实验结论沉淀成团队统一范式

包括：

- 推荐命令
- 推荐断言
- 推荐对照组

### 第 3 步：再回到真实业务案例

这时再去测：

- PRD skill
- 统一领域知识 Agent
- Coding 场景

才会更稳。

---

## 十、一个最重要的判断标准

如果你还不能非常清楚地回答下面这个问题，就说明还应该继续做能力验收：

> 这次实验里，结果差异到底是由 artifact 引起的，还是由 runtime context 引起的？

只有当这个问题能被清楚回答时，OMK 的 agent 评测能力才算真正进入可用状态。
