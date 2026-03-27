# 你的 Prompt 改了之后，真的变好了吗？

## 一个被忽视的问题

做知识工程的同学应该都有这个经历：改了一版 skill（系统提示词、知识包、规则集等知识载体），试了几个 case 觉得"好像好了"，就上线了。

但你怎么确定"好了"？

- 试的那几个 case 能代表全部场景吗？
- 上次改完是不是也觉得好了，结果线上翻车了？
- 你说好了，leader 说没看出来，怎么办？

**靠感觉判断 skill 质量，就像不写测试就上线代码一样危险。**

## 如果 Skill 也有单元测试？

想象一下：你有一个工具，能像跑单元测试一样评测 skill 的质量——固定测试样本，固定模型，只变 skill 版本，用分数告诉你到底好没好。

这就是 [oh-my-knowledge](https://npmjs.com/packages/oh-my-knowledge/meta) 做的事。

### 30 秒上手

```bash
# 安装
npm i oh-my-knowledge -g

# 在你的项目目录
omk bench init my-eval
cd my-eval

# 放入你的 skill，运行评测
omk bench run
```

工具自动发现 `skills/` 目录下的所有 skill 版本，用同一批测试样本跑评测，输出四维对比报告：质量、成本、效率、稳定性。

### 真实场景演示

假设你维护一个客服话术 skill。v1 是简单版：

```
你是一个客服代表。请回答用户的问题。
```

v2 加了详细规范：

```
你是一名专业的客服代表，请遵循以下服务规范：
1. 开头先表达对用户问题的理解和共情
2. 提供准确、具体的解决方案，附上操作步骤
3. 如涉及退款/赔偿，主动说明处理时效和金额
4. 结尾询问是否还有其他问题，语气亲切自然
5. 全程使用"您"称呼用户，避免生硬的模板话术
```

跑一次评测：

```bash
omk bench run --variants v1,v2
```

几分钟后，报告告诉你：

| 维度 | v1 | v2 |
|------|----|----|
| 质量 | 3.2 | 4.75 |
| 成本 | $0.08 | $0.12 |
| 延迟 | 8,500ms | 13,000ms |
| 稳定性 | 100% | 100% |

**数据说话：v2 质量提升 48%，代价是成本增加 50% 和延迟增加 53%。** 值不值得，团队可以基于数据决策，而不是"我觉得好了"。

### 不只是对比版本

工具还支持几个实际场景：

**场景一：0→1 验证**

写了第一个 skill，想知道"加了这个 skill 到底有没有用"：

```bash
omk bench run --variants baseline,my-skill
```

`baseline` 是不使用任何 skill 的裸模型，直接对比有无 skill 的效果差异。

**场景二：改完就对比**

改了 skill 但旧版本已经覆盖了：

```bash
omk bench run --variants git:my-skill,my-skill
```

工具从 git 历史读取上次提交的版本，和当前版本对比。不需要手动备份。

**场景三：批量体检**

团队有 10 个不同的 skill，想一次性看每个的效果：

```bash
omk bench run --each
```

每个 skill 独立和 baseline 对比，生成一份合并报告。

## 更进一步：让 AI 自己改 Skill

到这里，工具解决了"怎么衡量"的问题。但还有一个更大的问题：**改 skill 本身就很费时间。**

Karpathy 发布了 autoresearch，核心思路很简单：让 AI 在循环里自我改进。试一个小改动，看结果变好了没有，变好就留下，没变好就扔掉，然后再来一次。

我们把这个思路用在了 skill 工程上：

```bash
omk bench evolve skills/my-skill.md --rounds 5
```

工具会：
1. 评测当前 skill，得到 baseline 分数
2. 把低分样本的反馈喂给 AI，让它改进 skill
3. 评测改进版
4. 分数涨了 → 保留，没涨 → 回退
5. 重复 N 轮

整个过程自动完成。你只需要看最终结果，以及 `skills/evolve/` 目录下每轮的 diff。

**AI 自己改 skill，自己打分，自己迭代——用数据驱动，不靠人工判断。**

## 在 Claude Code 中使用

如果你用 Claude Code，可以通过自然语言交互，不用记命令：

```bash
# 安装 omk 后，将 skill 复制到全局目录（一次性操作）
cp -r $(npm root -g)/oh-my-knowledge/.claude/skills/omk ~/.claude/skills/
```

然后直接说：

```
/omk eval        # 评测 skill
/omk evolve      # 自动迭代改进
```

或者用自然语言："帮我评测 v1 和 v2 的差异"，skill 会自动理解意图、检测项目结构、调用 omk 命令并解读结果。

## 试试看

```bash
npm i oh-my-knowledge -g
```

3 分钟跑一次评测，让数据告诉你 skill 改了之后到底好没好。

代码不能没有测试就上线，skill 也一样。

有问题随时找我（lizhiyao）。
