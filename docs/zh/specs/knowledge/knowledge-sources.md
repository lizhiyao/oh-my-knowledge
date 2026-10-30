# 项目与轨迹来源的版本契约

本契约属于显式知识工作区，支持选定的 UTF-8 文件、固定本地 Git blob 和 Agent 原始轨迹记录。不自动扫描全仓、拉取远端 Git 对象或确认跨来源身份。

## 身份与证据 {#identity}

`sources/<snapshot-id>.json` 使用 `knowledge-source-snapshot` Schema 3 与 `knowledge-window-v3` 投影。`SourceRef` 必须同时包含 `snapshotId`、`sourceVersion`。可用解析返回 `snapshot`；不可用解析区分缺失、删除、损坏、版本不符、权限不足和不支持。当前 reader 不解码 Source2。Studio 正文／实体响应使用不含原始 envelope 的独立来源视图；明确读取来源和预览时可返回完整原件，不伪造空 raw units。

| 来源类型 | 固定身份与选区 |
|---|---|
| `agent_trace` | 可信逻辑来源 ID、轨迹格式和原始非空记录范围；保留精确原记录与投影事件 |
| `project_file` | 可信项目 ID、相对路径和所选行范围；绑定当前文件的精确内容摘要 |
| `git_blob` | 项目／路径、哈希算法、commit／tree／blob OID 与所选行范围；分支／标签在捕获前解析 |

行范围从 1 开始、两端包含；记录范围从 0 开始、两端包含。字节坐标从 0 开始，引文偏移是单个片段内的 UTF-16 位置。范围先排序、去重，再合并重叠或相邻项；不连续选区保持独立单元，不插入虚构分隔符。显式选择整个空文件时，行与片段数量均为 0。

来源版本绑定精确材料、坐标、归因、轨迹原始身份／标题及投影规则，不以随机捕获 ID／时间或宿主绝对根路径决定版本。项目显示名不能替换轨迹原始标题。原始轨迹字节保存在 raw units；投影事件时间遵循轨迹 parser 的解释，不是独立事实时间。

材料归因区分设计、实现、配置、测试预期、执行记录、讨论和未知，同时显示声明及其依据。读取测试源码不等于执行测试；来源报告的执行记录也不证明其结论真实。文件时间、Git author／committer 时间、消息时间与捕获时间不能互换。

## 选择、预览与捕获 {#capture}

可信宿主通过 `knowledge-source-scope/v1` 配置有限根目录及轨迹绑定。浏览器和模型只选择逻辑 ID、相对路径，不能授予新根目录权限。启动 scope 变化需要重新预览。CLI 使用 `--scope`，Studio 使用 `--source-scope` 接收同一宿主配置。

宿主 scope 文件示例：

```json
{
  "scopeVersion": "knowledge-source-scope/v1",
  "projects": [{ "projectId": "omk", "root": "/absolute/project" }],
  "traces": []
}
```

选区文件明确列出路径与范围：

```json
{
  "selections": [
    { "sourceKind": "project_file", "projectId": "omk", "relativePath": "PRODUCT.md", "lineRanges": [{ "startLine": 1, "endLine": 20 }] },
    { "sourceKind": "git_blob", "projectId": "omk", "relativePath": "PRODUCT.md", "revision": "HEAD", "lineRanges": [{ "startLine": 1, "endLine": 20 }] }
  ]
}
```

`preview-sources --input selections.json --scope scope.json --json` 有界读取材料，返回选中文字原文及独立的实际读取、拟发送与保存清单，不写正式快照、不调用模型。捕获消费该导出预览，重建固定选区并核对稳定摘要及可信 scope 后才保存；分支变化不能悄悄替换预览已固定的 Git 对象。捕获不授权发送模型。

reader 为定位选区可能读取整个文件或扫描轨迹前缀，读取清单如实说明；只保留选定单元。单次内容读取上限为 16 MiB；一次预览最多 256 个来源、64 MiB 实际读取、4 MiB 选中原文，投影／预览 JSON 另有容量限制。来源存储最多 4,096 个文件、合计 64 MiB、单文件 16 MiB。超限拒绝，不截断。

轨迹按原始记录选取。所选消息所在记录可能同时包含工具事件，完整记录的所有可读片段均列入预览与发送范围；未选择的独立记录、项目文件和附件原件不自动纳入。不支持的二进制、非法 UTF-8 及越过可信根目录的路径明确拒绝。

