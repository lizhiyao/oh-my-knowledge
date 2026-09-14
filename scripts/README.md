# 仓库维护脚本

日常操作优先使用根 `package.json` 的 `yarn` 命令。这里是维护实现，不是 npm 包的公开 API；执行目录为仓库根。

| 目录 | 职责 | 入口 |
| --- | --- | --- |
| `build/` | 文档与 Schema 生成、运行时资源复制、Studio 打包 | `yarn build`、`yarn build:docs`、`yarn schemas:write` |
| `ci/` | 变更分类、快速检查、测试污染检查、进程诊断 | `yarn ci:quick`、`yarn test`；Actions 调用 `scope.mjs` 和 `diagnostics.mjs` |
| `release/` | 精确提交 CI 证据、安装包验收与发布 | 发布工作流调用 `evidence.mjs` 和 `package.mjs` |
| `bench/` | 测试耗时分析、Studio 性能基线 | `yarn test:profile`、`yarn studio:baseline` |

诊断统一使用 `node scripts/ci/diagnostics.mjs run NAME DIR TIMEOUT_MS COMMAND...` 执行命令，使用 `node scripts/ci/diagnostics.mjs report DIR` 汇总同一目录的结果。失败分类、日志格式和报告归属同一模块。

新增维护能力先扩展对应职责内的脚本；只有独立执行边界才增加入口，不在根目录堆放脚本，也不为文件数量强行合并独立职责。产品业务逻辑仍归 `src/`，脚本只负责维护编排。

`.mjs`／`.cjs` 直接运行，三个 TypeScript 脚本由 `yarn build:scripts` 编译到保持目录结构的 `dist-scripts/`。移动脚本时同步检查自身定位仓库根的逻辑、相对 import、`package.json`、Actions、测试 fixture 和生成文档；编译输出路径变化后执行 `yarn clean` 再构建。
