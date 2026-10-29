# OMK 存储布局 v2

> **范围：**项目级与机器级存储的正式契约。所有路径由 `src/evidence/storage/layout.ts` 统一生成，业务模块不得自行拼项目根 `.omk`。本次只改变存储位置，不改变报告 schema、评分语义、prompt、统计公式或长度去偏。

## 设计原则

- 顶层名称跟用户看得见的产品域一致：`eval`、`doctor`、`observe`。
- 每份持久测量记录独占一个自包含目录。`report.json` 是权威数据，可重建视图放进 `derived/`。
- 路径直接表达生命周期。持久证据、observation、治理、备份与可重建 `state` 不再平铺混放。
- 绑项目的证据默认写入 `<project>/.omk`。机器工具、缓存、隧道、物化树和跨项目索引只能进入全局 `state/`。
- 记录身份来自报告 ID 与内容 digest，不依赖绝对路径；搬迁不会改变报告 JSON 或 digest。

## 项目级布局

```text
.omk/
├── .gitignore
├── eval/
│   └── <record-id>/
│       ├── manifest.json
│       ├── report.json
│       └── derived/
│           ├── graph.json
│           └── card.md
├── doctor/
│   └── <record-id>/
│       ├── manifest.json
│       ├── report.json
│       └── derived/
│           ├── graph.json
│           └── card.md
├── observe/
│   ├── health/
│   │   └── <record-id>/
│   │       ├── manifest.json
│   │       └── report.json
│   ├── inbox/
│   │   ├── reports/
│   │   ├── captures/
│   │   └── review-state.json
│   ├── drafts/
│   └── archive/
│       └── source-records/
├── backups/
│   └── doctor-fix/
└── state/
    ├── jobs/
    ├── locks/
    └── tmp/
```

`<record-id>` 是一份报告 bundle 的防碰撞文件系统身份；manifest 保存公开的 report／run 身份。Evaluation Core bundle 还会把封存的 plan、execution、evaluation、analysis 文档跟 `report.json` 放在同一目录，这些文档仍属于经过认证的 bundle。

目录 skill 的 authoring 约定 `<skill>/.omk/eval-samples.{json,yaml}` 本期明确不变。

## 机器级布局

`OMK_HOME` 默认是 `~/.oh-my-knowledge`，并整体重定向这棵树：

```text
~/.oh-my-knowledge/
├── eval/
├── doctor/
├── observe/
├── backups/
└── state/
    ├── cache/
    ├── tools/
    ├── tunnels/
    ├── trees/
    ├── isolated-cwd/
    │   └── resolved-inputs/
    │       └── content/
    ├── artifact-index/
    ├── jobs/
    ├── locks/
    └── tmp/
        └── resource-leases/
```

项目与机器的持久数据使用同一套领域结构。机器专属内容不得进入项目 `.omk`。resolver 持有的输入副本写入 `state/isolated-cwd/resolved-inputs/`；run-scoped resource 副本与 overlay 写入 `state/tmp/resource-leases/`，并在 lease 结束时删除。Codex、Claude、DSH 的原始 trace 继续留在来源位置；OMK 默认只读分析，不复制进项目。

## 生命周期与 Git 策略

| 路径 | 语义 | 默认删除？ | 项目 Git 策略 |
|---|---|---:|---|
| `eval/` | A/B 评测证据与发布判断 | 否 | 忽略 |
| `doctor/` | skill 体检报告 | 否 | 忽略 |
| `observe/health/` | 从真实 trace 聚合的健康度 | 否 | 忽略 |
| `observe/inbox/` | 待复核 observation 与人工状态 | 否 | 忽略，可能含敏感信息 |
| `observe/drafts/` | 从 observation 生成的样本草稿 | 否 | 忽略 |
| `observe/archive/` | inbox 报告引用的不可变原始记录归档 | 否 | 忽略，可能含敏感信息 |
| `backups/` | 自动修改前的恢复副本 | 否 | 忽略 |
| `state/` | 任务、锁、临时文件及全局可重建缓存 | 是 | 忽略 |

`omk init` 会写内部 `.omk/.gitignore`，忽略 `eval/`、`doctor/`、`observe/`、`backups/` 和 `state/`，但不忽略 `.gitignore`。

## 兼容边界

文件锁只恢复已证明退出的本机旧持有者。空白或损坏的 owner 元数据可能属于刚完成排他创建、随后暂停的活进程；OMK 会保留锁并报告竞争。只有确认已无 writer 后，才手动清理 owner 不明的孤儿锁。

JSON 排他发布要求同目录硬链接能力，替换要求原子 rename。不具备这些能力的文件系统（包括部分移动盘或网络文件系统）会明确失败并清理暂存文件，不会回退到发布部分字节。尚未在物理 exFAT 或 NAS 设备上验证此能力边界。

v2 是唯一受支持的 `.omk` 项目运行布局。OMK 不读取旧 `.omk` 存储根，不提供针对这棵目录的迁移命令，也不会自动搬动或删除旧数据。已有旧 `.omk` 数据保持原样，但不会被 v2 读侧发现；用户可以先备份，再显式删除。Evaluation Core bundle 只支持 manifest v2 与 `report.json`。下面由用户明确选择的知识工作区使用独立的当前版本契约。

