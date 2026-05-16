# spike/ — CLI 框架候选 prototype

本目录是 [issue #109](https://github.com/lizhiyao/oh-my-knowledge/issues/109) 的 PR-A 产物：用真实候选框架实现 omk 三个代表性命令的最小可运行原型，验证「omk 该不该迁移到框架化 CLI」。

跟生产代码物理隔离：

- 不在主项目的 yarn workspace 里。spike 子项目自带 `package.json` + lockfile + `node_modules`。
- 不在主项目 `package.json` 的 deps / devDeps 里。
- 不进 npm publish。主 `package.json` 的 `files: ["dist/src/"]` 白名单天然过滤 `spike/`。
- 跑 `yarn lint && yarn build && yarn test` 在主项目里不受 spike 任何影响。

## 当前候选

- [`oclif/`](./oclif) — Salesforce/Heroku/Twilio/Shopify 用的平台型 CLI 框架。TS-first，内置 auto-doc / completion / plugin / JSON output。issue comment 2 把 omk 长期定位收敛到「Heroku 平台型 vs Vite 轻量工具」二选一，oclif 是平台型的首选验证对象。

## 为什么没对照 commander / clipanion / cac

issue comment 2 的决策框架是「omk 未来像 Heroku 平台型 CLI 还是 Vite 轻量工具」。commander / clipanion / cac 在 docs codegen 这条问题上的能力上限是「能 introspect program tree，但要自己写 renderer」——这跟 issue body 的「保底方案 typed CLI metadata registry」是同一条路径的不同包装。

也就是说：

- 如果 omk 走平台型 → 选 oclif（不需要 commander 数据点）
- 如果 oclif 失败 → fallback 是 typed metadata registry（不是 commander）

commander spike 写出来既不在主推路径上、也不在 fallback 上，加 0.3-0.5d 工期换不到边际信息。结论文档里再单独交代理由。

## 怎么跑

```bash
cd spike/oclif
yarn install      # 装 spike 自己的 deps,跟主项目隔离
yarn build        # tsc → dist/
./bin/run.js doctor --help
./bin/run.js sample skills/my-skill --count 5
./bin/run.js studio start --port 7799
```

每个候选目录自己有 `README.md` 列实验步骤。

## 验收 6 项

调研结论 + 矩阵在 [`docs/cli-framework-spike.md`](../docs/cli-framework-spike.md)，6 项是：

1. 双语 help（`--lang zh|en` / `OMK_LANG`）
2. unknown flag exit code 严格 2
3. `--no-*` + required + default + positionals
4. subcommand 元数据外部可 walk
5. docs 自动生成（README / man / commands ref）
6. npm 打包形态（`bin.omk` + `files` 白名单可平移）
