# 语义映射索引

本文档维护业务术语到代码实体的映射关系，是 Agent 的核心查询资源。

> 最后更新: 2026-04-07
> 消费方式: AI 通过 Grep 检索关键词命中行（非全量 Read），因此所有消歧信息必须内联在表格行的说明列中。
> **templateCode 降级搜索**：当 NPM 包名（如 `@example/example-app-components-xxx`）在索引中无精确命中时，去掉 `@example/example-app-` 前缀重试（如 `components-xxx`）。仍无匹配则走 CLI remote。注意：`example-app-app`、`example-bff` 等仓库名本身含 `example-app-`，第一步即可命中，不受此规则影响。
> 表格格式: | 仓库 | 关键词 | 说明 | 代码入口 |
> 知识保鲜原则：只保留仓库/目录/文件级路径（L2），不保留行号（L3）。行号由 Coder Agent 实时读取。

---

## 方案设计推导原则

> 详见 `.claude/knowledge/solution-design-principles.md`

指导产品方案设计的决策逻辑，包括：
- **通用能力判断**：是否多行业适配
- **组件化决策**：是否做成platform组件（涉及交互 + 运营配置/管控诉求 + 页面归platform管理）
- **配置粒度**：单品维度放当前页面内（运营操作体验）
- **新页面定位推导**：先判断与现有页面的定位关系（变体 vs 独立），变体页面继承必备组件+按场景裁剪
- **核心动作归属**：用户在哪个页面完成核心动作，那个页面就是主页面，不要跳转
- **组件交互模式识别**：同一组件在不同页面可以有不同交互形态（表单态 vs 展示态），必须按页面分别定义

## 决策案例库

> 详见 `.claude/knowledge/decision-cases.md`

过往 PRD 中的关键决策点、错误路径、正确路径，供 Agent 方案设计时参考：
- **新页面定位**：变体 vs 独立 vs 完整复制的推导
- **核心动作归属**：用户在哪个页面完成动作
- **独立页面识别**：状态折叠 vs 独立页面
- **组件交互模式**：同一组件在不同页面的表单态 vs 展示态

> 每次 PRD 输出后回收新案例，通用化后追加。

---

## PRD 文档结构规范

指导 Agent 输出 PD 友好的方案文档，包括：
- **按页面组织**：每个页面自包含（定位+入口+组成+交互），不按技术关注点组织
- **方案概览前置**：页面全景表 + 核心规则枚举，让读者 10 秒对齐范围
- **技术与产品分层**：URL 参数、后端依赖等技术细节独立章节，标注"PD 可跳过"
- **写作检查清单**：6 项检查确保文档质量

---

## C 端页面索引

> 页面架构全景（层级分类、判定标准、展示条件、统计）见 `repos/example-app-app/.aima/skills/wiki-example-app-app-src/references/src/domain.md`「页面架构」章节。
> 本节仅提供高频关键词 → 代码位置的映射，不重复架构描述。

---

## 业务概念 -> 代码实体

### 投保/购买链路

