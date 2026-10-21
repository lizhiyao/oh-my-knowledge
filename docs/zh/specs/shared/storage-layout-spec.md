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

## 明确选择的知识工作区

用户通过设置或 `--workspace` 选择知识工作区，与上面的项目运行目录分开。`items/<identity-digest>.json` 使用 `knowledge-item-history` v2；`entities/<analysis-id>.json` 使用 `entity-analysis-history` v2，保存不可变修订、精确来源绑定与写入回执。`extraction-runs/<run-id>.json` 使用 `knowledge-extraction-run` v5，保存每次 invocation 的 system／input 摘要与来源绑定、接纳事实及稳定写入意图。完整执行器返回 JSON 结果以不可变 sidecar 保存在 `extraction-runs/outcomes/<run-id>/<attempt-id>.json`，通过身份与摘要引用；失败／refusal 原文和用量标志均保留。`library/<object-id>.json` 使用 `knowledge-library-object-history` v1，保存已确认的跨窗口来源关联与组织历史，不复制知识正文，详见[知识库契约](../knowledge/knowledge-library.md)。来源、主题标签及载体版本沿用各自契约。`entity-links/<review-id>.json` 独立使用 `entity-link-invocation-history` v1，保存已确认请求与调用生命周期、完整执行器返回结果及失败证据、不可变人工决定及可恢复的 library intent/receipt；见[跨窗口复核日志](../entities/entity-links.md)。

人工运行封存属于独立版本的处置，不是旧 reader 或迁移。`extraction-runs/seals/<current|legacy>/<run-id>/intent.json` 使用 `knowledge-extraction-seal-intent` v1，绑定声明的操作／actor／理由、原 manifest 字节 SHA-256 及精确 sidecar 原字节清单；`evidence/manifest.json` 与 `evidence/outcomes/<attempt-id>.json` 保留未经规范化的字节序列。intent／副本先获耐久确认，再在 `.knowledge-write.lock` 内最终核对身份并将 `knowledge-extraction-seal-marker` v1 原子发布到原 manifest 路径，原路径持续占位。pending intent 不算 sealed，未知确认保留磁盘事实并要求完全相同操作重入；执行／恢复拒绝 pending／sealed 记录，manifest 投影仍披露 pending 处置。显式 `sealed-runs` 查询与质量 v4 显示人工处置／执行状态未知，清单不重新认证 native 完整性或耐久性。准入、offline 声明、容量及旧进程限制见[当前实体存储契约](../entities/entity-extraction.md#_6-当前存储契约)。不自动解封、调用、退款、重判历史或迁移用户数据。

新的自动提炼 permission 可在既有 Schema v1 中记录显式生成政策与 `conversation-invocations/v1` ledger 身份。不可变 `auto-extraction/attempt-<permission-id>-<attempt-id>.json` 回执绑定 permission／run／attempt／request 身份及 token 预约，派发前独占发布并 fsync；可变次数／token 计数按 ledger 核对恢复，不退款。未发布的原子暂存文件不算回执。每份已发布 invocation 可对应一份不可变处理事实 `auto-extraction/cooldowns/<thread-digest>-<run-id>-<attempt-id>.json`，绑定 permission／run／attempt／request／source／policy 身份及原生 outcome 引用，记录 no-cooldown、required 或 invalid；该目录受 invocation 回执数量及 3000 条上限约束。归档后 hook 在退避前记录首次观测截止时间；status、enable 和派发从原归档补齐缺失事实，回执丢失后不延长已有事实的时间。已知合法等待跨权限生效，非法值只停止原权限，不永久封锁新的明确授权。状态持久派生冷却截止时间，本地调度和实际派发均须遵守。迟到结果只发布原调用事实，不改写其他 owner，由新 owner 的 gate 核对已知等待。持久预约后再次检查取消及到期；fsync 期间跨越截止时间会阻止执行，但不退款。上限在同一 24 小时 grant 内跨窗口累计。无 policy 的既有权限仍仅有单调用授权，不因新默认值而扩大。

来源归档／删除、run metadata／outcome、实体与知识历史、主题标签、知识库关联、自动提炼状态及载体发布共用 `.knowledge-write.lock`。载体的最终选择校验与发布持续持有该边界；完整生成树在发布前通过容量检查，失败暂存内容被清理。锁等待失败报告 `knowledge_workspace_busy`。只恢复已证明退出的本机 owner，拒绝存储目录的软链跳转。文件 Schema 版本与 prompt／wire／pipeline 来源身份分开：领域响应 v4 保持不变，配置后的 strict 生成使用无 few-shot prompt v15，作者 prompt-json 端口保留原 v14；历史 prompt-json 与新 strict 身份不共用质量结论。读取或幂等恢复受支持的运行保留原始证据，不发送模型或升级结果，边界见[当前实体存储契约](../entities/entity-extraction.md#_6-当前存储契约)。

原 `runs/` v4 文件不按受支持运行读取，不迁移或删除；仅显式 opaque 人工封存会保留其原字节并将原路径替换为上述独立 marker；v5 reader 中旧运行详情、resume、对话／项目批次和质量统计不可用。同一工作区内现行来源快照、实体历史 v2、知识历史 v2 和已有绑定仍可读取，不要求替换为空工作区。实体历史 v1 和不支持的运行格式仍被拒绝，不添加兼容 reader。新提炼的实体不会自动接管旧知识绑定。存储文件可能含私有片段，属于用户本地数据，不是仓库源码资产。

## 为什么这样命名

不设顶层 `runs`：它容易被理解成可随时删除的执行状态，而 eval 与 doctor 是持久证据。不设顶层 `measurements`：它会遮住用户已经熟悉的 CLI 产品域。不设顶层 `observations`：健康报告与待复核 observation 是共同 `observe` 域下的兄弟管线。选择 `derived` 而不是 `projections`，因为其中内容是由一份权威报告派生、可重建的物化结果，不是独立产品域。

## 相关文档

- [OMK 为谁而做](../../explanation/who-omk-is-for.md)
- [术语规范](./terminology-spec.md)
