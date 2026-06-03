# Studio 视觉重构设计方案

## 目标

参考 AIMA Workspace 评测面板的视觉风格，重构 Studio 列表页和详情页。

## 参考截图

`/Users/fengqi/Downloads/5A1D6F0B-4A04-4AFA-B271-1110152A1916.png`

## 列表页（`/`）

### 顶部汇总条

```
┌─ 综合健康分(圆形) ─┬─ 健康体检 ─────┬─ 用例评测 ─────┬─ 生产观察 ─────┐
│       84          │ 通过/警告/失败  │ 通过率/均分    │ 调用成功率    │
│    综合健康        │ 暂无历史数据    │ 暂无历史数据    │ 暂无历史数据  │
└───────────────────┴───────────────┴───────────────┴──────────────┘
```

- 综合分：所有 skill 的加权平均（doctor pass-rate × 0.3 + eval score × 0.5 + observe rate × 0.2）
- 三卡片各自有小趋势区域（sparkline 或"暂无历史数据"）

### 提示条

> 以上为评测汇总指标，如需查看失败原因等明细，请在小灵 Agent 中执行 `omk studio` 启动本地评测工作台查看明细

### Skill 明细表

表格式，替代现有卡片式：

| Skill | 健康评测 | 安装位置 | 文件数 | 操作 |
|-------|---------|---------|--------|------|
| my-skill [L1] [官方] | 84 ████████░░ | OpenClaw | 6 | 查看源 |
| 描述文字... | | | | |

- 左侧：skill 名 + 标签（层级 L1-L4 / 官方）+ 描述
- 中间：健康评测分数 + 进度条
- 右侧：安装位置 badge + 文件数 + 操作链接
- 支持搜索和 L1/L2/L3/L4 筛选

### 颜色体系

- 主色：`#4f46e5`（品牌紫）
- 健康绿：`#22c55e`
- 警告黄：`#f59e0b`
- 错误红：`#ef4444`
- 背景：`#f8fafc`
- 卡片背景：`#ffffff`
- 边框：`#e2e8f0`

## 详情页（`/skills/<name>`）

### 已有（保留）

- 趋势图（三线 chart）
- Doctor section
- Eval section（失败 sample 详情）
- Observe section

### 新增

- 评测历史列表（已实现）

## 文件改动范围

- `src/renderer/skill-list-renderer.ts` — 整体重写
- `src/renderer/layout.ts` — 全局样式变量更新
- `src/renderer/skill-detail-renderer.ts` — 局部调整
- `src/server/skill-index.ts` — 可能需要新增汇总统计字段

## 实施建议

1. 先改 `layout.ts` 的 CSS 变量（颜色体系）
2. 再改列表页的 HTML 结构和样式
3. 最后微调详情页
4. 每步改完都重启 Studio 截图对比