| 仓库 | 关键词 | 说明 | 代码入口 |
|------|-------|------|---------|
| example-app-app | 投保页、购买页、insure | C端投保页面模块 | src/pages/insure |
| example-app-app | 投保页容器 | 投保页容器模块 | packages/example-app/src/pages/insure |
| example-bff `example-app` | 投保BFF、投保提交、出单 | BFF 投保提交+出单接口 | src/modules/example-app/ |
| example-bff `example-app` | 询价、quote | BFF 询价接口 | src/modules/example-app/ |
| example-bff `example-app` | 投保选项BFF、insureOptions接口 | 投保选项加载 BFF 接口 | src/modules/example-app/ |
| example-bff `example-app` | 核保准入、checkInsureInfo、准入校验 | 准入校验接口，仅多被保人场景在被保人增删时触发。⚠️ 单被保人不触发准入；投保按钮不调准入 | src/modules/example-app/ |
| example-bff `example-app` | 健告决策、反洗钱校验、签约授权 | BFF 健康告知决策+AML校验+签约授权 | src/modules/example-app/ |
| components-insure-common-insurance-info | 投保选项、insureOptions、被保人增删 | 投保选项组件，含被保人增删/选项变更。被保人增删触发准入校验。⚠️ 准入仅多被保人场景触发 | src/ |
| components-insure-common-insure-button | 投保按钮、InsureButton、我要投保 | 投保底部 Bar，调 insure() 集成营销（守护值等）。⚠️ 不调 checkInsureInfo，准入由投保选项组件触发。涉及营销全量覆盖时需同时关注确认页投保按钮（不同仓库） | src/ |
| components-insure-common-video | 投保页视频播放、视频封面、视频组件 | 投保页通用视频组件，展示封面图+点击跳转小程序播放页。支持 lazyLoad，可降级。⚠️ 非云梯视频讲解（example-app-insure-insadvance-upgrade-video-explanation） | src/ |
| components-insure-health-exception-style-level | 非互健告免责水位、健告水位、免责水位、合规水位 | 非互产品健告/免责展示水位配置（独立页面/浮窗/内嵌）。投保页不展示，控制确认页水位。适用行业=人寿险(life) | src/ |
| alipay-example-app-components-insure-common-gold-choice | 金选大卡、插槽渲染、寿险灵活特色卡、GoldChoice | 投保页金选大卡组件，通过插槽机制渲染寿险/行业通用灵活特色卡并接入金选数据加载 | src/ |
| components-insure-acc-ensure-liability | 保障责任（意外险）、销售计划切换、表格对比、核心责任弹窗 | 意外险保障责任展示，支持计划切换、表格对比、折叠展开及platform配置匹配 | src/ |
| components-insure-acc-ensure-rule | 保障规则（意外险）、保障须知、健康告知、常见病投保 | 意外险保障规则与须知展示，支持表格版和默认版两种样式 | src/ |
| components-insure-acc-plan-select | 计划选择（意外险）、计划Tab、推荐标签、计划锁定 | 意外险定制计划选择组件，支持Tab切换、推荐标签及计划锁定/展开联动 | src/ |
| components-insure-ask-questions | 常见问题、热门问题、支小宝、大家都在问 | 展示"大家都在问"常见问题列表，支持热门问题预取和支小宝问答跳转 | src/ |
| components-insure-claim-story | 理赔故事、用户评价 | 展示用户理赔故事与评价，用于产品页信任背书 | src/ |
| components-insure-common-actuary-evaluation | 金选专家评测、精算师评测、蚂小财、中小宝 | 展示金选专家/精算师评测内容，根据渠道动态适配展示 | src/ |
| components-insure-common-agreement-list | 条款展示、协议列表、费率表协议、进阶投保 | 投保页协议条款列表组件，支持条款筛选、合并计划及进阶投保独立渲染 | src/ |
| components-insure-common-assistant-decision | 常见问题FAQ、问答折叠 | 投保页常见问题组件，以折叠问答列表形式展示FAQ | src/ |
| components-insure-common-atmosphere | 氛围承接、背景图、营销氛围 | 营销承接页氛围展示组件，渲染背景图、主副标题等营销氛围元素 | src/ |
| components-insure-common-auto-renewal | 自动续保、续保开关、延续保障、锚点滚动 | 自动续保选项组件，支持投保页/确认页展示、推荐样式及动效提示 | src/ |
| components-insure-common-claim | 理赔流程、理赔评价、理赔案例、评价SDK | 理赔无忧页组件，展示理赔流程、评价列表和轮播案例图片 | src/ |
| components-insure-common-claim-explain | 理赔说明、理赔步骤、PDF理赔流程 | 展示理赔步骤说明，支持PDF理赔流程跳转及适老化模式 | src/ |
| components-insure-common-claim-intro | 理赔说明、理赔数据、淘宝渠道适配 | 理赔说明组件，展示理赔流程数据，支持淘宝渠道样式适配 | src/ |
| components-insure-common-conductor | 智能讲解、剧本播放、小浮层、全屏模式、conductorMode | 智能讲解浮层组件，支持剧本ID驱动的小浮层和全屏两种模式播放投保引导 | src/ |
| components-insure-common-config-service | 保单服务、增值服务、服务列表、兑换计划 | 保单增值服务配置展示组件，支持Tab切换、弹窗详情及多种服务资源项渲染 | src/ |
| components-insure-common-copyright | 版权信息 | 版权信息展示组件，用于投保页底部版权声明渲染 | src/ |
| components-insure-common-ensure-detail | 保障详情、保障计划、保障责任、查看详情 | 保障详情组件，聚合展示保障计划、责任及规则，支持查看详情跳转 | src/ |
| components-insure-common-ensure-liability | 保障责任（通用）、保障方案、计划合并、基本保额 | 通用保障责任详情组件，支持多计划合并展示、基本保额及插槽扩展 | src/ |
| components-insure-common-ensure-rule | 保障规则（通用）、保障须知 | 通用保障规则展示组件，渲染投保须知与保障条件说明 | src/ |
| components-insure-common-exception | 异常处理、降级展示 | 通用异常状态处理组件，负责投保页异常场景的降级展示逻辑 | src/ |
| components-insure-common-flexible-image-list | 灵活图片列表 | 灵活可配置的图片列表展示组件 | src/ |
| components-insure-common-graphic-inroduction | 产品特色、图文说明、分计划配置 | 产品特色图文说明组件，支持分计划配置、图片折叠展开及适老化懒加载 | src/ |
| components-insure-common-header-banner | 头图展示、视频播放、产品标题、税优标签、多产品分流 | 投保页头图组件，支持视频播放、产品标题/标签展示及多产品分流切换 | src/ |
| components-insure-common-image-text-introduction | 图文介绍、自定义跳转链接 | 图文介绍展示组件，支持图片列表渲染及自定义跳转链接 | src/ |
| components-insure-common-influencer-article | 大V文章、达人说、保险达人说、UMD加载 | 大V文章（达人说）入口组件，支持多坑位插槽、灰度控制及UMD动态加载 | src/ |
| components-insure-common-influencer-article-single | 达人文章、文章卡片、单篇展示 | 达人文章单卡片展示组件 | src/ |
| components-insure-influencer-article-multiple | 大V文章多条、达人说列表 | 大V文章多条展示组件，聚合渲染多篇达人推荐文章列表 | src/ |
| components-insure-common-live-pendant | 直播悬浮球、直播小窗 | 直播悬浮球组件，在投保页展示直播挂件入口并支持小窗浮层切换 | src/ |
| components-insure-common-plan-select | 投保计划切换（通用）、方案选择、骨架预渲染 | 通用计划选择组件，支持方案切换与保障联动，含插槽挂载和骨架预渲染 | src/ |
| components-insure-common-product-connection | 关联产品跳转、顶部横幅、互斥逻辑 | 产品关联跳转横幅组件，在投保页顶部展示关联产品入口并处理互斥逻辑 | src/ |
| components-insure-common-product-tag | 产品标签、税优健康险、标签ID枚举 | 产品标签区组件，支持多标签渲染、自定义标签配置及税优标签展示 | src/ |
| components-insure-common-promo | 营销定向、场景码、定向场景码 | 通用营销组件，根据场景码动态加载定向营销内容并注入表单数据 | src/ |
| components-insure-common-selling-points | 卖点展示、多计划卖点配置 | 产品卖点展示组件，支持多计划卖点配置及与金选组件的互斥隐藏逻辑 | src/ |
| components-insure-common-service | 安心赔、理赔服务、理赔等级、快赔、产品评级 | 理赔服务展示组件，支持安心赔认证、多等级理赔服务及适老化样式 | src/ |
| components-insure-common-tags | 标签列表、合规标签、排名标签、退款保障标签 | 通用标签区块组件，支持多类型标签渲染、折叠及插槽分发 | src/ |
| components-insure-common-trace-back | 可回溯、合规水位、签约授权、投保拦截 | 可回溯合规组件，管理投保页签约授权流程、合规水位判断及投保拦截逻辑 | src/ |
| components-insure-confirm-trial-commercial-config | 赠转商运营配置、试商业化、保障阶段说明 | 确认页赠转商运营配置组件，展示试商业化相关保障阶段说明 | src/ |
| components-insure-ensure-benefit-points | 保障利益点、保额、保障期限、免费期 | 保障利益点展示组件，支持多计划配置、免费期及赠转商卖点文案渲染 | src/ |
| components-insure-evaluation | 理赔评价、评价列表、关联产品评价、货架高亮 | 理赔评价列表组件，支持评价总结、关联产品评价及融合版式展示 | src/ |
| components-insure-inshealth-prods-select | 交叉导购、吸底样式、产品卡片、弹窗产品列表 | 交叉导购组件，支持吸底/弹窗多种样式展示关联产品卡片列表 | src/ |
| components-insure-inst-credit | 保司增信、保司信息、保司logo、权益属性 | 保司增信卡片组件，展示保司Logo、标签及权益属性以增强用户信任 | src/ |
| components-insure-marketing-equity | 营销权益、投后权益、加保引导、CSR缓存 | 营销后返权益展示组件，支持投后权益展示、加保引导及CSR缓存优化 | src/ |
| components-insure-positivervaluation | 车险投保评价、好评列表、保单评价 | 通用评价组件，展示车险投保好评列表，支持保单评价及关联产品数据加载 | src/ |
| components-insure-pre-page | 前置页、产品卡片、对比模板、场景模板 | 前置营销页组件，支持对比/场景/自定义模板多种形式的产品展示 | src/ |
| components-insure-ranking-info | 榜单排名、热销榜、榜单跳转 | 榜单排名展示组件，通过platform模块配置渲染热销榜排名信息 | src/ |
| components-insure-ranking-tag | 榜单排名标签、热销榜标签 | 榜单排名标签组件，以标签形式展示热销榜排名并支持插槽挂载 | src/ |
| components-insure-session-link-for-confirm | 确认页建联、管家建联 | 确认页建联组件，提供管家建联入口，支持默认建联开关配置 | src/ |
| components-insure-turbo-dsp | DSP外投、电话预约、智能讲解、服务顾问卡片 | 涡轮DSP外投组件，支持电话预约/取消、智能讲解触发及服务顾问卡片展示 | src/ |
| components-insure-underwriting-stuck-config | 核保卡点、提额、拉白、气泡文案 | 核保卡点识别配置组件，管理提额/拉白入口的展示配置和文案渲染 | src/ |
| example-app-insure-acc-guide-swiper | 文案引导轮播（意外险）、GuideSwiper | 意外险投保页文案引导垂直轮播组件，支持自动播放和图标文案列表配置 | src/ |
| example-app-insure-aspirations-component | 投保心声、UGC评价 | 投保页投保心声入口组件，展示UGC用户评价内容并支持二级页跳转 | src/ |
| example-app-insure-assured-refund | 安心赔标签、ClaimService、relievedClaimCertified | 投保页标签区安心赔入口组件，展示产品安心赔认证等级并支持跳转 | src/ |
| example-app-insure-commercial-open-switch | 赠转商选择开通、体验版商转 | 体验版投保确认页商转选择开通组件 | src/ |
| example-app-insure-common-gift-atmosphere | 赠险氛围承接、体验版、免费体验提示 | 投保页赠险氛围承接组件，展示背景图、保障期限和免费体验提示 | src/ |
| example-app-insure-common-gift-commercial-selector | 赠险加购商险（投保页）、商业险准入、询价 | 投保页赠险加购商险选择组件，支持商业险准入检查、保费询价展示和详情弹窗 | src/ |
| example-app-insure-common-intelligent-header-banner | 智能头图、弹幕、Swiper轮播、图片预加载 | 投保页智能头图轮播组件，支持多图切换、静态/动态弹幕展示 | src/ |
| example-app-insure-common-pure-password | 核身密码、Verify、身份验证 | 投保页核身密码组件，提供渠道配置化的身份验证能力 | src/ |
| example-app-insure-detail-common-insure-button | 投保按钮（投保单详情）、协议同意、售罄限购、代扣模式 | 投保确认页核心投保按钮组件，集成协议列表、预约投保、健康告知、管家建联等前置逻辑 | src/ |
| example-app-insure-detail-common-product-info | 产品信息（投保单详情）、承保公司 | 投保单详情页产品信息组件，展示产品名称和承保公司 | src/ |
| example-app-insure-elder-common-header-banner | 适老化头图、走马灯插槽 | 适老化投保页头图组件，展示头图并提供走马灯插槽挂载点 | src/ |
| example-app-insure-elder-common-service | 适老化服务信息、serviceTitle | 适老化投保页服务信息展示组件，展示服务标题、描述及保司信息 | src/ |
| example-app-insure-family-insurance-info | 家庭投保、家人头像、多被保人勾选、FamilyInsuranceInfo | 投保页家庭版"为谁投保"组件，支持添加/编辑家庭成员、多被保人勾选及推荐位引导 | src/ |
| example-app-insure-insasset-service-asset | 可享服务、服务包推荐、赠险插槽 | 投保页可享服务组件，展示服务包推荐并根据赠险/非赠险场景挂载不同插槽 | src/ |
| example-app-insure-insauto-archive | 车险非车建档、驾乘意外、电池衰减、车辆档案 | 投保页车险非车建档组件，支持驾乘意外和电池衰减两种场景的车辆档案管理 | src/ |
| example-app-insure-insbutler-strategy-component | 管家剧本、策略组件、投保页计划书、sceneCode | 投保页管家剧本策略组件，根据展位码渲染保险规划师计划书入口 | src/ |
| example-app-insure-common-product-changer | 多产品切换、Tab切换、分流、saleSplit、推荐标签 | 投保页多产品切换组件，通过分流接口支持产品Tab切换、额外配置Tab和推荐标签展示 | src/ |

