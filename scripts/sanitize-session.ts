#!/usr/bin/env npx tsx
/**
 * Session 数据脱敏工具
 *
 * 合并 desensitize.mjs 与 sanitize-session.ts 的全部脱敏能力
 *
 * 脱敏内容：
 * ── 字段名黑名单（整值替换）──
 *   token 类: token, access_token, refresh_token, id_token, auth_token, session_token, bearer, jwt
 *   key/secret 类: apikey, api_key, secret, client_secret, app_secret, secret_key, private_key, signing_key, encryption_key 等
 *   密码类: password, passwd, pwd, passphrase
 *   认证类: authorization, cookie, set-cookie, x-auth-token, x-api-key, credential 等
 *   身份类: userid, user_id, uid, openid, unionid, idcard, id_card, identity, id_number, ssn, passport_no 等
 *   联系方式: phone, mobile, tel, telephone, email, mail 等
 *   地址类: address, addr, home_address, location
 *   银行/支付: bank_card, card_no, account_no, bank_account, alipay_id 等
 * ── 正则脱敏 ──
 *   邮箱 / 中国手机号 / 国际电话 / 中国固话 / 身份证 / 护照号
 *   支付宝 UID (2088xxxx) / 阿里云 AK (LTAIxxxx)
 *   银行卡号 / IPv4 / IPv6 / 用户路径 / 中文姓名 / 中文地址
 *   HTTP Authorization header / 长随机串 (hex32+, base64 40+)
 *   密钥/凭证字段 JSON 值
 *
 * 用法:
 *   npx tsx scripts/sanitize-session.ts <input.jsonl> [output.jsonl]
 *   npx tsx scripts/sanitize-session.ts <input-dir> [output-dir]
 *   npx tsx scripts/sanitize-session.ts --help
 */

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';

// ============ 类型定义 ============

interface CcSession {
  sessionId: string;
  sessionGroupId?: string;
  sessionGroupPath?: string;
  traceId?: string;
  traceRole?: 'standalone' | 'main' | 'subagent';
  traceLabel?: string;
  sourcePath: string;
  sourceKind?: 'claude' | 'openclaw' | 'markdown_log' | 'unknown';
  records: unknown[];
  cwd?: string;
  gitBranch?: string;
  entrypoint?: string;
  sourceMetadata?: TraceSourceMetadata;
  startTimestamp?: string;
  endTimestamp?: string;
}

interface TraceSourceMetadata {
  channel?: string;
  sender?: string;
  senderId?: string;
  provider?: string;
  model?: string;
  modelApi?: string;
  aimaCommands?: string[];
}

interface CcRecord {
  type: string;
  [key: string]: unknown;
}

// ============ 敏感字段名黑名单 ============

const SENSITIVE_KEYS = new Set([
  // token 类
  'token', 'access_token', 'accesstoken', 'refresh_token', 'refreshtoken',
  'id_token', 'idtoken', 'auth_token', 'authtoken', 'session_token', 'sessiontoken',
  'bearer', 'jwt',
  // key / secret 类
  'apikey', 'api_key', 'apitoken', 'api_token',
  'secret', 'client_secret', 'clientsecret', 'app_secret', 'appsecret',
  'secret_key', 'secretkey', 'secretid', 'secret_id',
  'private_key', 'privatekey', 'private_key_id',
  'signing_key', 'signingkey', 'encryption_key', 'encryptionkey',
  'accesskeyid', 'access_key_id', 'accesskeysecret', 'access_key_secret',
  // 密码类
  'password', 'passwd', 'pass', 'pwd', 'passphrase',
  // 认证 / 鉴权
  'authorization', 'auth', 'cookie', 'set-cookie', 'x-auth-token',
  'x-api-key', 'x-access-token', 'credential', 'credentials',
  // 身份
  'userid', 'user_id', 'uid', 'openid', 'open_id', 'unionid', 'union_id',
  'empid', 'emp_id', 'workno', 'work_no',
  'idcard', 'id_card', 'identity', 'id_number', 'idnumber', 'sfzh',
  'ssn', 'passport', 'passport_no', 'passportno',
  // 联系方式
  'phone', 'mobile', 'tel', 'telephone', 'cellphone', 'phonenumber', 'phone_number',
  'email', 'mail', 'emailaddress', 'email_address',
  // 地址
  'address', 'addr', 'home_address', 'homeaddress', 'location',
  // 银行 / 支付
  'bank_card', 'bankcard', 'card_no', 'cardno', 'card_number', 'cardnumber',
  'account_no', 'accountno', 'bank_account', 'bankaccount',
  'alipay', 'alipay_id', 'wechat_pay',
]);

