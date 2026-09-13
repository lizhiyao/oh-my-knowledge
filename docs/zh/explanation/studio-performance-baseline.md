# Studio 性能基线

本页记录 Studio HTTP 表面的容量基线（issue #836 §1.2）：三档代表性数据集规模、冷／热查询耗时、目录扫描成本、响应体积、并发下的事件循环延迟，以及由实测数据得出的优化决策。

测量于 2026-09-11，单机、`codex/836-studio-runtime-arch` 分支。复现命令：

```bash
yarn studio:baseline
```

脚本（`scripts/studio-baseline.ts`）在临时目录合成满足 schema 校验的数据集，经真实 `createReportServer`（随机端口）测量并输出下表。数值只用于同机、同 commit 的前后对比，不做跨机绝对值对比。

## 规模定义

| 档位 | skill 数 | observe-health 报告 | doctor 报告 | inbox 条目（最新／文件数） |
| --- | ---: | ---: | ---: | ---: |
| small | 5 | 10 | 5 | 20 / 2 |
| medium | 30 | 60 | 20 | 300 / 10 |
| large | 100 | 200 | 60 | 3000 / 30 |

「冷」指服务启动后的首个请求（含首次目录扫描与索引构建）；只有 `/api/skills` 测冷启动，因为它承担索引构建。「热」指 5 次重复请求取最小值。

## 实测基线

### small（skills=5，analyses=10，doctor=5，inbox=20 条/2 份）

| 路由 | 冷 (ms) | 热 (ms，5 次取最小) | 响应体积 |
| --- | ---: | ---: | ---: |
| `GET /api/skills` | 33.7 | 4.1 | 24.1 KB |
| `GET /knowledge`（已退役） | — | 4.3 | 38.3 KB |
| `GET /api/observe-health` | — | 3.1 | 1.5 KB |
| `GET /observe/health`（已退役） | — | 3.3 | 47.9 KB |
| `GET /observe/health/obs-0009`（已退役） | — | 2.4 | 56.1 KB |
| `GET /observe/skill-trend/baseline-skill-000`（已退役） | — | 3.7 | 50.3 KB |
| `GET /api/observe-inbox` | — | 1.1 | 13.6 KB |
| `GET /observe/inbox`（已退役） | — | 5.2 | 699.1 KB |

冷 `/api/skills` 期间事件循环 p99 延迟：0.0 ms；24 并发 `GET /knowledge`（热）：墙钟 58.6 ms，事件循环 p99 11.1 ms。

### medium（skills=30，analyses=60，doctor=20，inbox=300 条/10 份）

| 路由 | 冷 (ms) | 热 (ms，5 次取最小) | 响应体积 |
| --- | ---: | ---: | ---: |
| `GET /api/skills` | 30.5 | 10.9 | 633.3 KB |
| `GET /knowledge`（已退役） | — | 9.4 | 44.7 KB |
| `GET /api/observe-health` | — | 9.6 | 8.9 KB |
| `GET /observe/health`（已退役） | — | 9.9 | 101.3 KB |
| `GET /observe/health/obs-0059`（已退役） | — | 4.4 | 98.0 KB |
| `GET /observe/skill-trend/baseline-skill-000`（已退役） | — | 9.6 | 107.1 KB |
| `GET /api/observe-inbox` | — | 3.6 | 205.2 KB |
| `GET /observe/inbox`（已退役） | — | 20.4 | 3.11 MB |

冷 `/api/skills` 期间事件循环 p99 延迟：0.0 ms；24 并发 `GET /knowledge`（热）：墙钟 233 ms，事件循环 p99 19.2 ms。

### large（skills=100，analyses=200，doctor=60，inbox=3000 条/30 份）

| 路由 | 冷 (ms) | 热 (ms，5 次取最小) | 响应体积 |
| --- | ---: | ---: | ---: |
| `GET /api/skills` | 137 | 54.5 | 5.94 MB |
| `GET /knowledge`（已退役） | — | 42.1 | 62.9 KB |
| `GET /api/observe-health` | — | 43.2 | 29.9 KB |
| `GET /observe/health`（已退役） | — | 43.7 | 251.2 KB |
| `GET /observe/health/obs-0199`（已退役） | — | 13.5 | 215.3 KB |
| `GET /observe/skill-trend/baseline-skill-000`（已退役） | — | 44.2 | 266.0 KB |
| `GET /api/observe-inbox` | — | 26.5 | 2.01 MB |
| `GET /observe/inbox`（已退役） | — | 132 | 17.03 MB |