## 发送与默认导入身份 {#generation}

完整 system 加模型 input 另有 1 MiB 上限，来源预览通过不证明请求一定可接纳。来源感知生成使用 journal Schema 3、`knowledge-body-first/v3` 工作流及 `knowledge-source-generation-input/v1` 输入。模型收到有序 `sources:[{sourceKey,source,excerpts,limitations}]`，含可携带的材料／归因元数据；原始 envelope、捕获时间、绝对根路径与 cwd 不进入该输入。当前 prompt／profile 身份见生成契约，输出 wire 版本保持独立。

`prepare-generation` 零模型创建 prepared 日志。核对完整 system、input、目标模型、producer proof 和 `requestDigest` 后，`generate --confirm-request <digest>` 只发送该精确正文请求，保存的正文为 pending。关联基于已保存的精确正文另行准备，需要自己的 `continue-stage --confirm-request <digest>` 决定。关联重建同样先准备再发送；不能保留摘要却替换模型或 producer。普通 CLI／Studio 宿主显式版本化环境策略：按键排序，只移除已观测为逐工具调用变化的 `CODEX_TOOL_CALL_ID`，proof 与实际执行使用同一组结果值；其余环境值（含 PATH、凭据）继续核对，历史研究保留自己的冻结环境。

`knowledge-source-set/v1` 对精确 SourceRef 排序、去重。默认导入以 `knowledge-source-set-import-run/v1` 从来源集合摘要派生 UUIDv8，复用已有日志，包括失败和未知结果。有意重新生成须明确提供新的 run UUID。已完成集合的默认重复导入不增加模型调用或重复正文；已 claim 的未知阶段不能重发，恢复只接回原件和重放固定写入。独立历史研究保留原 Source2／corpus 身份并使用匹配的工作区／构建。

## 变化与删除 {#updates}

`source-updates` 通过可信宿主绑定核对精确已捕获来源，报告当前状态、选中字节变化、已知受影响的正文／目录／投影精确修订及清单完整性。默认 Git 核对原固定对象；刷新分支需要显式 `replacementSelection`。不同路径仅是待核对的可能移动，不形成身份归并。

报告只给比较和复核建议，不调用模型、不修订知识。上游改变或删除后，历史捕获证据仍可读。显式 `delete-source` 删除普通捕获正文，留下无内容标记；不删除上游材料、正文中的引文或历史 outcome。默认拒绝重新导入该已删除版本；显式 `afterDeletion:"new_snapshot"` 预览创建新引用，不复活旧引用。

## 独立副本迁移 {#migration}

旧 `sourcePath`、`origin.cwd` 和捕获时间完整保留在 `migration/<migrationId>/original/sources/` 归档中。新快照沿用可移植来源规则，只保留轨迹的 threadId／turnId／title，省略宿主路径并记录新的捕获时间；迁移计划明确列出这一边界，不把旧捕获时间当作新快照的时间。

**BREAKING-SCHEMA/API/COMPARABILITY：** Source3、中立 DTO、journal／workflow3 和来源感知 profile 替换旧来源入口。当前写入口拒绝旧来源／日志格式。保留原工作区与匹配构建，不原地升级。

`migrate-sources --plan-only` 读取明确旧工作区及匹配构建归档，零写入导出固定计划；通过 `--input` 和精确 `--confirm-plan` 摘要应用到独立新目标。迁移归档保留所有旧字节、journal／outcome、复核、授权、知识库／载体引用及提供的构建。构建标记和摘要不证明兼容性，须单独验证匹配构建与回退。新来源引用、正文修订／摘要和派生目录／投影均显式映射、重新 pending；不继承旧保留、身份接受、复核、使用反馈或自动授权，普通组织标签另行保留。

预检在创建目标前核对源／目标身份、容量及完整恢复记录。固定迁移计划文档最多 128 MiB（含 CLI 换行），导出、adapter 接纳与 CLI reader 使用同一容量。已归属的中断迁移复用同一计划恢复，未完成目标不能当普通工作区打开。包括已打开实例在内，普通写入均在共享工作区锁内重验此边界；迁移仅在同步应用期间持有绑定计划的显式临时写入能力。已完成输出被改删时不悄悄复活。启动阶段所有者不明的锁保持拒绝，须明确核实所有者。回退使用未改动的旧工作区与匹配构建，不依靠兼容 reader。周边契约见[存储布局](../shared/storage-layout-spec.md#explicit-knowledge-workspace)。