// 路径类字段名 — 跳过长随机串正则（避免误脱敏文件路径中的 hash）
const PATH_LIKE_KEYS = new Set([
  'file_path', 'filepath', 'path', 'command', 'cmd',
  'cwd', 'dir', 'directory', 'source', 'dest', 'destination',
  'entrypoint', 'script', 'url', 'uri', 'href', 'src',
  'sourcepath', 'sessiongrouppath',
]);

// 跳过脱敏的字段名（时间戳等）
const SKIP_KEYS = new Set([
  'timestamp', 'starttimestamp', 'endtimestamp',
  'sessionid', 'sessiongroupid', 'traceid', 'traceid',
]);

// ============ Mock 值 ============

const MOCK = {
  userName: 'example-user',
  email: 'user@example.com',
  phone: '13800000000',
  address: '示例地址',
  gender: 'unknown',
  sender: '示例用户',
  senderId: 'example-sender-id',
  cwd: '/tmp/example/workspace',
  path: '/tmp/example/',
  alipayUid: '2088000000000000',
  aliyunAK: 'LTAI000000000000000000MOCK',
  credential: '***REDACTED***',
};

// ============ 正则脱敏规则 ============

interface PatternRule {
  re: RegExp;
  mask: (match: string) => string;
  name: string;
  skipForPathLike?: boolean;
}

function maskPhone(m: string): string {
  const digits = m.replace(/\D/g, '');
  if (digits.length >= 11) {
    return digits.slice(0, 3) + '****' + digits.slice(-4);
  }
  return m.slice(0, 3) + '****' + m.slice(-2);
}

function maskIdCard(m: string): string {
  return m.slice(0, 3) + '*'.repeat(m.length - 7) + m.slice(-4);
}

function maskEmail(m: string): string {
  const at = m.indexOf('@');
  if (at <= 0) return '***@' + m.slice(at + 1);
  return m.slice(0, 1) + '***' + m.slice(at);
}

function maskBankCard(m: string): string {
  const digits = m.replace(/\D/g, '');
  return digits.slice(0, 4) + ' **** **** ' + digits.slice(-4);
}

function maskLongToken(m: string): string {
  return m.slice(0, 4) + '***' + m.slice(-4);
}