### 确认页/支付

| 仓库 | 关键词 | 说明 | 代码入口 |
|------|-------|------|---------|
| example-app-app | 确认页、confirm | C端确认页面模块 | src/pages/confirm |
| example-app-app | 确认页容器 | 确认页容器模块 | packages/example-app/src/pages/confirm |
| components-confirm-common-insure-button | 确认页投保按钮 | 确认页底部投保按钮，与投保页投保按钮是**不同仓库**。也集成营销（守护值等）。⚠️ 涉及营销全量覆盖时需同时关注投保页和确认页两个按钮组件（用户纠正） | src/ |
| components-confirm-common-auto-renewal | 自动续保（确认页）、延续保障、代扣开关 | 确认页自动续保组件，支持赠转商场景的续保开关展示与默认值配置 | src/ |
| components-confirm-common-exception | 免责说明（确认页）、职业告知、TrialInsureException | 确认页免责说明组件，支持折叠展开、长辈模式、赠险商险tab多条协议展示 | src/ |
| components-confirm-common-insure-options | 投保选项（确认页）、保费展示、附加计划 | 确认页投保选项列表组件，展示保费、缴费频率、营销折扣及多被保人家庭单选项 | src/ |
| components-confirm-common-insured-user | 被保人展示（确认页）、反洗钱、InsuredUserWrapper | 确认页被保人信息展示主入口，支持寿险、年金、宠物赠险等多形态及反洗钱地址校验 | src/ |
| components-confirm-common-marketing | 营销优惠（确认页）、折扣展示、减收券 | 确认页营销优惠信息展示组件，展示折扣描述、赠险及大众版金额并处理合规屏蔽逻辑 | src/ |
| components-confirm-common-product-info | 产品名称（确认页）、承保机构、保logo | 确认页产品信息组件，根据售卖模式和机构信息决策展示logo组合样式 | src/ |
| components-confirm-common-trial-commercial-detail | 赠转商保障详情（确认页）、保费代扣、核弹样式 | 确认页赠转商保障详情组件，支持核弹样式与普通样式切换，含宠物险增值服务 | src/ |
| example-app-confirm-appropriateness-insure-evaluate | 适当性评估、投保评估、问卷浮层 | 确认页适当性投保评估组件，展示评估结论并支持触发问卷浮层 | src/ |
| example-app-confirm-appropriateness-questionnaire | 适当性问卷、重新评估 | 确认页适当性问卷内容组件，展示投保评估问题细则并支持重新评估 | src/ |
| example-app-confirm-common-experiment-config | 实验配置（确认页）、ExperimentConfig | 确认页实验配置占位组件，渲染为null仅用于承载实验配置能力 | src/ |
| example-app-confirm-common-gift-commercial-selector | 赠险加购商险（确认页）、三态勾选 | 确认页赠险加购商险选择组件，提供三态勾选及保险详情弹窗 | src/ |
| example-app-confirm-common-guarantee-info | 保障信息（确认页）、保障期限、等待期、延续保障 | 确认页保障信息组件，展示保障期限、等待期、责任详情及延续保障选项 | src/ |
| example-app-confirm-common-header-banner | 头图（确认页）、犹豫期、机构logo | 确认页头图组件，展示产品名称与机构logo，支持犹豫期提示弹窗和适老化 | src/ |
| example-app-confirm-common-health-inform-card | 健康告知（确认页）、健告决策、除外承保、拒保 | 确认页健告信息卡片组件，展示健康评估结论（通过/除外/拒保）并支持重新评估 | src/ |
| example-app-confirm-common-insured-info | 被保信息（确认页）、被保房屋、标的物 | 确认页被保信息主组件，聚合被保人个人信息与房屋信息（家财险）展示 | src/ |
| example-app-confirm-common-payment-info | 支付信息、保费展示、保费明细弹窗、家庭单折扣 | 确认页支付信息组件，展示保费及营销折扣，支持多被保人保费明细弹窗 | src/ |
| example-app-confirm-common-policy-benefits | 保单权益、权益列表 | 确认页保单权益组件，展示产品保障权益列表 | src/ |
| example-app-confirm-elder-assured-guarantee | 适老化安心保障、长辈模式 | 适老化场景下的安心保障展示组件，渲染可配置的保障名称与描述列表 | src/ |
| example-app-confirm-multiple-insurance-info | 组合投保（确认页）、多保单信息、子交易单、汇总保费 | 确认页组合投保多保单信息确认组件，展示各子交易单被保人与投保选项并汇总总保费 | src/ |
| example-app-confirm-profile-card | 反洗钱新规、个人信息编辑、amlNewComponentSwitch | 确认页个人信息编辑组件，支持投被保人信息的展示、补全、校验及反洗钱暂存挽留 | src/ |
| example-app-app | 支付成功页、pay-success | 支付成功页面 | src/pages/pay-success |
| example-app-app | 支付成功页容器 | 支付成功页容器 | packages/example-app/src/pages/pay-success |
| components-pay-success-common-insure-info | 支付成功页保障信息、InsureInfo | 支付成功页保障信息组件，含出单超时提示、保单详情、进阶投保、组合保单、医保支付、适老化等 | src/ |
| components-pay-success-common-one-of-three | 数金三选一、展位码、罗书容器 | 支付成功页数金三选一营销展位组件，通过展位码控制展示类型 | src/ |
| components-pay-success-common-platform-market | 平台流量、策略中心展位、复购卡片 | 支付成功页平台流量接入组件，通过策略中心展位和platform场景码动态渲染复购卡片 | src/ |
| components-pay-success-marketing-discount | 返豆、营销权益（成功页）、寿险定转定 | 投保成功页返豆营销权益组件，展示营销折扣并支持预约投保和寿险定转定场景 | src/ |
| example-app-success-common-questionnaire | 投保成功问卷、回访互斥、ESceneType | 投保成功页问卷组件，根据单品或组合投保场景触发对应活动问卷并与回访组件互斥 | src/ |
| example-app-success-wufu-show-card | 五福发卡、showFuCard | 投保支付成功页五福发卡组件，在支付成功后调用支付宝五福插件展示福卡 | src/ |
| example-app-insure-config-pay-success-common-one-of-three | 数金三选一配置、tipText | 投保结果页数金三选一配置组件，通过platform模板控制是否显示及提示文案 | src/ |
| example-bff `example-app` | 创建交易单 | 创建交易单接口 | src/modules/example-app/ |

