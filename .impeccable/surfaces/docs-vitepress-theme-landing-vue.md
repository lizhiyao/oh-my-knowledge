---
version: 1
slug: "docs-vitepress-theme-landing-vue"
primary_target: "docs/.vitepress/theme/Landing.vue"
related_targets: ["docs/.vitepress/theme/landing-body.html","docs/.vitepress/theme/landing-body.en.html","docs/.vitepress/theme/landing.css"]
---

# 官网：从工作记录到可持续维护的知识
Mode: Persuade。访客是 Agent 使用者与 AI 应用开发者；先理解如何维护有来源的知识，再选择知识维护、直接评测或 Node 接入。
范围与授权：Issue #1185 的 A4–A11；保留 #1186 导航／复制行为和文档公开地址。PRODUCT.md 是产品事实来源；DESIGN.md 继续只约束 Studio 的操作界面，不将其像素密度用于官网。

## Direction contract
THESIS：首屏给出知识维护动作，用真实修订与载体引用展示具体机制，按需进入评测。
OWN-WORLD：延续 VitePress 导航、字体、明暗主题和清晰阅读；品牌行动紫来自 DESIGN.md，官网布局／字号在 landing.css 独立维护。移除旧评测舞台、渐变装饰与均匀能力卡。
STORY：开始维护知识 → 本地阅读（不调用模型）→ 明确选择与提炼（调用模型）→ 核对候选与来源 → 修订并显式更新载体；直接比较和离线 Node 示例是独立任务路径。
FIRST VIEWPORT：桌面由简短产品说明、主行动与真实 SDK 历史阅读区组成；1280×520 能看到主行动，移动端先呈现说明和可触达入口，截图随后。截图可打开原尺寸；菜单、搜索和语言切换复用 VitePress。
FORM：以真实产品阅读区和版本事实展示知识维护；有序步骤表达真实先后，替代任务用横向阅读行，不再用装饰卡片。代码直接实现现有界面的延伸；本轮没有独立概念选择或生成稿。seed: none (existing surface extension)。
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## 内容与资产职责
官网说明机制、证据和任务选择 → 根 README 提供安装与首个动作 → docs/README.md 按任务引导到领域指南 → 技术参考拥有字段与高级配置。任务可从官网直达指南，第一次 Node 接入指向离线示例，不指向配置大全；这是 A11 的内容职责边界。
SDK 截图只展示既有中文案例，英文页面明确说明界面语言；来源是 #1166／#1168 的独立验收材料在当前 Studio 的真实阅读区。sdk-maintenance-review.png 展示 v4 的变化核对，sdk-maintenance-current.png 展示 v5 正文；两张 PNG 均嵌入 origin metadata，sdk-maintenance-evidence.json 冻结观察时间、运行时版本、载体／知识修订身份与范围。未合成 UI，未新增模型调用；案例正文拥有来源、步骤与限制，截图不证明动态 SDK 或收益。
静态图按真实尺寸声明，首图高优先级、后图延迟加载；正文默认可见。已删除无引用的旧流程图、旧 hero 图与退场样式，旧试验事实仍由历史文档拥有。

## 完成证据与未验证范围
本轮验收覆盖中英文各 1280×900、1280×520、390×844、320×700，手机菜单、语言切换、本地 SDK 搜索、skip 入口，以及模拟复制成功／失败和异步完成不抢回焦点。明暗主题最小正文对比度分别为 5.83:1／7.87:1；减少动画与禁用 JS 下内容可读。仓库外 /private/tmp/omk-1185-review/ 保存 14 张截图及 browser.json／links.json，独立 finish reviewer 已打开全部截图，结论为 ship、No findings。物理机、VoiceOver、Lighthouse 与知识收益未验，收益验证仍由 #1115 拥有。
文档收口核对了 Landing.vue、两版 HTML、landing.css、landing-init.ts、两版 README 与冻结证据；保留 VitePress 世界和仅覆盖 Studio 的 DESIGN.md。官网不套用 Studio 像素密度；既有 .impeccable/design.json 漂移未在本轮修复。

发布边界：知识库、载体生成和变化核对需要 1.0.0-beta.14 或更新版本；安装 @next 后检查 omk --version。截图来自 main 源码验收，不能被理解为旧 Beta.13 的界面。用户已授权新的 next 发版；发行包安装与维护路径读回后才关闭发布承诺问题。
