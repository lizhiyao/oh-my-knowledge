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

完整 system 加模型 input 另有 1 MiB 上限，富化后的清单、来源和正文不能静默截断。默认流程使用 journal Schema 4、`knowledge-body-first/v4` 及 `knowledge-source-generation-input/v2`，先盘点完整获准来源，再生成正文、查漏并等待实际决定。关联阶段为保持 prompt7／profile／wire3 的原字节，仍使用自己的 `knowledge-source-generation-input/v1` envelope；它不是 journal 的默认输入版本。可携带材料／归因与所有已交付单元保持显式，原始 envelope、捕获时间、绝对根与 cwd 不进入模型输入。

`prepare-generation` 零模型准备首阶段；核对完整 system、input、模型、producer proof 和 requestDigest 后，`generate --confirm-request` 只发送来源盘点。每个后续阶段单独核对并以 `continue-stage` 确认。覆盖完成后，实际 Agent／人须记录绑定精确清单、覆盖、正文和完整来源的决定；关联准备及 claim 前重验，不能以 capture、摘要确认或模型 all-covered 代替。重建同样要求精确决定，不能只从正文引文推断完整来源。普通宿主继续只移除已观测为逐工具调用变化的 CODEX_TOOL_CALL_ID，proof 与执行环境一致；其它环境值及历史冻结身份保持。

`knowledge-source-set/v1` 对精确 SourceRef 排序去重。默认 UUIDv8 用 `knowledge-source-set-import-run/v2` 绑定 workflow4 和来源集合摘要，避免与旧完成／未知 run 碰撞；同一默认导入复用日志，不重复正文或派发。显式新 run 只用于有意独立生成，不能绕过 unknown claim。恢复零模型，只接回当前匹配原件、重放固定写入；旧 journal3 由匹配旧构建处理。

## 变化与删除 {#updates}

`source-updates` 通过可信宿主绑定核对精确已捕获来源，报告当前状态、选中字节变化、已知受影响的正文／目录／投影精确修订及清单完整性。默认 Git 核对原固定对象；刷新分支需要显式 `replacementSelection`。不同路径仅是待核对的可能移动，不形成身份归并。

报告只给比较和复核建议，不调用模型、不修订知识。上游改变或删除后，历史捕获证据仍可读。显式 `delete-source` 删除普通捕获正文，留下无内容标记；不删除上游材料、正文中的引文或历史 outcome。默认拒绝重新导入该已删除版本；显式 `afterDeletion:"new_snapshot"` 预览创建新引用，不复活旧引用。

## 独立副本迁移 {#migration}

旧 `sourcePath`、`origin.cwd` 和捕获时间完整保留在 `migration/<migrationId>/original/sources/` 归档中。新快照沿用可移植来源规则，只保留轨迹的 threadId／turnId／title，省略宿主路径并记录新的捕获时间；迁移计划明确列出这一边界，不把旧捕获时间当作新快照的时间。

**BREAKING-SCHEMA/API/COMPARABILITY：** Source3、中立 DTO、当时的 journal／workflow3 和来源感知 profile 替换旧来源入口。当前写入口拒绝旧来源／日志格式。保留原工作区与匹配构建，不原地升级。

`migrate-sources --plan-only` 读取明确旧工作区及匹配构建归档，零写入导出固定计划；通过 `--input` 和精确 `--confirm-plan` 摘要应用到独立新目标。迁移归档保留所有旧字节、journal／outcome、复核、授权、知识库／载体引用及提供的构建。构建标记和摘要不证明兼容性，须单独验证匹配构建与回退。新来源引用、正文修订／摘要和派生目录／投影均显式映射、重新 pending；不继承旧保留、身份接受、复核、使用反馈或自动授权，普通组织标签另行保留。

预检在创建目标前核对源／目标身份、容量及完整恢复记录。固定迁移计划文档最多 128 MiB（含 CLI 换行），导出、adapter 接纳与 CLI reader 使用同一容量。已归属的中断迁移复用同一计划恢复，未完成目标不能当普通工作区打开。包括已打开实例在内，普通写入均在共享工作区锁内重验此边界；迁移仅在同步应用期间持有绑定计划的显式临时写入能力。已完成输出被改删时不悄悄复活。启动阶段所有者不明的锁保持拒绝，须明确核实所有者。回退使用未改动的旧工作区与匹配构建，不依靠兼容 reader。周边契约见[存储布局](../shared/storage-layout-spec.md#explicit-knowledge-workspace)。

`migrate-workflow` 是独立的 workflow3→4 复制入口，不改 Source3 摘要算法。仅支持健康的 sources3、items3、entities2、associations2、reviews1 和 tags 六类活动数据，保留所有字节、身份、历史和既有意见；这些意见不变成新的来源覆盖批准。旧 generation-journals（含 outcomes）、auto-extraction、既有 migration 和旧 marker 只归档，匹配旧包一并保留。包含 library、carriers、entity-links 或其它不受支持内容时须保留旧目录并报告 unsupported，不静默丢弃或改指向；并非所有历史工作区都可用此入口。

计划绑定实际源／目标、完整 inventory／摘要、实际 actor、旧包及容量。`--plan-only` 零写入；应用只认固定 `--input` 和精确 `--confirm-plan`，在双锁及完成哨兵下复制，未知临时文件安全停止。只恢复同计划的已确认步骤／回执；完成后目标增改删均拒绝覆盖，unknown 旧调用不重发。回退用旧目录及匹配构建。
