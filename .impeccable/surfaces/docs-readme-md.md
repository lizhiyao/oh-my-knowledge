---
version: 1
slug: "docs-readme-md"
primary_target: "docs/README.md"
related_targets: ["docs/zh/README.md","README.md","README.zh.md","docs/guides/knowledge/sdk-maintenance-case.md","docs/zh/guides/knowledge/sdk-maintenance-case.md"]
---

# 文档与 README 的内容职责
Mode: Read。回答“从哪里开始、第一步如何核对、之后到哪里查阅”。继承 VitePress 文档阅读与 GitHub Markdown，不新增设计体系。
根 README：产品用途 → Node／Beta 通道／迁移 → 安装和 Studio 本地阅读 → 模型提炼条件 → 真实维护案例 → 按任务进入评测、Node 或 Agent → 按需查阅与安全边界。
A11 职责关系：官网解释机制和任务选择，根 README 交付安装与第一步，docs/README.md 沿用 #1184 的任务／领域目录，任务指南拥有操作动线，技术参考拥有字段、环境变量与高级配置。第一次 Node 接入落到离线示例；旧配置地址保留为查阅入口，不复制两套正文。
SDK 案例拥有来源、历史与当前修订、v4／v5 精确引用及观察范围；正文和 README 共用真实截图与冻结证据，明确本地阅读不调用模型、提炼调用模型、生成载体不额外调用模型。维护、保存、使用和效果分别记录，不将静态来源与人工决定写成动态 SDK 或复用收益。
中英镜像按相同节级、任务和限制维护；当前文档仅保留最新有效信息；旧提案与试验过程退出导航与搜索，退役页面和旧章节入口一并删除；无用试验数据直接删除，追溯使用 Git 历史。下载徽章明确 @next；不固定不断漂移的远端版本值。
本轮按两版 README、文档入口和官网实际 HTML 核对上述职责；视觉与交互验收范围归官网 brief，未扩展为真实设备、读屏、性能或收益证明。

发布边界：知识库、载体生成和变化核对需要 1.0.0-beta.14 或更新版本；安装 @next 后检查 omk --version。截图来自 main 源码验收，不能被理解为旧 Beta.13 的界面。beta.14 已发布，发行包安装与维护路径已读回；后续新版本发布仍按单独授权执行。