const PATTERNS: PatternRule[] = [
  // ── HTTP Authorization header ──
  {
    name: 'auth_header',
    re: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9+/=._\-]{8,}/gi,
    mask: (m) => { const sp = m.indexOf(' '); return m.slice(0, sp + 1) + '***REDACTED***'; },
  },

  // ── 支付宝 UID（2088开头的16位数字）──
  {
    name: 'alipay_uid',
    re: /\b2088\d{12}\b/g,
    mask: () => MOCK.alipayUid,
  },

  // ── 阿里云 AccessKey ID ──
  {
    name: 'aliyun_ak',
    re: /LTAI[A-Za-z0-9]{12,24}/g,
    mask: () => MOCK.aliyunAK,
  },

  // ── 密钥/凭证 JSON 字段值 ──
  {
    name: 'credential_json',
    re: /("(?:accessKeyId|accessKeySecret|secretKey|secretId|apiKey|apiSecret|privateKey|bearerToken|accessToken|refreshToken|authToken|sessionToken|appSecret|appKey|authorization)"\s*:\s*")([^"]{6,})(")/g,
    mask: (_m, p1, _p2, p3) => p1 + MOCK.credential + p3,
  },

  // ── Authorization header JSON 值 ──
  {
    name: 'auth_json',
    re: /("(?:authorization)"\s*:\s*")((?:Bearer|Basic|Token)\s+[^"]{6,})(")/gi,
    mask: (_m, p1, _p2, p3) => p1 + MOCK.credential + p3,
  },

  // ── 国际电话号码 ──
  {
    name: 'phone_intl',
    re: /\+\d{1,3}[\s\-]?\(?\d{1,4}\)?[\s\-]?\d{1,4}[\s\-]?\d{1,9}/g,
    mask: maskPhone,
  },

  // ── 中国大陆手机号 ──
  {
    name: 'phone_cn',
    re: /\b1[3-9]\d{9}\b/g,
    mask: maskPhone,
  },

  // ── 中国固话（区号+号码）──
  {
    name: 'phone_landline',
    re: /\b0\d{2,3}[\s\-]?\d{7,8}\b/g,
    mask: maskPhone,
  },

  // ── 身份证号（18位，含年月日校验）──
  {
    name: 'id_card',
    re: /[1-9][0-9]{5}(?:19|20)[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])[0-9]{3}[\dXx]/g,
    mask: maskIdCard,
  },

  // ── 护照号（G/E/D/P + 8位数字）──
  {
    name: 'passport',
    re: /\b[GEPDgepd]\d{8}\b/g,
    mask: (m) => m[0] + '***' + m.slice(-3),
  },

  // ── 邮箱 ──
  {
    name: 'email',
    re: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
    mask: maskEmail,
  },

  // ── 银行卡号（13-19位，可含空格/短横；排除 2088 开头的支付宝 UID）──
  {
    name: 'bank_card',
    re: /\b(?!2088\d{12}\b)(?:\d[ \-]?){13,18}\d\b/g,
    mask: maskBankCard,
    skipForPathLike: true,
  },

  // ── 中文地址（省/自治区 + 市/地区）──
  {
    name: 'cn_address_province',
    re: /[\u4e00-\u9fa5\w]*(?:省|自治区)[\u4e00-\u9fa5\w]*(?:市|地区|自治州)[\u4e00-\u9fa5\w]*/g,
    mask: () => '[地址已脱敏]',
  },

  // ── 中文地址（区/县 + 路/街/号）──
  {
    name: 'cn_address_street',
    re: /[\u4e00-\u9fa5\w]+(?:区|县|街道|乡|镇)[\u4e00-\u9fa5\w]*(?:路|街|道|巷|弄)[\u4e00-\u9fa5\w]*\d+号/g,
    mask: () => '[地址已脱敏]',
  },

  // ── 中文姓名（2-4字+称谓）──
  {
    name: 'cn_name',
    re: /[\u4e00-\u9fa5]{2,4}(?:先生|女士|老师|同学)/g,
    mask: () => '示例用户',
  },

  // ── 用户路径 /Users/<name>/ 或 /home/<name>/ ──
  {
    name: 'user_path',
    re: /(\/(?:Users|home)\/)([^\/]+)(\/)/g,
    mask: (_m, p1, _p2, p3) => p1 + MOCK.userName + p3,
  },

  // ── IPv4 ──
  {
    name: 'ipv4',
    re: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g,
    mask: (m) => { const p = m.split('.'); return p[0] + '.' + p[1] + '.*.*'; },
  },

  // ── IPv6 ──
  {
    name: 'ipv6',
    re: /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,7}:\b|\b::(?:[0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4}\b/g,
    mask: () => '***:***:REDACTED',
  },

  // ── 长随机串: hex 32位+ ──
  {
    name: 'hex32',
    re: /\b[0-9a-f]{32,}\b/gi,
    mask: maskLongToken,
    skipForPathLike: true,
  },

  // ── 长随机串: base64/alphanumeric 40位+ ──
  {
    name: 'base64_40',
    re: /\b[A-Za-z0-9+/=_\-]{40,}\b/g,
    mask: maskLongToken,
    skipForPathLike: true,
  },
];

// 路径类字段跳过的规则索引
const SKIP_PATTERN_INDEXES = new Set(
  PATTERNS.reduce((acc, p, i) => { if (p.skipForPathLike) acc.add(i); return acc; }, new Set<number>())
);

// ============ 核心脱敏函数 ============

/**
 * 对字符串应用所有正则脱敏规则
 */
export function redactString(str: string, skipLongToken = false): string {
  let out = str;
  for (let i = 0; i < PATTERNS.length; i++) {
    if (skipLongToken && SKIP_PATTERN_INDEXES.has(i)) continue;
    PATTERNS[i].re.lastIndex = 0;
    out = out.replace(PATTERNS[i].re, PATTERNS[i].mask);
  }
  return out;
}

/**
 * 标准化 key 名用于黑名单匹配（小写 + 下划线）
 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/-/g, '_');
}

/**
 * 脱敏单个值
 */