## 明确选择的知识工作区 {#explicit-knowledge-workspace}

工作区由设置或 `--workspace` 显式选择，独立于项目 `.omk`。当前格式为：

| 路径 | 当前契约 |
|---|---|
| `items/<identity-digest>.json` | `knowledge-item-history` Schema 3：不可变正文修订、inline evidence、`bodyDigest`、维护及收据 |
| `associations/<identity-digest>.json` | `knowledge-association-history` Schema 2：精确正文／目录引用、段落／实体关联、可选 typed 关系、待审投影及独立审查账本 |
| `entities/<analysis-id>.json` | `entity-analysis-history` Schema 2：窗口实体、提及与不可变修订 |
| `generation-journals/<run-id>.json` | `knowledge-generation-journal` Schema 2、流程 `knowledge-body-first/v2`：来源／请求／profile／wire／producer 身份、原件引用与固定写入意图 |
| `generation-journals/outcomes/<run-id>/<invocation-id>.json` | 不可变正文或关联原生完整返回，分别绑定请求与摘要 |
| `library/<object-id>.json` | 既有 `knowledge-library-object-history` Schema 1，明确确认的跨窗组织 |
| `entity-links/<review-id>.json` | 既有 `entity-link-invocation-history` Schema 1，独立跨窗建议／决定／应用日志 |

来源、标签和载体版本各有契约。读取已存正文不以实体目录或投影成功为前提。投影绑定 `{knowledgeId, revisionId, bodyDigest}`，修改／重建／审查投影不改正文、不继承正文 retain。损坏／过期／被拒投影明确显示。

Generate 先归档正文原件、把接纳正文保存待审，再尝试关联。每个原生阶段派发前 claim、接纳前归档；宿主组合不冒充原生原件。`resume` 只挂接原证据并重放精确写入意图／收据。已 claim 而无原件的阶段保持未知，禁止自动重发；从未 claim 的关联可显式继续，完全相同的 completed 运行重放零调用。流程完成不证明关联成功、来源保真或真值。

**BREAKING-SCHEMA/API/COMPARABILITY：**当前正文 reader 拒绝 typed 知识 Schema 2，当前日志恢复拒绝 run5；旧 `extraction-runs/` 清单明确 unsupported，原文件不动。[显式迁入独立新工作区](../knowledge/knowledge-domain-model.md#body-migration)把所有原字节保存在 `migration/<migrationId>/original/<relative-path>.base64`，保留原字节摘要、固定 `plan.json`、精确修订／段落映射与 `complete.json`。复制支持的 source／entity 记录，机械渲染的新正文待审、不隐式保留。Library／carrier／既有跨窗引用只归档、不改指向。旧目录与匹配旧 binary 用于回退，不提供永久双 canonical reader，也不虚构迁移 CLI。

新增 `migrate-associations` 显式迁移关联 Schema 1：要求两个独立路径与稳定 `--operation-id`，保留正文、retention、source、entity 与原生结果字节；旧关联原件／回执归档，新投影待审并记录修订映射。旧 journal 1 保留原身份、明确 unsupported；`auto-extraction/` 只归档，不继承权限。完成后重放只核对并确认持久性，后续删除或修改拒绝重放，不复活资料。

自动提炼使用许可 Schema 2 与 `conversation-phase-invocations/v2`。`auto-extraction/<thread-hash>.json` 保存可变状态；不可变 `permission-<id>.json`、`schedule-<permission-id>-<run-id>.json`、`phase-<permission-id>-<invocation-id>.json`、`outcome-<permission-id>-<invocation-id>.json` 分别绑定同意、来源窗口计划、各付费阶段预约与观测 cooldown。正文／关联分别消耗一次调用；关联前因额度／过期拒绝时保留已存正文。旧 Schema 或旧 workflow 许可明确不支持；须迁入独立新工作区后重新批准，不在原目录升级授权。读取与恢复不派发。

所有写入共享 `.knowledge-write.lock` 及适用的 CAS／幂等收据；争用报告 `knowledge_workspace_busy`，只恢复证实本机退出的 owner，拒绝存储目录软链。可调的检索默认 65536 UTF-8 字节计算整个响应及换行，不是存储、正文、模型上下文或金额上限；producer 与 store 容量仍分别显式检查。运行身份来自[生成契约](../../reference/shared/knowledge-contract.md)；历史 typed study 核对／重放保留冻结身份与结论，当前构建零调用拒绝旧 typed 生成计划。工作区记录可能包含私有来源与输出。

## 为什么这样命名

不设顶层 `runs`：它容易被理解成可随时删除的执行状态，而 eval 与 doctor 是持久证据。不设顶层 `measurements`：它会遮住用户已经熟悉的 CLI 产品域。不设顶层 `observations`：健康报告与待复核 observation 是共同 `observe` 域下的兄弟管线。选择 `derived` 而不是 `projections`，因为其中内容是由一份权威报告派生、可重建的物化结果，不是独立产品域。

## 相关文档

- [OMK 为谁而做](../../explanation/who-omk-is-for.md)
- [术语规范](./terminology-spec.md)
