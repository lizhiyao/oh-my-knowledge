# Artifacts 领域规则

本文件补充仓库根与 `src/knowledge/AGENTS.md`，适用于 `src/knowledge/artifacts/`。本子域不属于纯核心，其来源物化、文件写入和模型辅助工具遵守各自副作用边界。本域拥有**可评测载体**（Artifact：skill／prompt／agent／workflow）的完整生命周期：来源解析与物化（`sources/`）、生产与迭代（`authoring/`）、格式契约（`skills/`）、健康审计（`doctor/`）。

## 命名说明

- 路径为 `knowledge/artifacts`：外层 `knowledge` 提供知识载体语义，`artifacts` 是伞内子域名。`src/artifacts` 是被 #613 废弃的旧顶层名，与「评测产物（measurement artifacts）」有歧义，不恢复该路径；原顶层 `src/knowledge-artifacts` 也不保留兼容入口。`test/architecture/src-root-layout.test.ts` 维护目录地图与退役路径约束。
- 载体库（`authoring/carrier-library.ts` 的 `CarrierLibrary`）与 `src/knowledge/library/`（实体跨窗组织库）是两个领域概念，命名不得再混用。

## 领域不变量

- `contracts.ts` 的 `Artifact.kind` 是 eval 测量对象的身份载体；裸 `kind` 字段按术语规范 §5.4 保留给它，域内新判别字段使用限定名（如 `sourceKind`）。
- `sources/` 的来源物化与部署：内容寻址指纹、拒绝 symlink 越界、原子发布（staging + rename）；命令注入面（git 调用）必须走 `execFile` 加 `--` 隔断。
- `authoring/` 组织已复核知识生成载体时不新增模型调用（core-evolver 的显式迭代除外）；写回用户源文件必须原子（`writeTextFileAtomic`），演进快照保留在 `evolve/`。
- `doctor/` 是载体健康审计：规则注册、报告 Schema 版本化、修复按 skill 分文件执行；评估报告与卡片属派生视图，不覆盖原始证据。

## Code Review Rules

- 必须拦截把测量产物（`.omk/eval` 输出）放进本域：本域只有载体侧契约与工具。
- 必须拦截破坏来源物化原子性、路径防护或命令注入防护的改动。
- 必须拦截 `Artifact.kind` 语义的静默扩展（新载体类型需显式版本化并同步术语规范）。