export function redactValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    const nk = normalizeKey(key);

    // 跳过时间戳等字段
    if (SKIP_KEYS.has(nk)) return value;

    // 敏感字段：整体替换
    if (SENSITIVE_KEYS.has(nk) && value.length > 0) {
      return MOCK.credential;
    }

    // uid/userId 等纯数字字段单独处理
    if ((nk === 'uid' || nk === 'userid' || nk === 'empid' || nk === 'workno' || nk === 'alipay_id' || nk === 'openid' || nk === 'unionid') && /^\d{6,20}$/.test(value)) {
      return MOCK.alipayUid;
    }

    // 路径类字段跳过长随机串正则
    const skipLong = PATH_LIKE_KEYS.has(nk);

    return redactString(value, skipLong);
  }

  if (typeof value === 'number') {
    const nk = normalizeKey(key);
    // uid 纯数字
    if ((nk === 'uid' || nk === 'userid' || nk === 'empid' || nk === 'workno') && value > 100000) {
      return Number(MOCK.alipayUid);
    }
    return value;
  }

  if (Array.isArray(value)) return value.map((v) => redactValue('', v));
  if (typeof value === 'object') return redactObject(value as Record<string, unknown>);

  return value;
}

/**
 * 脱敏对象
 */
export function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = redactValue(k, v);
  }
  return out;
}

// ============ Session 结构感知脱敏 ============

/**
 * 脱敏 CcSession（兼容旧格式）
 */
function sanitizeSession(session: CcSession): CcSession {
  const result: CcSession = { ...session };

  if (result.sourceMetadata) {
    result.sourceMetadata = {
      ...result.sourceMetadata,
      sender: result.sourceMetadata.sender ? MOCK.sender : undefined,
      senderId: result.sourceMetadata.senderId ? MOCK.senderId : undefined,
    };
  }

  if (result.cwd) {
    result.cwd = result.cwd.replace(/(\/(?:Users|home)\/)([^\/]+)(\/)/g, `$1${MOCK.userName}$3`);
  }

  if (Array.isArray(result.records)) {
    result.records = result.records.map((record) => redactValue('record', record));
  }

  return result;
}

// ============ 文件处理 ============

/**
 * 处理单个文件
 */
function processFile(inputPath: string, outputPath?: string): void {
  const content = readFileSync(inputPath, 'utf-8');
  const ext = extname(inputPath).toLowerCase();
  const output = outputPath || inputPath;

  if (ext === '.json') {
    try {
      const obj = JSON.parse(content);
      const sanitized = redactValue('', obj);
      writeFileSync(output, JSON.stringify(sanitized, null, 2));
      console.log(`✓ 已脱敏: ${inputPath} -> ${output} (JSON)`);
    } catch {
      // JSON 解析失败，当 JSONL/文本处理
      processRawContent(content, inputPath, output);
    }
    return;
  }

  // 默认按 JSONL 处理
  processRawContent(content, inputPath, output);
}

/**
 * 处理 JSONL 或原始文本内容
 */
function processRawContent(content: string, inputPath: string, output: string): void {
  const lines = content.split('\n');
  const results: string[] = [];
  let sessionCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      results.push(line);
      continue;
    }
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object' && (obj as Record<string, unknown>).type === 'session') {
        results.push(JSON.stringify(sanitizeSession(obj as CcSession)));
        sessionCount++;
      } else {
        results.push(JSON.stringify(redactValue('', obj)));
      }
    } catch {
      // 非 JSON 行：对纯文本也做正则脱敏
      results.push(redactString(line));
    }
  }

  writeFileSync(output, results.join('\n'));
  console.log(`✓ 已脱敏: ${inputPath} -> ${output} (${sessionCount} sessions, ${results.length} lines)`);
}

/**
 * 递归收集目录下所有可处理文件
 */
function collectFiles(dir: string): string[] {
  const result: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    // 跳过 .git/node_modules，但保留 .omk 等数据目录
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    if (entry.name.startsWith('.') && entry.name !== '.omk') continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectFiles(fullPath));
    } else if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.json') || entry.name.endsWith('.log'))) {
      result.push(fullPath);
    }
  }
  return result;
}

/**
 * 处理目录（递归子目录）
 */