### 预约单/停售/免责

| 仓库 | 关键词 | 说明 | 代码入口 |
|------|-------|------|---------|
| example-app-app | 预约单、policy-order | 售卖域预约单详情页。⚠️ 仅支持赠转商（TRIAL_INSURE）和商转商（CTC）场景（用户纠正）。不走platform，完全本地代码渲染 | src/pages/policy-order |
| example-app-app | 预约单容器 | 预约单容器，通过 insSaleScenarioType 区分场景 | packages/example-app/src/pages/policy-order |
| example-app-app | 停售页、stop-sell | 停售页面 | src/pages/stop-sell |
| example-app-app | 停售页容器 | 停售页容器 | packages/example-app/src/pages/stop-sell |
| components-exception-common-page | 免责页组件、免责说明页、ExceptionPage | 免责说明页组件，含协议分组Tab、职业告知、重要告知、组合投保免责、适老化 | src/ |
| components-agreement-list-common-page | 条款列表（通用页）、组合险分组、agreementKey | 条款列表通用页组件，支持单品和组合险分组展示协议并跳转条款详情页 | src/ |
| components-plan-common-page | 计划详情页（通用）、Tab切换、Swiper、多计划切换、智能关键词 | 投保计划详情页主页组件，支持多计划Tab/Swiper切换展示保障规则与保障责任 | src/ |
| example-app-app | 免责页容器、exception | 免责页容器 | packages/example-app/src/pages/exception |
| example-app-app + example-app-resource-config | 寿险确认页链路、life confirm | **寿险(life)是独立一级类目**，走 example-app-app 标准确认页容器 + resource-config 按二级类目加载组件。⚠️ 不走健康险切面(example-app-aspect-health)（用户纠正） | packages/example-app/src/pages/confirm/ |
| example-app-app | 逾期页、overdue | 逾期页容器 | packages/example-app/src/pages/overdue |
| example-app-app | 协议列表、agreement-list | 协议列表容器 | packages/example-app/src/pages/agreement-list |

### 保障计划/续保/其他一级页面

| 仓库 | 关键词 | 说明 | 代码入口 |
|------|-------|------|---------|
| example-app-app | 保障计划详情页、plan、计划页 | 保障计划详情页容器（子页面）。⚠️ 非 B 端计划配置组件（sales-center PurePanel） | packages/example-app/src/pages/plan |
| example-app-app | 续保页（健康险）、renewal | 健康险续保页容器（独立入口） | packages/example-app/src/pages/renewal/health.ts |
| example-app-app | 续保页（意外险）、acc-renewal | 意外险续保页容器（独立入口） | packages/example-app/src/pages/renewal/accident.ts |
| example-app-app | 开始预约页、start-reserve | 体验版赠转商流程预约页（子页面） | src/pages/start-reserve |
| example-app-app | 二次投保页、dual-insure | 暂存草稿触发的二次投保页（子页面，MF 动态加载） | src/pages/dual-insure |
| example-app-app | 退保、policy-surrender | 退保申请+详情页（非容器页面） | src/pages/policy-surrender-apply |
| example-app-renewal-acc-renewal-info | 意外续保选项、RenewalInfo、付款方式、有无医保 | 意外险续保页续保信息确认组件，支持付款方式选择、医保配置和自动续保开关 | src/ |

### 补缴页（after-overdue）

| 仓库 | 关键词 | 说明 | 代码入口 |
|------|-------|------|---------|
| example-app-after-overdue-button | 补缴按钮、payStatus、查看保单 | 补缴页底部操作按钮组件，根据缴费状态（待缴/成功/无需缴费）切换按钮文案和跳转行为 | src/ |
| example-app-after-overdue-header | 补缴头图、payStatus | 补缴页顶部头图组件，根据支付状态展示不同头图配置 | src/ |
| example-app-after-overdue-liability-detail | 补缴保障详情、待补缴保费、保障期限 | 补缴页保障详情组件，展示保司/被保人/保障期限/待补缴保费等信息 | src/ |
| example-app-after-overdue-liability-range | 保障范围（补缴页）、责任明细 | 补缴页通用保障范围组件，以插槽形式挂载展示责任明细列表 | src/ |
| example-app-after-overdue-rule-desc | 补缴规则说明、代扣失败、失效时间 | 补缴页规则描述组件，仅在待缴状态下展示体验版转付费代扣失败及失效时间说明 | src/ |

### 商转开通页（convert-business-open）

| 仓库 | 关键词 | 说明 | 代码入口 |
|------|-------|------|---------|
| example-app-convert-business-open-common-button | 商转开通按钮、代扣开通、同意协议、reserveStatus | 商转开通页底部按钮组件，根据预约状态和协议同意情况控制按钮显示与行为 | src/ |
| example-app-convert-business-open-header | 商转头图、中间页/独立页、赠转商 | 商转开通页头图组件，根据中间页或独立页类型渲染不同背景图 | src/ |
| example-app-convert-business-open-info-card | 商转保障卡片、保障期限、后续扣费 | 商转开通页保障卡片组件，展示免费/付费保障期限、被保人、保额及后续扣费信息 | src/ |
| example-app-convert-business-open-introduction | 商转图文详情、middlePage/phoneRecallPage | 商转开通页图文详情组件，根据中间页或独立页类型渲染对应图片列表 | src/ |

### 其他独立组件

| 仓库 | 关键词 | 说明 | 代码入口 |
|------|-------|------|---------|
| example-app-common-duaiinsure-count-down | 反洗钱倒计时、投保单失效、expiryTime、服务器时间校准 | 投保单详情页反洗钱新规倒计时组件，基于服务器时间偏移计算剩余时间并在超时时自动使投保单失效 | src/ |

### 页面组件配置（example-app-resource-config）

| 仓库 | 关键词 | 说明 | 代码入口 |
|------|-------|------|---------|
| example-app-resource-config | 页面组件配置、resource-config、非platform页面组件 | 非platform页面（确认页V1/免责/成功/保障详情/协议）的组件列表静态配置。三级查找：pageName → subCategory → saleSchemeType。⚠️ ≠platform搭建（投保页/确认V2 走platform运营配置）（用户纠正） | src/resource/ |
| example-app-resource-config | 成功页组件配置 | 支付成功页组件列表 | src/resource/pay-success/config/ |
| example-app-resource-config | 免责页组件配置 | 免责页组件列表，默认仅 exception-common-page | src/resource/exception/config/ |
| example-app-resource-config | 确认页组件配置（V1） | 确认页 V1 组件列表，按二级类目差异化（40+ 类目文件）。⚠️ V2 走platform远端配置，切换逻辑在 page-container.ts:getForceUseRemoteConfig | src/resource/confirm/config/ |

### 产品分流/渠道

