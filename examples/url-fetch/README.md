# url-fetch 示例

最小的「单 skill」评测：只有一个 skill 时，omk 自动注入一个无 skill 的 baseline 作对照，于是你直接得到「加了这个 skill 比裸模型好多少」。

- `skills/v1/`：技术文档分析助手 skill
- `eval-samples.json`：文档 / 内容分析用例

## 跑

```bash
cd examples/url-fetch
omk eval --control baseline --treatment v1
```

`baseline` 是 omk 自动提供的空 skill 对照，不需要你自己写——单 skill 场景下最省事的 A/B。

## 看点

很多真实场景就是「我加了一个 skill，到底有没有用」。这个例子展示最短路径：一个 skill + 一组用例 + 自动 baseline。
