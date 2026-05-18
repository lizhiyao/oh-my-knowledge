# omk 快速上手：给 skill 跑评测

5 分钟跑出第一份报告。目标读者：手里有一版（或几版）skill，想用数据看看「这版 skill 到底好不好」「v1 跟 v2 哪版更稳」。

## 前置（1 分钟）

```bash
npm i oh-my-knowledge -g
omk --version    # 能输出版本号即装好
```

如果你想用「自然语言让 agent 帮你跑」的方式（推荐），还需要把 omk skill 装到你的 agent 工具里。Claude Code 用户：

```bash
git clone https://github.com/lizhiyao/oh-my-knowledge.git /tmp/omk-src
mkdir -p ~/.claude/skills
cp -r /tmp/omk-src/.claude/skills/omk ~/.claude/skills/
```

Codex 用户改 `~/.codex/agents/skills/`。装好之后，agent 收到含「omk」「评测」「benchmark」之类的关键词就会自动加载 SKILL 上下文。

## 准备 skill（1 分钟）

按 omk 默认布局把 skill 放到 `skills/` 目录下。**推荐用单 `.md` 文件**，最简单：

```
skills/
├── my-skill-v1.md
└── my-skill-v2.md
```

只有当 skill 内容超长、想把示例 / 参考资料拆到独立文件时，再用目录式（每版一个目录）：

```
skills/
├── my-skill-v1/
│   └── SKILL.md
└── my-skill-v2/
    ├── SKILL.md
    └── references/      长示例 / 参考资料
        └── examples.md
```

两种形式 omk 都能识别，混用也行。要跑 v1 vs v2 对比就按上面放两版；只想看「有 skill vs 没 skill」的差距，放一份就够，用 baseline 对照。

## 跑评测（3 分钟）

### 路径 A：自然语言（推荐）

打开 Claude Code，进入项目目录，直接说一句话：

> 帮我用 omk 给 skills/my-skill 跑一次评测

omk skill 会自动判断：没有 `eval-samples.json` 就先帮你生成用例，然后跑评测，最后把报告浏览器弹出来。常见说法：

- 「用 omk 对比 skills/my-skill-v1 跟 skills/my-skill-v2」
- 「用 omk 给 skills/audit 跑 baseline 对照（有 skill vs 没 skill）」
- 「用 omk 跑 skills/ 下面所有 skill 的批量评测」
- 「用 omk evolve 自动改进 skills/my-skill，跑 5 轮」

### 路径 B：直接命令行

```bash
omk sample skills/my-skill.md                       # 第一次:让 AI 给你的 skill 生成评测用例
omk eval --control v1 --treatment v2 --dry-run      # 预览要跑什么
omk eval --control v1 --treatment v2                # 真跑
omk studio                                          # 启动报告浏览器
```

`--dry-run` 预览时会告诉你预估调用次数和成本，确认 OK 再去掉 flag 真跑。`omk eval` 默认会先跑一次 doctor 健康度检查当门禁，发现 skill 写法有大问题就直接拦下来；如果你确认知道自己在干嘛，加 `--skip-doctor` 绕过。

## 看结果（1 分钟）

报告浏览器自动弹出（默认 `http://127.0.0.1:7799/`），重点看三个地方：

**verdict**（跨版本结论）：`PROGRESS`（变好）/ `NOISE`（差距在置信区间内不可区分）/ `REGRESSION`（变差）/ `CAUTIOUS`（趋势好但置信不足）。这是你能直接拿出去对焦的一句话结论。

**综合分**：每版 0-5 分平均，跟基线比 `+Δ` 多少。Δ 旁边的 95% 置信区间决定 verdict 落点。

**低分用例**：点开看 LLM 在哪条用例上崩了。对照「rubric 期望」跟「LLM 实际输出」找差距 —— 通常能直接看出 skill 文档哪段写得不够清楚。

## 关键提示

**用例生成会花时间**。omk 默认让 AI 给你的 skill 生成 10-20 条用例，但 AI 生成的用例**有偏**：容易扎堆在 skill 文档已经写清楚的「happy path」上，对边界 / 反例 / 误用场景覆盖不足。**强烈建议**第一次跑完之后花 30 分钟人工筛一遍：删掉不合理的、补缺关键边界、补几条「故意写错的用户指令」看 skill 会不会被带偏。这是评测结果可信度的最大变量。

**评测会产生 LLM 费用**。粗算单条用例 × 单 variant 约 $0.01-0.05 美元，10 条用例 × 2 variants 约 $0.2-1 美元。跑前 `--dry-run` 预览。

**结论只对你给定的用例集负责**。「我这版 skill 更好」这句话的天花板是「在你设计的 N 条用例上更好」。换用例集结论可能翻盘。所以**用例设计本身就是结论可信度的源头** —— 不要把它当成「跑评测前的麻烦事」，它就是评测本身。

## 常见场景速查

| 想做什么 | 自然语言说法 | 等价命令 |
|---|---|---|
| 第一次给 skill 跑分 | 给 skills/X 跑 baseline 对照 | `omk eval --control baseline --treatment X` |
| 改完前后对比 | 对比 git 历史里的 skills/X 跟当前版本 | `omk eval --control git:X --treatment X` |
| 让 omk 帮我自动改 skill | 用 omk evolve skills/X 跑 5 轮 | `omk evolve skills/X.md --rounds 5` |
| 批量评测一批 skill | 给 skills/ 下所有 skill 跑评测 | `omk eval --batch` |
| 只生成用例不跑评测 | 给 skills/X 生成测试用例 | `omk sample skills/X.md` |
| 单独跑健康度检查 | 给 skills/X 做 doctor 体检 | `omk doctor skills/X.md` |
| 看历史报告 | 打开 omk studio | `omk studio` |

## 跑完第一份报告，对焦时拿这些信息走

- verdict + 综合分 + Δ + 95% CI 区间
- 哪几条用例分数最低，rubric 期望 vs LLM 实际差在哪
- 你对哪些用例的设计有疑问（避免「数据说话也要怀疑数据」的盲信）
- doctor 健康度结论（eval 默认会跑，报告里有；如果想单独审一次跑 `omk doctor`）

## 更深的玩法

- 详细 CLI / executor / judge / observe 参考：[README.zh.md](../../README.zh.md)
- 评分管道（assertion / llm / judge / dimension / composite 五层）：[scoring.md](./scoring.md)
- 测量学严谨性（Bootstrap CI / Krippendorff α / length-debias 等）：[statistical-rigor.md](./statistical-rigor.md)
- 用例设计规范（mocks / environment / tripwire / mocksStrict）：[sample-design-spec.md](../sample-design-spec.md)