| 仓库 | 关键词 | 说明 | 代码入口 |
|------|-------|------|---------|
| example-bff `example-app` | 产品分流、splitScene、splitStrategy | BFF 分流入口（新老链路） | app/modules/example-app/controller/insurePage.ts |
| example-bff `example-app` | 预决策 | 预决策服务，接收 entrance/source | app/modules/example-app/service/preDecision.ts |
| example-bff `example-app` | 新链路预加载 | 分流+预决策合并 | app/modules/example-app/service/insurePreLoadService.ts |
| example-app-app | 渠道参数、entrance、source | entrance → bxEntrance 请求头 | src/common/pre-request/ |
| example-bff `example-app` | BFF 解析渠道参数 | clientInfo.source / clientInfo.entrance | app/extends/context.ts |
| example-app-app | platform、druids、insiop | 配置化运营平台（后端系统名 insiop）。核心能力：页面组件管理+实验分流+渠道差异化配置。⚠️ ≠resource-config（免责/成功/确认V1 走静态配置）；⚠️ ≠星云（星云是面向机构的发品系统） | — |
| example-app-app `domain.md` | platform组件结构、投保页组件布局、双轨道设计 | 投保页 6 个 Zone 分区、双轨道设计（决策轨道 vs 信任轨道）。详见 domain.md 第一章 | domain.md |
| example-app-app `domain.md` | 投保页交互节点、草稿库前置时机、投保选项字段分类、确认页职责边界 | 投保页事件节点模型、字段分类体系。详见 domain.md 第二章 | domain.md |
| example-app-app `domain.md` | 投保页组件注册表、组件通用行业分类、NPM包名、必备组件 | 投保页+确认页全量组件清单，含通用/行业分类。**必备组件**：合规+价格+条款。行业组件仅 2 个。详见 domain.md 第三章 | domain.md |
| example-app-app `domain.md` | 页面架构、有多少页面、EPageName、页面层级、页面总量 | C 端 29 个页面：15 容器页（9 独立入口 + 6 子页面）+ 12 非容器 + 2 切面。详见 domain.md「页面架构」 | domain.md |
| example-bff `middleware` | 产品分类、category | 产品分类信息注入中间件 | src/modules/middleware/ |
| sales-center `SplitStrategy` | 分流策略类型（5种）、策略命中条件 | 分流策略类型和命中条件配置 | src/pages/SplitStrategy/ |
| sales-center `SplitStrategy` | 渠道分流（entrance）、entrance白名单、hitEntranceWhiteList | B 端分流策略 entrance 维度配置项 | src/pages/SplitStrategy/ |
| sales-center `SplitStrategy` | 宠物险渠道分流 | 宠物险专属 entrance 分流，行业定制不可复用 | src/pages/SplitStrategy/ |
| sales-center `ProductGroup` | 产品组管理 | 产品组分流管理（三种业务类型） | src/pages/ProductGroup |
| sales-center `SplitRule` | 分流规则配置 | 动态分流规则（按保司/按产品） | src/pages/SplitRule |
| sales-center `ProductGroup` | 产品组渠道类型 | DEFAULT/INSURANCE_PLATFORM（与 entrance 不同） | src/constants/productGroup.ts |

### 售卖平台核心概念

> 来源：售卖研发白皮书（https://docs.example.com/inscore/mma9mh），2026-03-13 学习

| 仓库 | 关键词 | 说明 | 代码入口 |
|------|-------|------|---------|
| — | example-app、长江、长江框架、售卖框架 | 基于 React 的保险投保 H5 渲染框架，提供页面容器、数据管理、流程控制。组件通过 `useInsurePageContainer()` 取数据 | — |
| — | 类目（category）、一级类目 | 保险产品类目，如健康险、意外险。部分行业差异化按类目定制 | — |
| — | 二级类目（subCategory） | 产品子类，如健康险下的医疗险。一个子类只归一个一级类目 | — |
| — | 售卖模式、saleSchemeType | 基于类目+规则定制的投保流程，绑发品链路（重）。4种：GROUP_INSURE/TRIAL_INSURE/CTC/GIFT_WITH_COMMERCIAL_ADDON_INSURE。一个品只有一个售卖模式=一个投保页。新增=前后端各新建应用+全部组件复制（用户纠正）。⚠️ ≠售卖场景（轻量玩法叠加，不绑发品） | — |
| — | 体验版、赠转商、赠加商 | 同一售卖模式（TRIAL_INSURE）的不同叫法。投保页 prodNo 是赠险的 prodNo，platform配置也挂赠险下。C 端投保选项数据来自计划配置组件（非 Operation） | — |
| — | 售卖场景、insSaleScenarioType | 纯业务玩法叠加，不绑发品（轻）。如进阶投保、预约投保。⚠️ ≠售卖模式（绑发品链路，代价高） | — |
| — | 团购售卖、拼团、GROUP_INSURE | **售卖模式**的一种（用户纠正）。拼团页面是独立新页面逻辑。⚠️ 不是售卖场景 | — |
| — | 流程引擎、process-engine | 后端通过 SmartEngine 配置，生成 XML 存储。在能力管理页以「流程引擎」类型存储 | — |
| — | 能力管理、abilityTemplate | 售卖中心管理可复用的后台能力单元。4 种类型：流程引擎/能力选项/类目能力/费率表因子 | — |
| — | 产品数据链路 | 机构在**星云**发品 → 自动生成产品运营页 → **platform**运营搭建 → C 端组件加载。查产品用**繁星** | — |
| sales-center `PurePanel` | 计划配置组件、PurePanel | 每个投保页模板必须有一个计划配置组件。配置投保选项（含交费频率）、缴费规则等。⚠️ 数据主要被后端消费，C 端投保选项组件消费的是后端基于此配置下发的数据（用户纠正）。⚠️ 非 C 端保障计划详情页 | src/pages/PurePanel/ |
| — | 售卖配置、InsurePlan | 保险产品将条款与责任组合售卖，一个产品可有多个售卖计划 | — |
| — | 资源清单 | 管理组件 NPM 包与 CDN 链接的对应关系，控制组件版本 | — |
| — | MF 应用、Module Federation | 框架通过 Webpack MF 拆分应用。当前接入：example-app-npm-package、example-app-resource-config、健康险切面 | — |
| — | 繁星 | 内部查看产品配置的工具，入口 https://insppbff.alipay.com/ins-prod/std | — |
| — | 页面模板 | platform能力：一个页面模板可生成 N 个运营页，运营页与场景码一一对应 | — |
| — | platform业务规则 | 方案命中的条件控制机制。支持售卖业务场景枚举和自定义规则。⚠️ ≠组件级配置项（组件配置控制单组件，业务规则控制方案级命中） | — |
| — | ragdoll 平台 | 与 example-app-studio 并存的 LowCode 组件开发平台（ragdoll.alipay.com），NPM 包名以 `ragdoll-` 为前缀。ProCode + LowCode 组件可在同一投保页共存 | — |
| — | 金选组件页、金选大卡 | 独立页面类型，使用页面模板「投保页金选大卡组件配置」。⚠️ 非投保页模板，业务线归属「保研」 | — |
| — | 售卖技术配置 | 售卖中心 Operation 和计划配置组件管理的是**品级技术配置**（两品关联、投保选项数据）。⚠️ ≠运营配置（platform运营页管理组件开关/排序/实验/文案）（用户纠正） | — |

### 页面参数

| 仓库 | 关键词 | 说明 | 代码入口 |
|------|-------|------|---------|
| example-app-app | URL参数、页面参数、prodNo、spNo | 投保页URL参数说明（产品标识、渠道参数） | — |
| example-app-app | entrance参数 | 渠道埋点参数 | — |
| example-app-app | source参数 | platform渠道控制参数 | — |

### 被保人/人员管理

> **被保人样式分类**：3 种有流量样式（多被保人老样式、多被保人新样式、单被保人），需求覆盖 3 种即可。
> **术语统一**（用户纠正）：不再区分「老单」「新单」，统一称**「单被保人」**。代码统一指向 `example-app-biz-single-insured-user`。
>
> | 统一名称 | 代码层名称 | 仓库 | 渲染条件 |
> |---------|-----------|------|---------|
> | 多被保人老样式 | MultipleInsuredUsers | example-app-biz-multiple-insured-users | `multipleInsuredsType \|\| isSeniorMode` |
> | 多被保人新样式 | MultiWithSingleInsured | components-insure-common-insurance-info | `insuredWithMedicalInfo` |
> | 单被保人 | SingleInsuredUser | **example-app-biz-single-insured-user** | 默认（前两条件都不满足） |
>
> 已废弃：SingleInsuredLite（无流量，新需求无需覆盖）。渲染优先级：Lite > 新多 > 老多 > 单被保人。