冷 `/api/skills` 期间事件循环 p99 延迟：11.5 ms；24 并发 `GET /knowledge`（热）：墙钟 1031 ms，事件循环 p99 48.4 ms。

## 结论与决策

1. **`querySkillTrend` 是实测确认的 O(N²) 热点——已修复。** 原实现先 listAnalyses 全量解析所有 observe-health 报告，再逐条 loadAnalysis 重新扫描目录各读一次。实测热请求：10.5 ms（small）/ 215 ms（medium）/ 2344 ms（large）。修复后单遍扫描、每份报告只解析一次，语义不变（live 优先、卡片按 id 去重、最旧在前）。同条件复测：3.7 / 9.6 / 44.2 ms，large 档提升 53 倍。这是基线证实为必要的唯一优化；它是算法修复，不是新增缓存层。这三个复测数值取自已退役的 `/observe/skill-trend/*` HTML 路由；修复本身在 `application/knowledge-reports.ts` 的扫描层，与谁渲染无关，因此对 `/api/skill-trend/*` 仍然成立。
2. **响应体积随规模线性增长；暂不引入服务端分页。** `/observe/inbox` 在三档下分别为 0.7 / 3.1 / 17 MB，`/api/skills` 为 24 KB / 633 KB / 5.9 MB。Studio 是本地单用户工具，这些体积下的传输已包含在上表热耗时内，因此记录取舍而不行动。旧 HTML inbox 页面已在 #839 收口批次退役：表中三行 `/observe/inbox` 是退役前的测量，`yarn studio:baseline` 不再采集该路由，因此与重跑结果不可比。React 收件箱的分页／可视区域渲染按它自己的真实入口另行决定，不沿用已退役页面的口径。
3. **同步文件系统操作在该规模下可接受。** large 档 24 并发下事件循环 p99 ≤ 48.4 ms，冷索引构建 ≤ 11.5 ms。不引入异步 I/O 改写或 worker 卸载；若未来宿主改变并发模型，以本页数值为参照再评估。
4. **缓存指纹成本有界且可接受。** `/api/skills` 热耗时包含逐请求的元数据指纹重算（约 10 / 80 / 260 次文件 stat）与对缓存索引的 `structuredClone`。100 skill 时 54.5 ms 热耗时不足以证明文件监听或增量失效机制；有界 keyed LRU（容量 8）仍是全部机制，不引入无界 `Map<fingerprint, entry>`。此项同时闭环缓存批次遗留的「先测量元数据扫描成本再决定失效机制」。
5. **冷启动即一次全量扫描。** 三档分别为 33.7 / 30.5 / 137 ms——首个请求支付目录扫描与索引构建，后续请求复用。可接受，不加预热。

## 限制与后续

- HTML 版 `/knowledge` 页与观测健康四页（`/observe/health`、`/observe/health/:id`、`/observe/skill-trend/:skill`、`/observe/health-diff`）已删除：注册这些路由组的宿主都由 Next 接管对应路径，夹取驱动的独立 HTML 宿主不再服务它们。上表这些页面行与「24 并发 `GET /knowledge`（热）」都是退役前的数字；`yarn studio:baseline` 的并发探针改为 `GET /api/observe-health`——同一份目录扫描与投影，只是不带 HTML 序列化，因此与页面行的历史数值不可比。本脚本仍只覆盖独立 HTML 宿主：React 页面的首屏由 Next 渲染，其成本不在此产出。
- 脚本只测服务端。客户端首屏与泳道交互成本不在此产出；large 档 17 MB 的旧版 inbox HTML 是已知的客户端成本驱动，由 Next.js 迁移批次（可视区域渲染）处理，并经真实入口验证。
- 会话／任务列表页与 SSE 实时跟随不在本数据集基线内；其刷新、竞态与清理行为在数据流核验批次（issue #836 §1.1）验证。
- 绝对数值依赖机器与文件系统缓存；前后对比必须用同机、同 commit 的 `yarn studio:baseline`。
