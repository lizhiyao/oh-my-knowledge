# 可复现本地任务验收

[English](./README.md)

本示例在 `snapshot/math.mjs` 的隔离副本中修复 `absolute()`。独立验收程序检查负数修复以及正数、零的回归。需要 Node.js 22+ 和已安装的 OMK；离线 fixture 不需要额外依赖、凭证或模型调用。

```bash
omk eval task examples/local-task/task.yaml --dry-run
omk eval task examples/local-task/task.yaml --output /tmp/omk-task-reports
```

从仓库根运行，或传入复制后示例的绝对路径。源码检出先运行 `yarn build:runtime`，将 `omk` 替换为 `node dist/cli/index.js`。只写指定报告目录及临时目录，源快照保持不变。

离线执行器提供三个控制结果：control 只声称成功而不改文件，treatment 正确修复。在复制的 `task.yaml` 中设置 `variants.treatment: regression.md`，可演示修复负数却破坏正数的回归。这些案例验证接线，不证明 skill 效果。所有回答都声称缺陷已修复，是否通过由独立采集的文件决定。

## 真实 Codex 试跑

复制示例到临时目录，将 `execution` 替换为：

```yaml
execution:
  runtimeKind: codex
  executable: /absolute/path/to/codex
  model: YOUR_EXPLICIT_MODEL
  effort: low
  timeoutMs: 120000
```

可使用原生二进制或 npm 的 Node 启动器。使用启动器时，在 `execution.identityFiles` 中以 `{facetId, path}` 显式声明它实际加载的 Codex 二进制与其他依赖，确保运行身份覆盖间接实现；Node 本身由 OMK 自动记录。所安装 Codex CLI 必须支持 OMK Codex adapter 使用的参数。先预览再执行。CLI 仅为认证将当前 Codex 的 `auth.json` 复制到 attempt 私有 home，结束后清理；不复制全局 skill、规则或配置。首期不支持仅 API key 认证及自定义 provider 配置。USD 成本未知（`null`），不是零；执行器报告用量时会保留。一个 sample 调用两次 Agent。服务端模型变更和外部条件仍不可控。

## 编写成本与证据

用户准备六类输入：任务 YAML、源快照文件、两份知识文件、独立 Node 验收程序，以及声明的依赖文件（本例没有）。真实执行不需要自写 executor 或工作区管理代码；离线 fixture 只是验证接线的测试代码。CLI 操作为预览、执行两步。用户仍须编写领域验收逻辑，显式枚举快照与采集文件；OMK 负责隔离、采集、调用、清理和报告持久化。

任务定义使用 `omk.local-task/v1`，嵌入已有 sample v3。首期支持文本输入与 annotations，对不支持的 execution/evaluation context 明确拒绝。验收由独立程序负责，不把标准答案和测试程序传给 Agent。`snapshot.files`、`artifacts.files`、`acceptance.files` 都是显式相对文件路径，不支持 glob。拒绝符号链接、越界、特殊文件和已知凭证路径；任何声明文件均不应包含凭证。采集字节上限也约束初始快照，验收程序包上限为 16 MiB。适配器承诺的可写执行范围是独立 Trial 工作区；同一 Trial 内 attempts 共享状态，不隐式重试。

验收使用私有 HOME 与临时目录，在仅含采集产物的另一目录执行，使用单独复制的权威程序和声明依赖。stdin 提供可选的 `{sampleId}` JSON，stdout 必须输出一个 `omk.local-task-acceptance/v1` 对象，见 `acceptance/verify.mjs`。退出零且 `passed: false` 表示任务不通过；非零退出、非法输出、超时、取消和产物缺失分别记录原因码，属于缺失证据，不是零分或通过。任务输出、检查及身份保存在 canonical Runtime 产物中，快照和验收程序字节同时封存到内容存储。Studio 既有评测报告可展开任务文件元数据与验收检查，原始字节和轨迹保留在落盘产物中。

工作区清理等致命运行失败会封存原始失败结果并返回内容引用，不生成正常 Studio 运行行。

## 证据边界

这是可信本地执行，**不是不可信代码沙箱**。验收程序可能导入 Agent 生成的代码；工作区副本和单独验收目录不能阻止恶意同用户进程访问宿主。需要强隔离的任务不受支持，不得将它标记为 `trusted-local`。

## 程序化重评分

```js
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareLocalTask } from 'oh-my-knowledge';

const temporaryRoot = await mkdtemp(join(tmpdir(), 'omk-task-'));
try {
  const task = await prepareLocalTask({
    definitionPath: '/absolute/path/task.yaml', temporaryRoot,
    outputDirectory: '/absolute/path/reports',
  });
  const first = await task.run();
  const revised = await task.rescore(first.result, {
    root: 'revised-acceptance', files: ['verify.mjs'],
    entrypoint: 'verify.mjs', timeoutMs: 10000,
  }, '/absolute/path');
  console.log(first.reference, revised.reference);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
```

重评分只接受同一进程持有的 canonical 结果，采集证据不足时拒绝。新规则产生新的评分身份和不可变 Runtime 结果引用，原始结果不变。现有运行目录存储要求同一 run contract，因此重评分结果走 Runtime 既有结果存储，不作为第二份 Studio 运行展示；跨进程重放和 Studio 重评分交互不在首期范围。规则调整明确标记为事后重评分，不冒充预注册验证。一个 sample、重复 trials 和公开示例均不是有统计功效的发布证据，也不能替代独立 holdout。

### 已记录的真实试跑

2026-09-29（Asia/Shanghai），在 macOS arm64 上使用 Codex CLI 0.154.0、`gpt-6-astra`、low effort，一个 sample、一个 trial，执行时限 120,000 ms。Control 完成但未修复，负数检查失败，正数和零保持正常；treatment 超过执行时限，未进行验收。报告为证据不可解析、结论不确定，这是实际限制，不是成功的真实 A/B 比较。Control 报告输入 42,532 tokens、输出 149 tokens；treatment 用量和 USD 成本不可得。没有自动重试。

源运行 ID 为 `run-381c102b-5024-49cd-b35b-ded118f1431d`；快照摘要为 `sha256:f5311bed1e2b773820d4c2c69a09bebabfa004b165ec5361da382bcb6ec44f3c`，验收程序摘要为 `sha256:af09894f74c5d3cf5851d226ae0328944ca4ad60697b46e1713d3e67224d7e17`。后续存储与投影修复另行验证；本次试跑只证明上述真实执行表现。

## 失败现场与项目接入

每次已开始的执行在清理前封存声明文件与有界 stdout／stderr，包括超时、取消和非零退出；验收基础设施失败也保存部分输出。诊断使用既有私有内容存储，CLI 返回 `diagnosticReferences` 与 `diagnosticsDirectory`，报告 annotations 记录同一目录。目录内索引提供 run、sample、variant、trial、attempt、阶段和内容引用；通过内容 URI 对应的 `content/content/<key>.content.json` 读取完整证据。索引目录属于报告输出目录。未开始的执行没有现场；采集错误明确留在证据中。

诊断是失败现场，不是可评分的成功 output；运行记录的最终状态仍为权威依据，后续清理失败也不能被诊断中的完成状态覆盖。诊断写入失败会使执行失败。输出按 sensitive 处理，不在 Studio 直接显示原始日志，不能据此保证 Agent 输出绝不包含敏感数据。

带本地 npm 依赖、多文件快照和六项回归验收的完整接入步骤见[购物车项目](./project/README.zh.md)。