| 仓库 | 关键词 | 说明 | 代码入口 |
|------|-------|------|---------|
| example-app-app | 被保人、投保人、人员管理、PersonManager | PersonManager 模块 | src/ |
| components-insure-common-insurance-info + example-app-biz-multiple-insured-users | 多被保人老样式、老多被保险人、MultipleInsuredUsers | 多被保人老样式。有新增/修改弹窗，触发准入后刷新投保数据 | src/components/MultiInsured/ |
| components-insure-common-insurance-info | 多被保人新样式、MultiWithSingleInsured | 多被保人新样式。有弹窗确认动作（确认新增/确认修改），可作为逻辑前置触发点。⚠️ ≠单被保人（单被保人无弹窗确认） | src/components/MultiWithSingleInsured/ |
| example-app-biz-single-insured-user | 单被保人、老单、新单、SingleInsuredUser | 单被保人（统一名称，用户纠正）。⚠️ 无新增/修改弹窗，不调准入，切换人后直接刷新。无用户确认动作，不适用逻辑前置。⚠️ ≠多被保人新样式 | src/ |
| example-app-app `domain.md` | 投保人信息展示、HolderUserInfo、showHolder | 投保人信息展示条件模型（前置守卫+4条件）。正常身份证已认证用户不展示。详见 domain.md 第一章 | domain.md |
| example-app-app `domain.md` | 手机号采集、holderPhone、HolderPhoneItem | 投保人手机号采集条件分支：3 处采集组件（按样式分布），校验规则按证件类型区分。详见 domain.md 第二章 | domain.md |
| example-app-app `domain.md` | 被保人样式交互规则、本人可投保、切换关系限制 | 3 种样式各自的投保人信息交互规则。详见 domain.md 第三章 | domain.md |
| example-app-app | 投保数据刷新、loadInsureOptions、createInsureApplication | 人信息变更后刷新流程：loadInsureOptions → createInsureApplication → quote（串行） | src/ |
| example-bff + components-insure-common-insurance-info | 准入、调用准入、VM 切流 | ⚠️ 仅多被保人场景调用准入。VM 开关影响准入接口选择，不影响后续投保数据刷新 | src/ |
| example-app-app | 证件信息、certInfo、人员关系、relationToHolder | 证件信息+人员关系管理 | — |
| example-app-app | 用户信息页、user-info | 用户信息页面 | src/pages/user-info |
| example-bff `example-app` | 被保人确认BFF、家人导入、OCR识别 | BFF 被保人确认+家人导入+OCR | src/modules/example-app/ |

### UI组件（example-app-ui）

| 仓库 | 关键词 | 说明 | 代码入口 |
|------|-------|------|---------|
| example-app-app `example-app-ui` | 投保按钮基础组件、InsureButton（example-app-ui） | example-app-ui 中的投保按钮基础组件。⚠️ ≠投保底部 Bar（components-insure-common-insure-button） | packages/example-app-ui/ |
| example-app-app `example-app-ui` | 保障责任、EnsureLiability、保障规则、EnsureRule | 保障责任+保障规则展示组件 | packages/example-app-ui/ |
| example-app-app `example-app-ui` | 投保计划选择器、EnsurePlanSelector | 投保计划选择组件 | packages/example-app-ui/ |
| example-app-app `example-app-ui` | 协议列表组件、ProductAgreementList | 协议列表组件 | packages/example-app-ui/ |
| example-app-app `example-app-ui` | 咨询按钮、ConsultButton | 咨询/主动服务按钮 | packages/example-app-ui/ |
| example-app-app `example-app-ui` | 弹窗组件、Dialog、Modal、Popup | 弹窗系列组件 | packages/example-app-ui/ |
| example-app-app `example-app-ui` | 表单组件、Form、自动续保、AutoRenewal | 增强表单组件+自动续保组件 | packages/example-app-ui/ |
| example-app-app `example-app-ui` | 智能关键词、SmartKeyword、疾病关键词、DiseaseKeyword | 关键词系列组件 | packages/example-app-ui/ |

### 框架/架构

| 仓库 | 关键词 | 说明 | 代码入口 |
|------|-------|------|---------|
| example-app-app `core` | 页面容器、PageContainer、状态管理、Model、Redux | 核心页面容器架构+状态管理 | packages/example-app/ |
| example-app-app `aspects` | 切面编程、AOP、Aspect | 通用切面编程体系。⚠️ ≠platform组件（切面是代码级 AOP，无运营配置能力）；⚠️ ≠行业切面 MF（example-app-aspect-health/asset 按险种隔离） | packages/example-app-aspects/ |
| example-app-app `core` | 流程引擎、ProcessEngine | 流程引擎节点编排 | packages/example-app/ |
| example-app-app `core` | 插槽机制、Slotable、CDN资源加载、ResourceManager、活动引擎 | 插槽分发+资源加载+活动引擎 | packages/example-app/ |
| example-app-app | 依赖注入、inversify | 依赖注入体系 | packages/example-app/ |

### 切面/拦截

| 仓库 | 关键词 | 说明 | 代码入口 |
|------|-------|------|---------|
| example-app-app `aspects` | 核保失败拦截、insure-intercept | 核保失败引导浮窗 | packages/example-app-aspects/ |
| example-app-app `aspects` | 轨迹录制、stalker、可回溯 | 用户操作轨迹录制 | packages/example-app-aspects/ |
| example-app-app `aspects` | 实名认证、user-auth | 投保人实名认证 | packages/example-app-aspects/ |
| example-app-app `aspects` | 端核对、furion-check | 端核对数据上报 | packages/example-app-aspects/ |

### 身份核验/安全

| 仓库 | 关键词 | 说明 | 代码入口 |
|------|-------|------|---------|
| example-bff `common` | 身份核验、核身 | 标准/密码/短信/人脸/安全策略核身 | src/modules/common/ |
| example-bff `common` | 数据脱敏 | 通用工具-数据脱敏 | src/modules/common/ |

### 营销

| 仓库 | 关键词 | 说明 | 代码入口 |
|------|-------|------|---------|
| — | 非减收券、保费抵扣券、非减收 | 出资方非保主体的保费抵扣券。核销场景：商险月缴续期、年缴续保、体验版预约单商转。详见 cross-repo-links.md | — |
| example-bff `marketing` | 不记名投保、进阶投保卡片、团购预约、已购产品查询、家庭组合投保 | BFF 营销模块 | src/modules/marketing/ |

### 中间件/基础设施

| 仓库 | 关键词 | 说明 | 代码入口 |
|------|-------|------|---------|
| example-bff `middleware` | 全链路追踪、businessFlow、预加载、prefetch、MGW网关 | BFF 中间件：业务流程追踪+预加载+网关包装 | src/modules/middleware/ |
| example-bff | RPC调用、oneapi、DRM配置 | RPC/OneAPI 调用方式+动态规则管理 | — |
| example-bff `common` | BaseController、BaseService、文件上传 | 基类封装+文件上传服务 | src/modules/common/ |

### 动态注入组件（BFF侧）

| 仓库 | 关键词 | 说明 | 代码入口 |
|------|-------|------|---------|
| example-bff `example-app` | 安心赔、金选标签、增信标签、产品标签、产品卡片、跑马灯、头图横幅 | BFF 动态注入组件（platform下发） | src/modules/example-app/ |

### 退保/续保/草稿

| 仓库 | 关键词 | 说明 | 代码入口 |
|------|-------|------|---------|
| example-bff `example-app` | 退保 | 退保流程 BFF | src/modules/example-app/ |
| example-app-app `aspects` | 续保页切面 | 续保页切面 | packages/example-app-aspects/ |
| example-bff `example-app` | 暂存草稿、ApplicationSaved | 暂存投保方案（确认页触发，有前端交互）。⚠️ ≠草稿库（后端存储，无前端交互），两者是不同功能、不同接口 | src/ |
| example-bff `example-app` | 草稿库、草稿箱 | 后端存储能力（无前端交互）。草稿库前置仅覆盖多被保人老/新样式；单被保人无交互点位不纳入（用户纠正）。⚠️ ≠暂存草稿（确认页触发，有前端交互） | src/ |

### 售卖场景/模式

