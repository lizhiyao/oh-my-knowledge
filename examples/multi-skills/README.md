# multi-skills 示例

一次评测一组 skill —— `omk eval --batch` 把 skill 目录下的每个 skill 各自跟 baseline 对比。

- `skills/summarizer/`、`skills/translator/`、`skills/classifier/`：三个目录式 skill，各带自己的 `eval-samples.json`

## 跑

```bash
cd examples/multi-skills
omk eval --batch --skill-dir skills
```

会逐个 skill 跑评测、输出一份批量结论（每个 skill 各自的 verdict + 整体是否通过）。

离线试跑（无 API key）：接上 echo 执行器，

```bash
omk eval --batch --skill-dir skills --executor ../custom-executor/echo-executor.sh --no-judge
```

## 看点

batch 模式按目录发现 skill：每个 skill 一个目录 `SKILL.md` + 就近的 `eval-samples.json`。适合管理一整个 skill 库、定期回归。
