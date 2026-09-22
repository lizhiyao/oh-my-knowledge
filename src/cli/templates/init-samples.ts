import type { Lang } from '../../shared/language.js';
import type { Sample } from '../../eval-workflows/inputs/contracts/sample.js';
import { createWorkflowSampleSetDocument } from '../../eval-workflows/inputs/schemas/sample-set.js';

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
    input: { inputKind: 'text' as const, text: "审查以下代码\n\n```\nfunction authenticate(username, password) {\n  const query = `SELECT * FROM users WHERE name='${username}' AND pass='${password}'`;\n  return db.execute(query);\n}\n```" },
    reference: "function authenticate(username, password) {\n  const query = `SELECT * FROM users WHERE name='${username}' AND pass='${password}'`;\n  return db.execute(query);\n}",
    rubric: {
      security: { criterion: '是否准确识别 SQL 注入漏洞并说明攻击影响', weight: 0.5 },
      actionability: { criterion: '是否给出可直接采用的参数化查询修复', weight: 0.5 },
    },
    assertions: [
      { type: 'contains', value: 'SQL', weight: 1 },
    ],
    capability: ['security-review'],
    difficulty: 'easy',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's002',
    input: { inputKind: 'text' as const, text: "审查以下代码\n\n```\nasync function fetchData(url) {\n  const res = await fetch(url);\n  const data = await res.json();\n  return data;\n}\n```" },
    reference: 'async function fetchData(url) {\n  const res = await fetch(url);\n  const data = await res.json();\n  return data;\n}',
    rubric: {
      robustness: { criterion: '是否覆盖主要失败路径并区分错误来源', weight: 0.5 },
      actionability: { criterion: '是否给出完整且不过度复杂的修复方案', weight: 0.5 },
    },
    assertions: [
      { type: 'regex', pattern: 'try[\\s\\S]*catch|res\\.ok|status', flags: 'i', weight: 1 },
    ],
    capability: ['robustness-review'],
    difficulty: 'easy',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's003',
    input: { inputKind: 'text' as const, text: "审查以下代码\n\n```\nfunction renderComment(comment) {\n  document.getElementById('output').innerHTML = '<p>' + comment + '</p>';\n}\n```" },
    reference: "function renderComment(comment) {\n  document.getElementById('output').innerHTML = '<p>' + comment + '</p>';\n}",
    rubric: {
      security: { criterion: '是否准确识别 XSS 漏洞及其数据流', weight: 0.5 },
      actionability: { criterion: '是否给出安全且适配当前场景的渲染方式', weight: 0.5 },
    },
    assertions: [
      { type: 'contains', value: 'XSS', weight: 1 },
      { type: 'contains', value: 'innerHTML', weight: 0.5 },
    ],
    capability: ['security-review'],
    difficulty: 'easy',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's004',
    input: { inputKind: 'text' as const, text: "审查以下代码\n\n```\nimport { exec } from 'node:child_process';\n\nexport function archive(name) {\n  exec(`tar -czf ${name}.tgz uploads/${name}`);\n}\n```" },
    reference: "import { exec } from 'node:child_process';\n\nexport function archive(name) {\n  exec(`tar -czf ${name}.tgz uploads/${name}`);\n}",
    rubric: {
      security: { criterion: '是否识别出模板字符串进入 shell 的命令注入路径', weight: 0.5 },
      actionability: { criterion: '是否使用参数数组和输入约束消除注入面', weight: 0.5 },
    },
    assertions: [
      { type: 'regex', pattern: 'execFile|spawn', flags: 'i', weight: 1 },
    ],
    capability: ['security-review'],
    difficulty: 'medium',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's005',
    input: { inputKind: 'text' as const, text: "审查以下代码\n\n```\nimport { readFile } from 'node:fs/promises';\nimport { join } from 'node:path';\n\nexport async function download(req) {\n  return readFile(join('/srv/files', req.query.name));\n}\n```" },
    reference: "import { readFile } from 'node:fs/promises';\nimport { join } from 'node:path';\n\nexport async function download(req) {\n  return readFile(join('/srv/files', req.query.name));\n}",
    rubric: {
      security: { criterion: '是否识别编码、绝对路径和上级目录绕过风险', weight: 0.5 },
      actionability: { criterion: '是否给出基于解析后路径的边界校验', weight: 0.5 },
    },
    assertions: [
      { type: 'regex', pattern: 'resolve|normalize|relative', flags: 'i', weight: 1 },
    ],
    capability: ['security-review'],
    difficulty: 'hard',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's006',
    input: { inputKind: 'text' as const, text: "审查以下代码\n\n```\nexport async function findUser(db, email) {\n  return db.query('SELECT id, name FROM users WHERE email = ?', [email]);\n}\n```" },
    reference: "export async function findUser(db, email) {\n  return db.query('SELECT id, name FROM users WHERE email = ?', [email]);\n}",
    rubric: {
      precision: { criterion: '是否避免把安全的参数化查询误报为注入漏洞', weight: 0.5 },
      reasoning: { criterion: '是否区分确定缺陷、条件性风险和可选改进', weight: 0.5 },
    },
    capability: ['security-review'],
    difficulty: 'medium',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's007',
    input: { inputKind: 'text' as const, text: "审查以下代码\n\n```\nfunction displayName(user) {\n  return user.profile.name.trim();\n}\n```" },
    reference: 'function displayName(user) {\n  return user.profile.name.trim();\n}',
    rubric: {
      robustness: { criterion: '是否完整定位 user、profile、name 的空值边界', weight: 0.5 },
      actionability: { criterion: '是否给出默认值、显式校验或可选链的合理选择', weight: 0.5 },
    },
    capability: ['robustness-review'],
    difficulty: 'easy',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's008',
    input: { inputKind: 'text' as const, text: "审查以下代码\n\n```\nexport function loadConfig(raw) {\n  const config = JSON.parse(raw);\n  return config.database.host.toLowerCase();\n}\n```" },
    reference: "export function loadConfig(raw) {\n  const config = JSON.parse(raw);\n  return config.database.host.toLowerCase();\n}",
    rubric: {
      robustness: { criterion: '是否覆盖解析失败和解析成功但结构错误两类路径', weight: 0.5 },
      actionability: { criterion: '是否提供可定位字段问题的校验与错误信息', weight: 0.5 },
    },
    assertions: [
      { type: 'contains', value: 'JSON.parse', weight: 1 },
    ],
    capability: ['robustness-review'],
    difficulty: 'medium',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's009',
    input: { inputKind: 'text' as const, text: "审查以下代码\n\n```\nexport async function getProfile(id) {\n  for (;;) {\n    try {\n      return await fetch(`/profiles/${id}`).then(r => r.json());\n    } catch {}\n  }\n}\n```" },
    reference: 'export async function getProfile(id) {\n  for (;;) {\n    try {\n      return await fetch(`/profiles/${id}`).then(r => r.json());\n    } catch {}\n  }\n}',
    rubric: {
      robustness: { criterion: '是否覆盖无限循环、错误可观测性和服务放大效应', weight: 0.5 },
      actionability: { criterion: '是否给出上限、退避、超时和取消的完整策略', weight: 0.5 },
    },
    assertions: [
      { type: 'contains', value: 'AbortController', weight: 1 },
    ],
    capability: ['robustness-review'],
    difficulty: 'hard',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's010',
    input: { inputKind: 'text' as const, text: "审查以下代码\n\n```\nexport async function loadUser(id, signal) {\n  const res = await fetch(`/users/${encodeURIComponent(id)}`, { signal });\n  if (!res.ok) throw new Error(`HTTP ${res.status}`);\n  return await res.json();\n}\n```" },
    reference: "export async function loadUser(id, signal) {\n  const res = await fetch(`/users/${encodeURIComponent(id)}`, { signal });\n  if (!res.ok) throw new Error(`HTTP ${res.status}`);\n  return await res.json();\n}",
    rubric: {
      precision: { criterion: '是否避免否定代码已经具备的健壮性措施', weight: 0.5 },
      reasoning: { criterion: '是否把确定事实与依赖业务上下文的增强建议分开', weight: 0.5 },
    },
    capability: ['robustness-review'],
    difficulty: 'medium',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's011',
    input: { inputKind: 'text' as const, text: "审查以下代码\n\n```\nfunction shippingFee(weight) {\n  if (weight > 30) return 999;\n  return weight * 7.35 + 12;\n}\n```" },
    reference: 'function shippingFee(weight) {\n  if (weight > 30) return 999;\n  return weight * 7.35 + 12;\n}',
    rubric: {
      maintainability: { criterion: '是否解释 30、999、7.35、12 的语义和变更风险', weight: 0.5 },
      actionability: { criterion: '是否给出命名、单位和规则归位的具体方案', weight: 0.5 },
    },
    capability: ['maintainability-review'],
    difficulty: 'easy',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's012',
    input: { inputKind: 'text' as const, text: "审查以下代码\n\n```\nfunction createUser(input) {\n  if (!input.email.includes('@')) throw new Error('bad email');\n  return db.users.insert(input);\n}\nfunction updateUser(input) {\n  if (!input.email.includes('@')) throw new Error('bad email');\n  return db.users.update(input);\n}\n```" },
    reference: "function createUser(input) {\n  if (!input.email.includes('@')) throw new Error('bad email');\n  return db.users.insert(input);\n}\nfunction updateUser(input) {\n  if (!input.email.includes('@')) throw new Error('bad email');\n  return db.users.update(input);\n}",
    rubric: {
      maintainability: { criterion: '是否识别重复逻辑与未来规则不一致的风险', weight: 0.5 },
      actionability: { criterion: '是否提出职责清晰、易测试且不过度抽象的重构', weight: 0.5 },
    },
    capability: ['maintainability-review'],
    difficulty: 'medium',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's013',
    input: { inputKind: 'text' as const, text: "审查以下代码\n\n```\nexport async function completeOrder(order, user) {\n  if (!user.admin && user.id !== order.userId) throw new Error('forbidden');\n  order.status = 'complete';\n  await db.orders.save(order);\n  await mail.send(user.email, renderReceipt(order));\n  metrics.increment('orders.complete');\n  return JSON.stringify(order);\n}\n```" },
    reference: "export async function completeOrder(order, user) {\n  if (!user.admin && user.id !== order.userId) throw new Error('forbidden');\n  order.status = 'complete';\n  await db.orders.save(order);\n  await mail.send(user.email, renderReceipt(order));\n  metrics.increment('orders.complete');\n  return JSON.stringify(order);\n}",
    rubric: {
      maintainability: { criterion: '是否识别职责耦合以及失败时产生的部分完成状态', weight: 0.5 },
      actionability: { criterion: '是否在拆分职责的同时保留事务和副作用顺序', weight: 0.5 },
    },
    capability: ['maintainability-review'],
    difficulty: 'hard',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's014',
    input: { inputKind: 'text' as const, text: "审查以下代码\n\n```\nfunction renderReport(data, compact, includeHeader, sortDescending, useUtc) {\n  // formatting logic\n}\n```" },
    reference: 'function renderReport(data, compact, includeHeader, sortDescending, useUtc) {\n  // formatting logic\n}',
    rubric: {
      maintainability: { criterion: '是否解释调用点可读性和新增选项时的演进问题', weight: 0.5 },
      actionability: { criterion: '是否给出类型明确且可兼容默认值的参数设计', weight: 0.5 },
    },
    assertions: [
      { type: 'contains', value: 'options', weight: 1 },
    ],
    capability: ['maintainability-review'],
    difficulty: 'medium',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's015',
    input: { inputKind: 'text' as const, text: "审查以下代码\n\n```\nexport function clamp(value, min, max) {\n  return Math.min(max, Math.max(min, value));\n}\n```" },
    reference: 'export function clamp(value, min, max) {\n  return Math.min(max, Math.max(min, value));\n}',
    rubric: {
      precision: { criterion: '是否避免为了展示审查深度而虚构维护性问题', weight: 0.5 },
      proportionality: { criterion: '建议的复杂度是否与这个小型纯函数相称', weight: 0.5 },
    },
    capability: ['maintainability-review'],
    difficulty: 'easy',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's016',
    input: { inputKind: 'text' as const, text: "审查以下代码\n\n```\nexport async function listOrders(users) {\n  const rows = [];\n  for (const user of users) {\n    rows.push(...await db.orders.findByUser(user.id));\n  }\n  return rows;\n}\n```" },
    reference: 'export async function listOrders(users) {\n  const rows = [];\n  for (const user of users) {\n    rows.push(...await db.orders.findByUser(user.id));\n  }\n  return rows;\n}',
    rubric: {
      performance: { criterion: '是否识别查询次数和串行延迟随用户数增长的问题', weight: 0.5 },
      actionability: { criterion: '是否给出符合数据库边界的批量读取方案', weight: 0.5 },
    },
    assertions: [
      { type: 'contains', value: 'N+1', weight: 1 },
    ],
    capability: ['performance-review'],
    difficulty: 'easy',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's017',
    input: { inputKind: 'text' as const, text: "审查以下代码\n\n```\nexport async function hydrate(ids) {\n  const result = [];\n  for (const id of ids) {\n    result.push(await fetch(`/items/${id}`).then(r => r.json()));\n  }\n  return result;\n}\n```" },
    reference: 'export async function hydrate(ids) {\n  const result = [];\n  for (const id of ids) {\n    result.push(await fetch(`/items/${id}`).then(r => r.json()));\n  }\n  return result;\n}',
    rubric: {
      performance: { criterion: '是否同时看见串行瓶颈和无界并发的反向风险', weight: 0.5 },
      actionability: { criterion: '是否给出可调并发度、错误策略和顺序语义', weight: 0.5 },
    },
    assertions: [
      { type: 'contains', value: 'Promise.all', weight: 1 },
    ],
    capability: ['performance-review'],
    difficulty: 'medium',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's018',
    input: { inputKind: 'text' as const, text: "审查以下代码\n\n```\nfunction commonIds(left, right) {\n  return left.filter(item => right.some(other => other.id === item.id));\n}\n```" },
    reference: 'function commonIds(left, right) {\n  return left.filter(item => right.some(other => other.id === item.id));\n}',
    rubric: {
      performance: { criterion: '是否准确分析时间复杂度而不是泛泛声称性能差', weight: 0.5 },
      actionability: { criterion: '是否根据唯一性和内存取舍选择合适索引结构', weight: 0.5 },
    },
    assertions: [
      { type: 'regex', pattern: 'Set|Map', weight: 1 },
    ],
    capability: ['performance-review'],
    difficulty: 'hard',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's019',
    input: { inputKind: 'text' as const, text: "审查以下代码\n\n```\nconst cache = new Map();\nexport async function resolveTenant(id) {\n  if (!cache.has(id)) cache.set(id, await loadTenant(id));\n  return cache.get(id);\n}\n```" },
    reference: 'const cache = new Map();\nexport async function resolveTenant(id) {\n  if (!cache.has(id)) cache.set(id, await loadTenant(id));\n  return cache.get(id);\n}',
    rubric: {
      performance: { criterion: '是否覆盖内存增长与并发 cache miss 两个独立问题', weight: 0.5 },
      actionability: { criterion: '是否给出与数据新鲜度和容量约束匹配的缓存策略', weight: 0.5 },
    },
    capability: ['performance-review'],
    difficulty: 'hard',
    construct: 'quality',
    provenance: 'llm-generated',
  },
  {
    sample_id: 's020',
    input: { inputKind: 'text' as const, text: "审查以下代码\n\n```\nexport function indexById(items) {\n  const index = new Map();\n  for (const item of items) index.set(item.id, item);\n  return index;\n}\n```" },
    reference: 'export function indexById(items) {\n  const index = new Map();\n  for (const item of items) index.set(item.id, item);\n  return index;\n}',
    rubric: {
      precision: { criterion: '是否避免把正常的 O(n) 工作误报为性能缺陷', weight: 0.5 },
      reasoning: { criterion: '是否把重复键语义作为条件性业务问题而非确定 bug', weight: 0.5 },
    },
    capability: ['performance-review'],
    difficulty: 'medium',
    construct: 'quality',
    provenance: 'llm-generated',
  },
];