| 仓库 | 关键词 | 说明 | 代码入口 |
|------|-------|------|---------|
| example-app-app | 体验版、TRIAL_INSURE | 体验版售卖模式。标识来源：URL 参数优先，其次后端 uiConfig | — |
| example-app-app | 极简版、SINGLE_PAGE_INSURE | 极简版售卖模式 | — |
| example-app-app | 商转商、CTC | 商转商售卖模式 | — |
| example-app-aspect-asset | 意外险 lite 版、组合投保 | 意外险 lite 版投保页，售卖场景=组合投保（combine-insure） | src/resources/pages/combine-insure/ |
| example-bff + example-app-app | 新投进阶、新投升级、advanceInsure | 投保页的售卖场景模式（insSaleScenarioType=advanceInsure），目前仅重疾。进阶页=投保页+advanceInsure+云梯组件 | src/modules/example-app/ |
| example-app-aspect-health | 重疾体验版、seriousIllnessGiftUnified | 健康险切面中的重疾体验版场景，赠转商双轨展示 | src/pages/ |
| sales-center + example-app-aspect-health | 可选责任、轻中症、LIABILITY、赠转商可选责任 | 赠转商可选责任通过 B 端配置映射管理，前端数据驱动（有数据就展示） | — |

### 新投进阶/升级（云梯）组件

> 云梯项目：重疾险新投升级场景的 C 端组件群（5 ProCode + 4 LowCode）。通过 `useInsurePageContainer()` 共享 store，插槽协作。详见 `cross-repo-links.md`。
> **交费方式现状**（用户纠正）：新投页当前固定月交，无年交/月交选择。新增建议在云梯组件群中新建，不复用投保选项组件。

| 仓库 | 关键词 | 说明 | 代码入口 |
|------|-------|------|---------|
| 多仓库 | 云梯、新投进阶、升级投保 | 云梯项目组件群统称，详见 cross-repo-links.md | — |
| example-app-insure-insadvance-upgrade-video-explanation | 险种教育视频、升级讲解视频、云梯视频 | 视频/图片形式的险种教育讲解。通过 Slot.Portal 注入 ragdoll 在保产品卡。⚠️ 非投保页通用视频组件（components-insure-common-video） | src/ |
| example-app-insure-insadvance-illness-planselect | 多套餐选择、计划选择、保额切换 | 投保计划/保额切换，含准入校验（insurePlanAccessInfo） | src/ |
| example-app-insure-insadvance-upgrade-package-config | 升级套餐头部、头部Banner | 头部横幅，展示产品标题+头图 | src/ |
| example-app-insure-insdavance-ensure-detail | 进阶保障详情、保障责任列表 | 保障责任+保障规则+生效时间。提供多个插槽。⚠️ 仓库名 insdavance（少 a）是拼写变体 | src/ |
| example-app-insure-insdavance-placeholder | 进阶占位、升级单创建、insAdvancePlaceholder | 核心协调组件：创建升级单、注入询价切面、管理 advanceInsureFormData。⚠️ 是云梯流程入口 | src/ |
| ragdoll-example-app-insure-insadvance-insurance-card | 云梯在保产品卡 | LowCode 在保产品卡片，提供 advantage 插槽（ragdoll 平台管理） | — |
| ragdoll-example-app-insure-insadvance-upgrade-illness-header | 云梯重疾头图 | LowCode 重疾险头图组件（ragdoll 平台管理） | — |
| ragdoll-example-app-insure-insadvance-upgrade-header | 云梯新投头图 | LowCode 新投升级头图组件（ragdoll 平台管理） | — |
| ragdoll-example-app-insure-insadvance-upgrade-advantage | 云梯升级优势 | LowCode 升级优势展示组件（ragdoll 平台管理） | — |

### 增值服务（BFF侧）

| 仓库 | 关键词 | 说明 | 代码入口 |
|------|-------|------|---------|
| example-bff `example-app` | 管家服务、云客服、支小宝划词、保司增信、VIP黑卡、试算服务、提额工单 | BFF 增值服务模块 | src/modules/example-app/ |

### 行业切面（MF 应用）

| 仓库 | 关键词 | 说明 | 代码入口 |
|------|-------|------|---------|
| example-app-aspect-asset | 组合投保、combine-insure、家庭单、算法推荐 | 资产/财险切面，组合投保页核心逻辑。⚠️「资产」指资产险/财险品类，非金融资产 | src/resources/pages/combine-insure/ |
| example-app-aspect-health | 健康险切面、dual-insure、健康告知、赠转商、适当性评估 | 健康险专属切面 MF。核心页面 dual-insure（投保确认页）。⚠️ ≠example-app-aspects（通用切面，对所有险种生效） | src/pages/ |

---

## 跨仓库关联

### 投保链路
```
example-app-app(投保页组件) --调用--> example-bff(投保BFF接口) --配置--> sales-center(产品分流)
```

### 确认提交链路
```
example-app-app(确认页组件) --调用--> example-bff(创建交易单/投保提交) --调用--> 后端核保/出单服务
```

### 页面参数链路
```
example-app-app(URL参数解析) --传递--> example-bff(参数透传) --查询--> sales-center(分流规则)
```

### 预加载链路
```
example-app-app(CSR缓存) --prefetch--> example-bff(prefetch中间件) --调用--> 后端RPC服务
```

### 切面注入链路
```
example-app-app(切面加载器) --before/after--> example-app-app(页面容器生命周期) --调用--> example-bff(核身/轨迹等接口)
```

### 动态组件链路
```
example-app-app(组件渲染) <--UI配置下发-- example-bff(动态注入服务) <--数据加载-- 后端服务
```

### platform SPI 校验链路
```
insiopweb(运营保存页面) --Hessian RPC--> inslightbuildbff(InsIopPageRuleSpiFacade.checkPageRule) --返回--> SUCCESS/WARN+alarmMsg
```

### platform组件管理链路
```
example-app-studio(组件元信息管理) --HTTP API--> inslightbuildbff(组件BFF) --RPC--> inssaleportal(售卖后台) + insiopmng(platform后台)
```

---

### sales-center 管理模块

| 仓库 | 关键词 | 说明 | 代码入口 |
|------|-------|------|---------|
| sales-center | 能力管理、能力模板运维、产品能力运维 | 能力管理运维页面 | src/pages/AbilityManagement |
| sales-center | 能力模板、能力列表、产品关联、流程编辑器 | 能力模板管理 | src/pages/AbilityTemplate |
| sales-center | 组件管理、组件规则、组件预览、Schema编辑 | 组件管理模块 | src/pages/Component |
| sales-center | 保障方案配置、投保计划配置 | 保险保障方案配置，投保计划配置入口 | src/pages/Insurance |
| sales-center `Operation` | 赠转商配置、售卖配置、投放方案配置、责任配置 | 赠转商**售卖技术配置**（非运营配置）。管理两品关联关系。⚠️ 当前责任配置仅为文案配置 | src/pages/Operation |
| sales-center `ProductGroup` | 产品组管理、版本管理 | 产品组分流管理。3 Tab：产品组分流/售卖模式分流/页面分流 | src/pages/ProductGroup |
| sales-center | 产品组创建/编辑、产品清单、产品简称、多品展示 | 产品组弹窗组件（被 ProductGroup 和 SplitStrategy 复用） | src/components/CreateProductGroupModal |
| sales-center | 产品组渠道、DEFAULT、INSURANCE_PLATFORM | 投放渠道枚举 | src/constants/productGroup.ts |
| sales-center | 分流模式、SINGLE_PRODUCT、MULTI_PRODUCT | 分流模式枚举。仅默认渠道可选 | src/constants/productGroup.ts |
| sales-center | 问卷活动、灰度发布、审批管理 | 问卷活动管理模块 | src/pages/QuestionnaireComponent |
| sales-center `SplitRule` | 分流规则配置、审批流程、执行记录 | 分流规则配置 | src/pages/SplitRule |
| sales-center `SplitStrategy` | 分流策略配置、按比例分流、环境推进 | 分流策略配置（5种类型） | src/pages/SplitStrategy/ |
| sales-center | 模板管理、页面模板、应用产品 | 模板管理模块 | src/pages/Template |
| sales-center `PurePanel` | 投保计划配置面板、套餐开关、算法推荐 | 投保计划配置面板（被保障方案配置和赠转商配置复用）。⚠️ C 端投保选项取自此配置的后端下发数据（用户纠正） | src/pages/PurePanel/index.tsx |
| sales-center | 投保套餐配置、套餐排序、套餐卖点 | 投保套餐配置（仅 INSMERCHANT 场景） | src/pages/PurePanel/PackagePanel |
| sales-center | 售卖模式配置、售卖模式版本 | 售卖模式配置管理 | src/pages/SalesMode |
| sales-center | 页面分流、页面产品组 | 页面分流列表管理 | src/pages/PageProductGroup |
| sales-center | 流程引擎元素、流程引擎管理 | 流程引擎元素定义+管理页面 | src/pages/ProcessEngineElement |
| sales-center | 白名单配置 | 白名单配置管理 | src/pages/WhiteListConfig |

