# 已发布的 JSON Schema

> English source: [Published JSON Schemas](./README.md). This file is maintained section by section against it; the English version is authoritative.

本目录是 OMK 公开 JSON Schema 的签入式 catalog。
这些文件由运行期契约定义生成，并随 npm package 一起发布；
不要手工修改任何 schema 文件。

## 目录结构

- `eval-core/v1/` 与 `eval-core/v2/` 存放带版本的 Evaluation Core wire 契约。
- `eval-samples/v2/` 存放 JSON 与 YAML 用例文件唯一受支持的
  Eval Sample Set 契约。预览期的 sample schema 已直接移除，
  不再作为 reader 或 package export 保留。
- Evaluation Core 契约版本是其公开 identity 的一部分。新的 Core
  版本不会替换或修改旧文件；冻结的 Core 版本仍然可用，
  用于解析历史 identity。

当前 Evaluation Core catalog 共有 21 个根契约名称。
Analysis Bundle、Comparability Assessment、Evaluation Report 与
Series Analysis Bundle 使用 v2；其余 17 个当前契约使用 v1。四个已升级契约的
v1 快照仍然保留，但当前 runtime 不会选用它们。

## 消费方访问

Node.js 消费方应通过公开 package API 解析当前的
Evaluation Core schema，而不是自行拼接路径：

```ts
import { resolveEvaluationCoreJsonSchema } from 'oh-my-knowledge/eval-core';

const schemaUrl = resolveEvaluationCoreJsonSchema('evaluation-report.schema.json');
```

当某个工具有意面向冻结的契约时，可以直接使用
带版本锁定的 package 路径：

```text
oh-my-knowledge/eval-core/schemas/v1/<file>.schema.json
oh-my-knowledge/eval-core/schemas/v2/<file>.schema.json
```

## 维护者工作流

在一次有意的契约改动之后运行 `yarn build:schemas`，
并提交生成的 diff。`yarn schemas:check` 校验 catalog 与源定义一致，
并拒绝过期、缺失或多余的 schema 文件。在接受任何生成改动之前，
先审查 schema identity、迁移与测量可比性。