function processDirectory(inputDir: string, outputDir?: string): void {
  const files = collectFiles(inputDir);
  const targetDir = outputDir || inputDir;
  if (outputDir && !existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  let successCount = 0;
  let failCount = 0;

  for (const inputPath of files) {
    const relativePath = inputPath.slice(inputDir.length).replace(/^\//, '');
    if (outputDir) {
      const outputPath = join(outputDir, relativePath);
      const outputDirForFile = dirname(outputPath);
      if (!existsSync(outputDirForFile)) {
        mkdirSync(outputDirForFile, { recursive: true });
      }
      try {
        processFile(inputPath, outputPath);
        successCount++;
      } catch (error) {
        console.error(`✗ 处理失败: ${inputPath}`, error);
        failCount++;
      }
    } else {
      // 原地脱敏
      try {
        processFile(inputPath);
        successCount++;
      } catch (error) {
        console.error(`✗ 处理失败: ${inputPath}`, error);
        failCount++;
      }
    }
  }

  console.log(`\n✓ 完成! 共处理 ${successCount} 个文件${failCount > 0 ? `，失败 ${failCount} 个` : ''}`);
}

// ============ 主入口 ============

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(`
Session 数据脱敏工具

用法:
  npx tsx scripts/sanitize-session.ts <input.jsonl> [output.jsonl]
  npx tsx scripts/sanitize-session.ts <input-dir> [output-dir]
  npx tsx scripts/sanitize-session.ts --help

示例:
  npx tsx scripts/sanitize-session.ts ./session.jsonl ./sanitized.jsonl
  npx tsx scripts/sanitize-session.ts ./traces ./sanitized-traces
`);
    process.exit(0);
  }

  if (args[0] === '--help' || args[0] === '-h') {
    console.log(`
Session 数据脱敏工具 (v2.0)

支持对 OpenClaw 和 Claude Code session 进行全量脱敏

脱敏内容:
── 字段名黑名单（整值替换为 ***REDACTED***）
  token 类: token, access_token, refresh_token, id_token, auth_token, session_token, bearer, jwt
  key/secret 类: apikey, api_key, secret, client_secret, app_secret, secret_key, private_key, signing_key 等
  密码类: password, passwd, pwd, passphrase
  认证类: authorization, cookie, set-cookie, x-auth-token, x-api-key, credential 等
  身份类: userid, user_id, uid, openid, unionid, idcard, id_card, identity, ssn, passport_no 等
  联系方式: phone, mobile, tel, telephone, email, mail 等
  地址类: address, addr, home_address, location
  银行/支付: bank_card, card_no, account_no, bank_account, alipay_id 等

── 正则脱敏（部分保留信息）
  邮箱: a***@domain.com
  中国手机号: 138****9999
  国际电话: +86 138****9999
  中国固话: 010****1234
  身份证号: 310***********1234
  护照号: G***234
  支付宝 UID: 2088xxxxxxxxxxxx → 2088000000000000
  阿里云 AK: LTAIxxxx → LTAI0000...MOCK
  银行卡号: 6222 **** **** 1234
  IPv4: 192.168.*.*
  IPv6: ***:***:REDACTED
  用户路径: /Users/<name>/ → /Users/example-user/
  中文姓名(带称谓): XXX先生 → 示例用户
  中文地址: XX省XX市 → [地址已脱敏]
  HTTP Auth header: Bearer ***REDACTED***
  长随机串(hex32+/base64 40+): 截断为前4+***+后4

用法:
  npx tsx scripts/sanitize-session.ts <input.jsonl> [output.jsonl]
  npx tsx scripts/sanitize-session.ts <input-dir> [output-dir]

示例:
  npx tsx scripts/sanitize-session.ts ./session.jsonl ./sanitized.jsonl
  npx tsx scripts/sanitize-session.ts ./traces ./sanitized-traces
`);
    process.exit(0);
  }

  const inputPath = args[0];
  const outputPath = args[1];

  const stat = statSync(inputPath);

  if (stat.isFile()) {
    processFile(inputPath, outputPath);
  } else if (stat.isDirectory()) {
    processDirectory(inputPath, outputPath);
  } else {
    console.error('✗ 输入路径无效');
    process.exit(1);
  }
}

// 仅在直接运行时执行 main，import 时不执行
if (process.argv[1]?.endsWith('sanitize-session.ts') || process.argv[1]?.endsWith('sanitize-session')) {
  main();
}