/**
 * 起步用例的英文文案覆盖表。键是 `<sample_id>:<rubric 维度>`。
 *
 * 只覆盖文字：代码、`reference`、断言、能力标签、难度与出处都跟中文版共用，
 * 因此两种语言的样本测的是同一个构造，差别只在读者读到的那句话。
 * 少一条键就在序列化时抛错，避免英文用户静默拿到半中半英的用例集。
 */
const INIT_SAMPLE_EN_ASK = 'Review the following code';
const INIT_SAMPLE_EN_CRITERION: Record<string, string> = {
  's001:security': 'Does it accurately identify the SQL injection vulnerability and explain the attack impact',
  's001:actionability': 'Does it provide a parameterized-query fix that can be applied directly',
  's002:robustness': 'Does it cover the main failure paths and distinguish where each error comes from',
  's002:actionability': 'Does it give a complete fix without over-engineering',
  's003:security': 'Does it accurately identify the XSS vulnerability and its data flow',
  's003:actionability': 'Does it render safely in a way that fits the current scenario',
  's004:security': 'Does it spot the command-injection path where a template string reaches a shell',
  's004:actionability': 'Does it remove the injection surface using an argument array and input constraints',
  's005:security': 'Does it identify encoding, absolute-path and parent-directory traversal risks',
  's005:actionability': 'Does it validate boundaries against the resolved path',
  's006:precision': 'Does it avoid flagging a safe parameterized query as an injection vulnerability',
  's006:reasoning': 'Does it separate definite defects, conditional risks and optional improvements',
  's007:robustness': 'Does it locate the null boundaries of user, profile and name completely',
  's007:actionability': 'Does it choose sensibly between a default value, explicit validation and optional chaining',
  's008:robustness': 'Does it cover both parse failure and input that parses but is structurally wrong',
  's008:actionability': 'Does it validate and report errors precisely enough to locate the offending field',
  's009:robustness': 'Does it cover infinite loops, error observability and the service amplification effect',
  's009:actionability': 'Does it give a complete strategy with caps, backoff, timeouts and cancellation',
  's010:precision': 'Does it avoid dismissing robustness measures the code already has',
  's010:reasoning': 'Does it separate established facts from suggestions that depend on business context',
  's011:maintainability': 'Does it explain the meaning and change risk of 30, 999, 7.35 and 12',
  's011:actionability': 'Does it propose concrete naming, units and where the rule belongs',
  's012:maintainability': 'Does it spot duplicated logic diverging from future rules',
  's012:actionability': 'Does it propose a refactor with clear responsibilities, easy testing and no over-abstraction',
  's013:maintainability': 'Does it spot coupled responsibilities and the partial-completion state left behind on failure',
  's013:actionability': 'Does it keep transaction boundaries and side-effect order while splitting responsibilities',
  's014:maintainability': 'Does it explain readability at the call site and the evolution cost of adding options',
  's014:actionability': 'Does it give a parameter design with an explicit type compatible with its default value',
  's015:precision': 'Does it avoid inventing maintainability problems just to look thorough',
  's015:proportionality': 'Is the suggested complexity proportionate to this small pure function',
  's016:performance': 'Does it spot query count and serial latency growing with the number of users',
  's016:actionability': 'Does it propose a batch read that fits the database boundary',
  's017:performance': 'Does it see both the serial bottleneck and the reverse risk of unbounded concurrency',
  's017:actionability': 'Does it give a tunable concurrency limit, error strategy and ordering semantics',
  's018:performance': 'Does it analyse time complexity accurately instead of vaguely claiming poor performance',
  's018:actionability': 'Does it choose an index structure based on uniqueness and memory trade-offs',
  's019:performance': 'Does it cover unbounded memory growth and concurrent cache misses as two separate problems',
  's019:actionability': 'Does it give a caching strategy that matches freshness and capacity constraints',
  's020:precision': 'Does it avoid flagging normal O(n) work as a performance defect',
  's020:reasoning': 'Does it treat duplicate-key semantics as a conditional business question rather than a definite bug',
};

function localizeInitSample(sample: Sample, lang: Lang): Sample {
  if (lang === 'zh') return sample;
  const rubric: NonNullable<Sample['rubric']> = {};
  for (const [dimension, entry] of Object.entries(sample.rubric ?? {})) {
    const key = `${sample.sample_id}:${dimension}`;
    const criterion = INIT_SAMPLE_EN_CRITERION[key];
    if (criterion === undefined) throw new Error(`init samples: missing English copy for ${key}`);
    rubric[dimension] = { ...entry, criterion };
  }
  const input = sample.input;
  if (input.inputKind !== 'text') {
    throw new Error(`init samples: no English copy for ${input.inputKind} input yet`);
  }
  return {
    ...sample,
    input: { ...input, text: INIT_SAMPLE_EN_ASK + input.text.slice(input.text.indexOf('\n\n')) },
    rubric,
  };
}

export function serializeInitSamples(count: InitSampleCount, lang: Lang = 'zh'): string {
  const samples = INIT_CURATED_SAMPLES.slice(0, count).map((sample) => localizeInitSample(sample, lang));
  return `${JSON.stringify(createWorkflowSampleSetDocument(samples), null, 2)}\n`;
}
