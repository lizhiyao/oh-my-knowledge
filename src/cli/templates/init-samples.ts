import type { Sample } from '../../eval-workflows/inputs/contracts/sample.js';
import { createEvalSampleSetDocument } from '../../eval-workflows/inputs/schemas/sample-set.js';

export const DEFAULT_INIT_SAMPLE_COUNT = 3 as const;
export const FULL_INIT_SAMPLE_COUNT = 20 as const;
export type InitSampleCount = typeof DEFAULT_INIT_SAMPLE_COUNT | typeof FULL_INIT_SAMPLE_COUNT;

/**
 * `omk init` 的官方分层起步样本包。
 *
 * 前 3 条是低成本 quickstart；完整 20 条按 security／robustness／maintainability／performance
 * 各 5 条分层，并保留 4 条无缺陷负例，避免把「多报问题」误当成更好的 code review。
 */
const INIT_CURATED_SAMPLES: Sample[] = [
  {
    sample_id: 's001',
    prompt: '审查以下代码',
    context: "function authenticate(username, password) {\n  const query = `SELECT * FROM users WHERE name='${username}' AND pass='${password}'`;\n  return db.execute(query);\n}",
    rubric: '满分标准：必须识别 SQL 注入风险、说明攻击影响、给出参数化查询修复，并标注合理的严重程度。',
    assertions: [
      { type: 'contains', value: 'SQL', weight: 1 },
    ],
    dimensions: {
      security: '是否准确识别 SQL 注入漏洞并说明攻击影响',
      actionability: '是否给出可直接采用的参数化查询修复',
    },
    capability: ['security-review'],
    difficulty: 'easy',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's002',
    prompt: '审查以下代码',
    context: 'async function fetchData(url) {\n  const res = await fetch(url);\n  const data = await res.json();\n  return data;\n}',
    rubric: '满分标准：必须覆盖网络异常、HTTP 错误状态和非 JSON 响应，并给出结构清晰的错误处理方案。',
    assertions: [
      { type: 'regex', pattern: 'try[\\s\\S]*catch|res\\.ok|status', flags: 'i', weight: 1 },
    ],
    dimensions: {
      robustness: '是否覆盖主要失败路径并区分错误来源',
      actionability: '是否给出完整且不过度复杂的修复方案',
    },
    capability: ['robustness-review'],
    difficulty: 'easy',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's003',
    prompt: '审查以下代码',
    context: "function renderComment(comment) {\n  document.getElementById('output').innerHTML = '<p>' + comment + '</p>';\n}",
    rubric: '满分标准：必须识别 XSS 风险、解释不可信输入如何进入 HTML，并建议 textContent 或可靠转义。',
    assertions: [
      { type: 'contains', value: 'XSS', weight: 1 },
      { type: 'contains', value: 'innerHTML', weight: 0.5 },
    ],
    dimensions: {
      security: '是否准确识别 XSS 漏洞及其数据流',
      actionability: '是否给出安全且适配当前场景的渲染方式',
    },
    capability: ['security-review'],
    difficulty: 'easy',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's004',
    prompt: '审查以下代码',
    context: "import { exec } from 'node:child_process';\n\nexport function archive(name) {\n  exec(`tar -czf ${name}.tgz uploads/${name}`);\n}",
    rubric: '满分标准：必须识别命令注入和参数边界问题，说明 shell 拼接风险，并给出不经 shell 的参数化调用方案。',
    assertions: [
      { type: 'regex', pattern: 'execFile|spawn', flags: 'i', weight: 1 },
    ],
    dimensions: {
      security: '是否识别出模板字符串进入 shell 的命令注入路径',
      actionability: '是否使用参数数组和输入约束消除注入面',
    },
    capability: ['security-review'],
    difficulty: 'medium',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's005',
    prompt: '审查以下代码',
    context: "import { readFile } from 'node:fs/promises';\nimport { join } from 'node:path';\n\nexport async function download(req) {\n  return readFile(join('/srv/files', req.query.name));\n}",
    rubric: '满分标准：必须识别目录穿越风险，解释简单 join 不能建立目录边界，并给出规范化后校验根目录的修复。',
    assertions: [
      { type: 'regex', pattern: 'resolve|normalize|relative', flags: 'i', weight: 1 },
    ],
    dimensions: {
      security: '是否识别编码、绝对路径和上级目录绕过风险',
      actionability: '是否给出基于解析后路径的边界校验',
    },
    capability: ['security-review'],
    difficulty: 'hard',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's006',
    prompt: '审查以下代码',
    context: "export async function findUser(db, email) {\n  return db.query('SELECT id, name FROM users WHERE email = ?', [email]);\n}",
    rubric: '满分标准：应确认参数化查询已经隔离输入；可以提出有依据的次要建议，但不得虚构 SQL 注入漏洞。',
    dimensions: {
      precision: '是否避免把安全的参数化查询误报为注入漏洞',
      reasoning: '是否区分确定缺陷、条件性风险和可选改进',
    },
    capability: ['security-review'],
    difficulty: 'medium',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's007',
    prompt: '审查以下代码',
    context: 'function displayName(user) {\n  return user.profile.name.trim();\n}',
    rubric: '满分标准：必须识别空值链路导致的运行时异常，说明哪些对象可能缺失，并给出契合业务语义的防御方案。',
    dimensions: {
      robustness: '是否完整定位 user、profile、name 的空值边界',
      actionability: '是否给出默认值、显式校验或可选链的合理选择',
    },
    capability: ['robustness-review'],
    difficulty: 'easy',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's008',
    prompt: '审查以下代码',
    context: "export function loadConfig(raw) {\n  const config = JSON.parse(raw);\n  return config.database.host.toLowerCase();\n}",
    rubric: '满分标准：必须区分 JSON 语法错误与结构不符合预期两类失败，并建议在使用前进行清晰的 schema 校验。',
    assertions: [
      { type: 'contains', value: 'JSON.parse', weight: 1 },
    ],
    dimensions: {
      robustness: '是否覆盖解析失败和解析成功但结构错误两类路径',
      actionability: '是否提供可定位字段问题的校验与错误信息',
    },
    capability: ['robustness-review'],
    difficulty: 'medium',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's009',
    prompt: '审查以下代码',
    context: 'export async function getProfile(id) {\n  for (;;) {\n    try {\n      return await fetch(`/profiles/${id}`).then(r => r.json());\n    } catch {}\n  }\n}',
    rubric: '满分标准：必须识别无限重试、吞掉错误、缺少超时与退避等问题，并给出有上限且可取消的重试策略。',
    assertions: [
      { type: 'contains', value: 'AbortController', weight: 1 },
    ],
    dimensions: {
      robustness: '是否覆盖无限循环、错误可观测性和服务放大效应',
      actionability: '是否给出上限、退避、超时和取消的完整策略',
    },
    capability: ['robustness-review'],
    difficulty: 'hard',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's010',
    prompt: '审查以下代码',
    context: "export async function loadUser(id, signal) {\n  const res = await fetch(`/users/${encodeURIComponent(id)}`, { signal });\n  if (!res.ok) throw new Error(`HTTP ${res.status}`);\n  return await res.json();\n}",
    rubric: '满分标准：应认可现有编码、取消和状态检查；可指出 JSON 契约校验是条件性增强，但不得声称完全缺少错误处理。',
    dimensions: {
      precision: '是否避免否定代码已经具备的健壮性措施',
      reasoning: '是否把确定事实与依赖业务上下文的增强建议分开',
    },
    capability: ['robustness-review'],
    difficulty: 'medium',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's011',
    prompt: '审查以下代码',
    context: 'function shippingFee(weight) {\n  if (weight > 30) return 999;\n  return weight * 7.35 + 12;\n}',
    rubric: '满分标准：必须指出业务魔数和单位不透明造成的维护风险，并建议用有领域含义的常量或配置表达规则。',
    dimensions: {
      maintainability: '是否解释 30、999、7.35、12 的语义和变更风险',
      actionability: '是否给出命名、单位和规则归位的具体方案',
    },
    capability: ['maintainability-review'],
    difficulty: 'easy',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's012',
    prompt: '审查以下代码',
    context: "function createUser(input) {\n  if (!input.email.includes('@')) throw new Error('bad email');\n  return db.users.insert(input);\n}\nfunction updateUser(input) {\n  if (!input.email.includes('@')) throw new Error('bad email');\n  return db.users.update(input);\n}",
    rubric: '满分标准：必须识别重复且薄弱的校验逻辑，说明规则漂移风险，并建议抽取单一、可测试的验证边界。',
    dimensions: {
      maintainability: '是否识别重复逻辑与未来规则不一致的风险',
      actionability: '是否提出职责清晰、易测试且不过度抽象的重构',
    },
    capability: ['maintainability-review'],
    difficulty: 'medium',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's013',
    prompt: '审查以下代码',
    context: "export async function completeOrder(order, user) {\n  if (!user.admin && user.id !== order.userId) throw new Error('forbidden');\n  order.status = 'complete';\n  await db.orders.save(order);\n  await mail.send(user.email, renderReceipt(order));\n  metrics.increment('orders.complete');\n  return JSON.stringify(order);\n}",
    rubric: '满分标准：必须识别授权、状态变更、持久化、通知、指标和序列化混在单函数中的耦合，并提出保留事务语义的拆分。',
    dimensions: {
      maintainability: '是否识别职责耦合以及失败时产生的部分完成状态',
      actionability: '是否在拆分职责的同时保留事务和副作用顺序',
    },
    capability: ['maintainability-review'],
    difficulty: 'hard',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's014',
    prompt: '审查以下代码',
    context: 'function renderReport(data, compact, includeHeader, sortDescending, useUtc) {\n  // formatting logic\n}',
    rubric: '满分标准：必须指出多个布尔位置参数难以理解和扩展，并建议使用命名 options 对象及合理默认值。',
    assertions: [
      { type: 'contains', value: 'options', weight: 1 },
    ],
    dimensions: {
      maintainability: '是否解释调用点可读性和新增选项时的演进问题',
      actionability: '是否给出类型明确且可兼容默认值的参数设计',
    },
    capability: ['maintainability-review'],
    difficulty: 'medium',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's015',
    prompt: '审查以下代码',
    context: 'export function clamp(value, min, max) {\n  return Math.min(max, Math.max(min, value));\n}',
    rubric: '满分标准：应认可实现对普通数值输入足够简洁；可以询问 min 大于 max 或 NaN 的业务约定，但不得强行引入复杂架构。',
    dimensions: {
      precision: '是否避免为了展示审查深度而虚构维护性问题',
      proportionality: '建议的复杂度是否与这个小型纯函数相称',
    },
    capability: ['maintainability-review'],
    difficulty: 'easy',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's016',
    prompt: '审查以下代码',
    context: 'export async function listOrders(users) {\n  const rows = [];\n  for (const user of users) {\n    rows.push(...await db.orders.findByUser(user.id));\n  }\n  return rows;\n}',
    rubric: '满分标准：必须识别循环内逐用户查询形成的 N+1 和串行等待，并建议批量查询或有边界的并发方案。',
    assertions: [
      { type: 'contains', value: 'N+1', weight: 1 },
    ],
    dimensions: {
      performance: '是否识别查询次数和串行延迟随用户数增长的问题',
      actionability: '是否给出符合数据库边界的批量读取方案',
    },
    capability: ['performance-review'],
    difficulty: 'easy',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's017',
    prompt: '审查以下代码',
    context: 'export async function hydrate(ids) {\n  const result = [];\n  for (const id of ids) {\n    result.push(await fetch(`/items/${id}`).then(r => r.json()));\n  }\n  return result;\n}',
    rubric: '满分标准：必须指出无依赖请求被串行化的延迟问题，同时说明无限 Promise.all 的压力，并给出受控并发方案。',
    assertions: [
      { type: 'contains', value: 'Promise.all', weight: 1 },
    ],
    dimensions: {
      performance: '是否同时看见串行瓶颈和无界并发的反向风险',
      actionability: '是否给出可调并发度、错误策略和顺序语义',
    },
    capability: ['performance-review'],
    difficulty: 'medium',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's018',
    prompt: '审查以下代码',
    context: 'function commonIds(left, right) {\n  return left.filter(item => right.some(other => other.id === item.id));\n}',
    rubric: '满分标准：必须识别双层扫描的时间复杂度，说明数据规模前提，并建议用 Set 或 Map 建立线性查找索引。',
    assertions: [
      { type: 'regex', pattern: 'Set|Map', weight: 1 },
    ],
    dimensions: {
      performance: '是否准确分析时间复杂度而不是泛泛声称性能差',
      actionability: '是否根据唯一性和内存取舍选择合适索引结构',
    },
    capability: ['performance-review'],
    difficulty: 'hard',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's019',
    prompt: '审查以下代码',
    context: 'const cache = new Map();\nexport async function resolveTenant(id) {\n  if (!cache.has(id)) cache.set(id, await loadTenant(id));\n  return cache.get(id);\n}',
    rubric: '满分标准：必须识别多租户键空间下缓存无限增长和并发重复加载风险，并给出容量、淘汰与请求合并策略。',
    dimensions: {
      performance: '是否覆盖内存增长与并发 cache miss 两个独立问题',
      actionability: '是否给出与数据新鲜度和容量约束匹配的缓存策略',
    },
    capability: ['performance-review'],
    difficulty: 'hard',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's020',
    prompt: '审查以下代码',
    context: 'export function indexById(items) {\n  const index = new Map();\n  for (const item of items) index.set(item.id, item);\n  return index;\n}',
    rubric: '满分标准：应认可这是清晰的线性构建过程；可以说明重复 id 的覆盖语义，但不得虚构嵌套循环或明显性能瓶颈。',
    dimensions: {
      precision: '是否避免把正常的 O(n) 工作误报为性能缺陷',
      reasoning: '是否把重复键语义作为条件性业务问题而非确定 bug',
    },
    capability: ['performance-review'],
    difficulty: 'medium',
    construct: 'quality',
    provenance: 'llm-generated',
  },
];

export function serializeInitSamples(count: InitSampleCount): string {
  return `${JSON.stringify(createEvalSampleSetDocument(INIT_CURATED_SAMPLES.slice(0, count)), null, 2)}\n`;
}
