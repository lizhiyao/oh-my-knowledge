# CLI 领域规则

本文件补充仓库根 `AGENTS.md`，适用于 `src/cli/`。CLI 是 oclif 交付入口，参数解析、帮助文档、退出码和业务调用应保持单一接线路径。

## 领域约束

- 每个命令只通过 `await this.parse(Command)` 做一次 typed parse，不保留 legacy parser 或再次透传原始 argv。
- help 语言由 `resolveLang(process.argv)` 解析；`oclif/i18n.ts` 服务静态 help，`lib/i18n.ts` 服务运行期文案，两者不要合并。
- oclif 的 description／flags／args／examples 是 CLI 文档单一来源。修改后运行 `yarn build && yarn build:docs`。
- 业务测试优先使用 `test/helpers/run-command.ts`；只有真实 dispatcher、模块加载或独立进程边界才使用 `execFile`。

## Code Review Rules

- 必须拦截二次参数解析、公共退出码漂移或 stdout／stderr 契约混乱。安全路径：沿 oclif 单一路径实现，并保持成功为 `0`、业务失败为 `1`、参数校验失败为 `2`。
- 必须拦截把用户输入拼进 oclif description／flag／arg 文案，因为 help 会经 EJS 渲染。安全路径：静态 description 使用 `bilingual`，模板表达式只用于受控的 `examples[].command`。
- 必须拦截命令行为、双语 help 和生成文档之间的漂移。安全路径：补命令级接线测试，重建文档，并在行为依赖真实进程时运行隔离的生产入口验收。
