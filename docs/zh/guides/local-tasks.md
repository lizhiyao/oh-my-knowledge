# 验证本地任务结果

截至 2026-09-29，此入口已在 main 实现，但 npm `@next` 的 `1.0.0-beta.12` 尚未包含它。以下为源码预览，不是该发布版本的安装教程。

## 从源码预览

按[贡献指南](./contributing)安装依赖并运行 `yarn build`，随后在仓库根目录执行：

```bash
node dist/cli/index.js eval task examples/local-task/task.yaml --dry-run
node dist/cli/index.js eval task examples/local-task/task.yaml --output /absolute/path/to/task-reports
```

这个示例默认使用离线 fixture，不调用模型；它验证接线，不代表真实 Agent 表现。切换到 Codex 前核对模型、凭证、文件清单和成本边界，见下方可运行示例。

## 任务与证据

用 `omk eval task <definition> --dry-run` 预览可信本地任务，去掉 `--dry-run` 即可执行 control 和 treatment。任务组合已有 sample v3 文本输入、显式文件快照、两版知识、固定执行器配置、文件采集清单和独立 Node 验收程序。完整编写契约见[可运行示例](https://github.com/lizhiyao/oh-my-knowledge/tree/main/examples/local-task)。

CLI 预览模型、快照与验收程序身份、写入边界、文件清单、超时及未知 USD 成本。每个 Target × Sample × Trial 从新可写副本执行。同一 Trial 的 attempts 共享状态，首期不新增重试。相对文件路径须显式列出，不支持 glob 或越界；拒绝已知凭证路径、符号链接和特殊文件，声明的源文件不得含有凭证。

验收检查采集文件，不采信 Agent 的完成自述。有效的否定结果表示任务不通过；文件缺失、验收输出非法、基础设施错误、超时、取消和清理失败有各自诊断。缺失证据不变成通过或零分。Studio 既有报告可展开文件元数据与检查结果，原始产物和执行轨迹留在持久化证据中。

实验测量明确提供知识内容后的效果，不测量宿主原生 skill 安装或发现。固定本地快照、声明依赖和封存运行时身份改善可比性，外部服务条件仍不可控。工作区副本不是安全沙箱，只支持可信本地任务与验收程序。

示例包含正确修复、只声称修复、修复但引入回归三类控制案例，并记录手工输入及仍需自写的验收代码。离线 fixture 仅证明接线；小规模真实试跑、重复 trials 和公开示例不是发布证据，也不替代独立 holdout。

Node 调用者通过 `prepareLocalTask()` 使用同一应用流程。其 `rescore()` 方法复用同一进程持有的 canonical 结果中的充分执行证据，封存新的验收身份并保存新的 Runtime 结果引用；保留原始结果，明确标记事后调整。产物不足时拒绝。首期不提供跨进程结果导入或 Studio 重评分交互；可复制的 API 流程及存储限制见示例。

每个已开始的执行会在清理前保存声明文件与有界 stdout／stderr，验收基础设施失败也保存诊断。CLI 的 `diagnosticsDirectory` 与 `diagnosticReferences` 连接私有内容存储和运行身份；报告 annotations 保留同一目录。诊断不能用于把失败执行改判为成功。带本地 npm 依赖的多文件接入、六项独立回归检查和操作成本见上述示例中的购物车项目。
