---
description: 历史 v14 真实开发窗口的纯元数据登记与零请求回放。
---

# 历史 v14 真实窗口基线

## 范围与来源

[Issue #1127](https://github.com/lizhiyao/oh-my-knowledge/issues/1127) 记录了 2026-10-12 获授权的一次 Codex 调用：请求模型为 `gpt-6.1-sol`，使用原始 `knowledge-extraction-v14`、响应 Schema v4 和 prompt-only JSON。它是已查看的真实软件工作开发窗口，不是留出或代表性样本。后续作者复核由 Codex 完成；独立人工复核未执行，`goldReady=false` 保持。

元数据登记位于 `scripts/bench/assets/entity-extraction-real-v14-baseline-v1/manifest.json`，绑定明确列出的 18 份原件，不发布其正文。它是 benchmark 元数据资产，不是新的生产存储格式、当前 collector capture 或 grant。本次 replay 只验证列出的 18 文件子集。先前一次性核对的 7 份 capture、21 份准备文件及回执所列 11 份结果属于另一条证据；本命令不重验该完整集合或旧 sealed build。原测量身份为 `sha256:49723bd1c77f619a3b8384c5a344e6405c1ec50f4a093098f62997cb6397b218`。

| 原始证据 | 字节数 | SHA-256 |
| --- | ---: | --- |
| 输入 JSON 文件 | 4962 | `ccf08332531aebfadfc7051b6fe4229fd01c2107cc6aaf333d4f4b3ca80563a0` |
| 原始 UTF-8 prompt | 35784 | `e3acd05eca278b0e34f5d8b75767176c5ede7ce7fade561975eb1f4e4c417399` |
| 原始 UTF-8 助手输出 | 32951 | `115fb80e2f4ddabba8c894035c271c0b0c2003665b5ef59f0ecaee6b1434ceb2` |
| 返回执行器结果的序列化原件 | 72449 | `62bb1158cf876262e97e22aeb800e6b16de996e66dce48ce331ca6fd616fcab4` |

原始输出摘要计算的是 `capture/output.json.result.output` 的 UTF-8 字节，也与 `capture/runtime.json.output` 完全相同，不是外层 JSON 文件摘要。`output.json.result` 只有五字段投影，不是完整执行器结果。`runtime.json` 保留序列化的返回 `ExecResult`，包括实际返回的 trace 字段，不是 provider 原始 HTTP 响应或 CLI 原始传输。输入文件摘要只绑定该 JSON 文件字节，不声称完整 executor 任务字符串、Codex 包装／上下文、实际 system 指令或 provider 请求字节已被捕获。

## 保留在仓库外的内容

完整来源、输入、prompt、输出、runtime、旧授权及本地复核文件继续留在原外部目录，`--capture-dir` 指含 `capture/`、`results/` 和 `authorization.json` 的整个原 bundle 根，不是其中的 `capture/` 子目录，不读取所传目录的父级，必须显式提供。verifier 不搜索用户目录、不发现 capture、不读凭据、不导入旧脚本、不执行 `sealed-build`。元数据核验不代表原始 runtime 正文已获准公开。全文发布或脱敏派生物须另行决定数据范围；派生物保留原摘要并有独立身份。

元数据保留原输入四条限制的数量、JSON 数组摘要和以下非敏感总结：仅选定消息，省略工具／system／周边上下文，一致替换 URL／原生路径／不透明标识符，不确证历史说法为当前行为，且选外 24 条记录未解析，整体来源完整性未知。这些是证据范围，不是 verifier 指令。旧存储回放使用了新的包装／引用身份，该包装不是原模型请求。本 verifier 直接使用原冻结输入与输出，不以包装替换原件；在本机核对 input 与 disclosure 的原限制数组逐字相等，不输出数组原文。

## 零请求回放

使用已构建的检出和不含 loader、preload 或继承运行选项的干净 Node 进程。显式替换两个绝对路径；原目录位置已登记在上述 Issue。

```sh
env -i PATH=/usr/bin:/bin TMPDIR=/tmp \
  /absolute/path/to/node scripts/bench/assets/entity-extraction-real-v14-baseline-v1/verify.mjs \
  --capture-dir /absolute/external/frozen-bundle
```

可选 `--out /tmp/new-replay-report.json` 只创建一份新的私有报告，位置必须在检出和 capture 目录之外，不覆盖既有文件。默认只打印元数据：摘要、身份、计数及状态，不输出原文、实体 label、本地 capture 路径或原生解析错误。固定文件缺失、改动或为软链时，在生产导入前拒绝；Node 运行选项也会拒绝。网络／监听／子进程入口在确定性生产模块导入前已有拒绝守卫，其尝试数是实际观测；无执行器导入和凭据访问是源码范围声明，不是已计数的全局探针。

导入固定为仓库 `dist` 下字面量 decoder／domain／checker／prompt 路径。verifier 不构建、不 fetch、不 dispatch、不导入执行器、不运行旧 `.mjs`、不导入 `sealed-build`、不加载 benchmark corpus。每份原件最多读取固定长度加一个字节，先验证闭集文件、原始摘要、旧测量身份及已用完授权的绑定；原 transport 沿用 prompt-only 响应的 `JSON.parse` 与生产接纳路径。另行运行的 strict-wire decoder 仅作诊断，不补 null、不修复输出、不改变此 transport。

## 已观测结果与限制

2026-10-16 本地离线回放接纳 19 实体、19 提及、3 候选，包含 10 陈述、9 引文和 9 证据链接；实体／候选拒绝均为零，3 份 draft 均通过当前 domain Schema。verifier 内两次接纳得到相同摘要。fetch／socket／listen／HTTP／TLS／datagram／subprocess 尝试和新增模型 dispatch 均为零，原文件未改变。

较新的 strict-wire 诊断为 `decoded`／`item_failures`，18 个 item 未通过。保留这一格式诊断，不将其解释为历史 prompt-only 失败或 strict-wire 成功。如果当前结构计数或 domain 合法性与冻结历史不同，verifier 输出 `diagnostic_mismatch` 并退出 1，不修改历史预期来获得通过。当前 checker 抛错时仍保留新的 replay 身份，未知计数为 null，不输出原生错误。

每份新的离线验证身份绑定登记、verifier、原输入／输出摘要、当前 prompt／wire 身份、8 个编译组件、实际 Zod／Ajv 版本及 Node 二进制／版本。当前激活 prompt 的摘要／是否匹配只是观测元数据，不要求生产永远停在 v14。它独立于旧测量身份，不是完整传递依赖字节闭包。它证明完整性及确定性的结构／定位／引用回放，不证明语义准确率、稳定性、因果改善、独立复核或新生成成功。完整口径见[验收协议](./entity-extraction-evaluation.md)。

## 授权与对照

旧授权仅允许将该冻结四条脱敏消息及 v14／Schema v4 发送给 Codex `gpt-6.1-sol`，最多一次且无自动重试。额度已使用并关闭，剩余零次，不授权新增 dispatch、新实验或原文公开。一次 OMK invocation 和返回的 turn 数不能证明内部 provider 请求数或计费调用数。

`gpt-6.1-sol` 是请求模型，不是 provider 证明的 snapshot。原件未记录 provider 报告模型／snapshot／endpoint 或 provider 请求数，这些继续未知。执行器记录了 12,681 输入和 8,493 输出 tokens；缺失的各桶 usage 来源不可用今天的执行器语义补齐。缓存数字不能证明 provider 已报告；费用占位零且 `costReportedByExecutor=false` 表示美元费用未知，API 耗时零也不证明实际 provider 延迟。

这份原始 prompt-only v14 基线独立于 `v14-derived-strict` 和 `v15-candidate-strict` 两臂，不能混入它们的匹配条件、重复运行或改善估计。现有双臂提案仍须单独授权及独立人工证据；本登记不提供这些条件，也不激活生产 prompt。
