# Codex 父子任务 observe 案例

[English](./README.md)

这个可执行案例把两条脱敏后的 Codex Desktop rollout 交给 `omk observe`：

- 父任务加载 `repo-review` skill，并发生一次搜索失败；
- `review` 子任务共享同一逻辑会话，加载相同 skill，并完成 parser 检查。

事件结构取自真实 Codex 父任务与 reviewer 子任务协议。会话 ID、路径、命令和业务文本均已替换，fixture 不包含凭证或私有仓库数据。

## 使用已发布版本复现

在仓库根目录运行：

```bash
npm exec --yes --package=oh-my-knowledge@latest -- \
  node examples/codex-observe-router/verify.mjs
```

npm 下载发布包后，验证过程完全在本地确定性执行，不调用模型。

## 使用本地源码复现

先构建，再让 verifier 使用本地 CLI：

```bash
yarn build
OMK_BIN="$PWD/dist/cli/index.js" \
OMK_PACKAGE_ROOT="$PWD" \
node examples/codex-observe-router/verify.mjs
```

设置 `OMK_KEEP_OUTPUT=1` 可保留生成的报告目录，供人工检查。

## 验证内容

任一条件不成立，脚本都会以非零状态退出：

- 两个物理 rollout 文件被还原为一个逻辑会话；
- 数据源保持为 `codex`；
- 父子关系形成一条外部子任务边；
- 图中每个被引用的端点都存在；
- router 获得下游完成证据；
- 搜索失败生成一个 `failed_search` inbox 信号；
- 紧凑落盘的报告回读后不丢失 Trace IR 图。

## 证据边界

这是协议与持久化案例，不是质量 benchmark，也不表示已经覆盖 Codex 历史上的所有 rollout 变体。`@latest` 用于验证当前发布版 CLI；需要复现历史结果时，应显式固定当时的 package 版本。