### example-app-studio + inslightbuildbff

> example-app-studio 是售卖域自有的组件元信息管理+发布审核 B 端平台。inslightbuildbff 是其 BFF，同时通过 SPI 为platform(insiopweb)提供页面保存校验。⚠️ example-app-studio ≠ platform(insiopweb) ≠ sales-center（用户纠正）

| 仓库 | 关键词 | 说明 | 代码入口 |
|------|-------|------|---------|
| inslightbuildbff | platformSPI、checkPageRule、页面保存校验、SPI规则 | **platform保存时校验的 SPI 入口**。Hessian RPC TR 控制器，platform(insiop)保存/发布页面配置时回调。返回 SUCCESS/WARN + alarmMsg。⚠️ 新增校验规则在此文件扩展 ruleParam switch | app/tr/InsIopPageRuleSpiFacade.ts |
| inslightbuildbff | SPI通用规则、insiopSpiRule、规则引擎 | SPI 通用规则集（cityUpdate、manifest、insurePlanAndLiability、productTags、insureProductChanger） | app/common/example-app/rule/index.ts |
| inslightbuildbff | 组件管理、组件审批、组件流程 | 组件 CRUD + 审批工作流 | app/controller/example-app/component/index.ts |
| inslightbuildbff | 组件清单、manifest、checkPageRule（HTTP） | 组件清单管理、发布、HTTP 入口的 checkPageRule（转发到 insiop 后端） | app/controller/example-app/manifest.ts |
| inslightbuildbff | DRM配置、动态配置、checkPageRule白名单 | DRM 驱动的白名单/配置项（如 `checkPageRule`、`confirmGiftAddonInsureInsiopWhiteList`）。⚠️ 品维度校验开关也通过 DRM 配置 | DRM keys in SPI facade |
| inslightbuildbff | 组件Schema同步、config.schema | 从 devops 同步 config.schema 到 insiop | app/service/example-app/schema.ts |
| inslightbuildbff | 审批回调、流程回调、ComponentProcessCallback | 组件审批工作流回调（同意/拒绝/取消） | app/tr/ComponentProcessCallback.ts |
| example-app-studio | 组件元信息管理、售卖组件B端、统一售卖研发平台 | 售卖域自有 B 端平台：组件元信息管理、发布审核、清单管理。⚠️ ≠platform(insiopweb)运营搭建平台（用户纠正） | src/ |
| example-app-studio | 组件列表、组件管理前端、Assets | 组件管理页面（普通组件/多版本组件） | src/pages/Assets/ |
| example-app-studio | 组件详情、组件编辑、AssetDetail | 组件元数据编辑表单（含 Schema 编辑器） | src/pages/AssetDetail/ |
| example-app-studio | 组件清单V2、ManifestV2、清单发布 | 页面级组件清单管理。推进预发前调用 checkPageRule 校验 | src/pages/ManifestV2/ |
| example-app-studio | 发布审批、releaseApproval | 组件发布审批工作流 | src/pages/ReleaseApproval/ |
| example-app-studio | Schema编辑器、SchemaForm | 组件 config.schema 可视化编辑器（基于 morpho-schema-util） | src/components/SchemaForm/ |

#### platform SPI 已有规则（ruleParam 值）

| ruleParam | 校验内容 |
|-----------|---------|
| `checkProdComp` | 组件是否为测试/下线状态 |
| `checkCompNum` | 组件白名单+数量校验（DRM 驱动） |
| `advanceCheckCompNum` | 新投进阶页组件数量校验 |
| `platformServices` | 产品服务/保司信息组件排序 |
| `giftAtmosphere` | 赠险氛围组件校验 |
| `advanceInsure` | 新投进阶页必选/可选组件校验 |
| `insureConfirm` | 确认页组件排序规则 |
| `isPlanIdUnique` | 价格组件 planId 唯一性 |
| JSON 结构化规则 | `exactWithoutOrder` 组件集合校验 |

## 能力边界声明

> Agent 用于快速判定「新能力 vs 已有能力」。索引未命中时查本章节：若需求落在「不支持」范围内 → 立即判定为新能力，跳过深层查询。
>
> 维护规则：新能力上线后从「不支持」移到「已支持」；发现新的能力空白时补充到「不支持」。

### example-app-aspect-health（健康险切面）

| 已支持 | 不支持 |
|--------|--------|
| 赠转商（dual-insure）、健康告知、续保、暂存单、适当性评估、多被保人、电销、合规水位、险种配置、组件降级 | 多产品联合投保/套餐、跨品种健告合并、组合优惠定价、联合出单（多产品原子性） |

### example-app-aspect-asset（资产险切面）

| 已支持 | 不支持 |
|--------|--------|
| 家庭单组合投保（combine-insure，同类财险产品组合）、算法推荐、产品切换、交费方式、分组列表、二次确认、自动续费 | 跨险种组合（如健康险+财险）、套餐优惠定价 |

### example-app-app（C端主应用）

| 已支持 | 不支持 |
|--------|--------|
| 一级容器页面 15 个（9 独立入口 + 6 子页面）+ 非容器页面 12 个 + 切面页面 2 个 = 合计 29 个 | 多产品联合投保页、联合确认页、联合成功页 |
| 售卖模式：标准、体验版(TRIAL_INSURE)、极简版(SINGLE_PAGE_INSURE)、商转商(CTC) | 联合投保售卖模式 |

### example-bff（BFF层）

| 已支持 | 不支持 |
|--------|--------|
| 询价、投保提交、出单、准入校验、分流、预决策、健告决策、家庭组合投保(marketing) | 多产品联合询价、联合出单（原子性）、套餐优惠定价 |

### sales-center（B端管理）

| 已支持 | 不支持 |
|--------|--------|
| 5种分流策略、产品组管理、能力管理、组件管理、售卖配置(Operation)、模板管理、投保计划配置面板、售卖模式配置、页面分流、流程引擎管理、白名单配置 | 多产品绑定关系管理（跨产品组的联合配置） |

### inslightbuildbff（example-app-studio BFF + platform SPI）

| 已支持 | 不支持 |
|--------|--------|
| platform SPI 保存校验（9种 ruleParam）、组件管理/审批/发布、组件清单管理、Schema 同步、DRM 动态配置、流程引擎回调、自动化测试 | — |

### example-app-studio（售卖组件元信息管理 B 端）

| 已支持 | 不支持 |
|--------|--------|
| 组件 CRUD、组件清单(ManifestV2)、发布审批、Schema 编辑器、组件覆盖率指标 | 运营页搭建（在 insiopweb） |

---

## 知识覆盖状态

> 详见 `knowledge/README.md` 仓库列表。此处只记录结构性缺口。

| 仓库 | 结构性缺口 |
|------|---------|
| components-insure-common-insure-button | 无 .aima skill，靠 cross-repo-links 补充调用链 |
| example-app-aspect-asset / example-app-aspect-health | 仅 design.md，无 domain.md（业务语义缺失） |
