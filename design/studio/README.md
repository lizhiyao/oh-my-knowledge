# design/studio

Studio 视觉体系改进（Issue #1060）的**评审资产**：四张代表页与一套组件状态矩阵的静态 HTML 原型，加上目标规范提案与取证脚本。

## 边界

- 不是产品代码。不参与 `yarn build`、不进 npm 包（`package.json` 的 `files` 只有 `dist/`）、不被 `src/studio` 任何模块引用。
- 不代表功能已实现。全部数据为合成数据；每个稿件元素与现有能力的对应关系记在 [spec.md](./spec.md) 第五节。
- 不推翻 `src/studio/AGENTS.md`：产品页面只向 Next.js 收敛，本目录的手写 HTML 只服务评审。
- 当前实现基线的唯一正文是仓库根 [DESIGN.md](../../DESIGN.md)；本目录只写目标规范提案与实测依据，评审通过后才回写 DESIGN.md。

## 文件

| 文件 | 作用 |
|---|---|
| `index.html` | 评审索引与阅读顺序 |
| `observe.html` | Observe 对话阅读代表页 |
| `measure.html` | Measure 记录比较代表页 |
| `knowledge.html` | Knowledge 候选与原文核对代表页 |
| `report.html` | 报告详情代表页 |
| `states.html` | 组件六态与异常边界矩阵 |
| `tokens.css` | 目标与基线两套 token，`<html data-spec>` 切换 |
| `base.css` | 组件层，唯一实现，页面不得复制其声明 |
| `spec-switch.js` | 规范档切换（URL `?spec=` 优先，其次 localStorage） |
| `audit.js` | 页内自测：溢出、裁切、对比度、省略可达、焦点顺序 |
| `run-audit.sh` | 用本机 Chrome 无头模式逐视口、逐规范档取证 |
| `audit-summary.mjs` | 解析取证目录，打印结论表 |
| `spec.md` | 目标规范、入口映射、取舍记录、实现任务拆分 |

## 打开与取证

直接用浏览器打开任意 `.html`，无需安装、无需构建。加 `?audit=1` 看该页实测 JSON，加 `?spec=baseline` 看基线规范档。

```sh
sh design/studio/run-audit.sh                 # 可用 VIEWPORTS/PAGES/SPECS/OUT_DIR 收窄
node design/studio/audit-summary.mjs <输出目录>
```

`OUT_DIR` 默认是 `mktemp -d` 建的仓库外临时目录，取证产物不落进仓库。
