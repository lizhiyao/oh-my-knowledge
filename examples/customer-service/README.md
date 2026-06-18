# customer-service 示例

`omk evolve` —— 让 omk 自动迭代 skill：跑评测 → 按失败用例改写 skill → 再评测，留下每一轮的产物供对比。

- `skills/service-guide/`：客服服务规范 skill
- `skills/evolve/service-guide.r0.md` / `.r1.md` / `.r2.md`：一次 evolve 跑出来的三轮迭代产物（r0 → r1 → r2），可直接 diff 看每轮改了什么
- `eval-samples.json`：3 条客服场景用例（耳机损坏 / 包裹丢失 / 自动续费退款）

## 跑

先看单次评测：

```bash
cd examples/customer-service
omk eval --control baseline --treatment service-guide
```

再看自动迭代（会按本轮失败项改写 skill、多轮收敛）：

```bash
omk evolve skills/service-guide --rounds 2
```

## 看点

evolve 用 holdout 切分 + 过拟合门控防止「只把 skill 改得过拟合训练用例」。`evolve/` 里的 r0/r1/r2 就是迭代留痕——演示「改了真的变好了吗」用数据回答。
