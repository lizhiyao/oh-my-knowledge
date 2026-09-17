/**
 * 本机 Agent 静态登记表。
 *
 * 只登记「可以当场核对」的事实：产品名、厂商、PATH 上的可执行入口、主目录下的安装状态目录，
 * 以及已确认属于 OMK 已支持格式的会话日志根。以下三类条目一律不写：
 * - 没有亲眼验证过的目录形态；
 * - 已知不是会话轨迹的日志（运行期事件日志、zstd 压缩会话、纯 app log）；
 * - 桌面 App 的 Electron 数据目录（它证明的是 App 装过，不代表 CLI 可用）。
 *
 * 路径都相对用户主目录，因此 macOS 与 Linux 共用同一份登记（这些 CLI 都把状态放在 `$HOME` 下）；
 * 差异化的安装位置（原生安装器的版本目录、`~/.local/share/...`）作为额外的 installDirs 并列登记，
 * 探测命中哪一个由 detect 记录在 evidence 里。PATH 上的实际入口由 `pathDirectories` 覆盖，
 * 因此 nvm、`~/.local/bin`、`/usr/local/bin` 等 Linux/macOS 常见位置无需逐个写进目录。
 *
 * 未建模的例外：`CODEX_HOME` 之类的环境变量会改变日志根位置，登记表按默认路径登记，
 * 这类用户的环境覆盖留待 CLI 入口显式传路径时处理。
 */

import { z } from 'zod';
import { AgentDescriptorSchema, type AgentDescriptor } from './contracts.js';
import { assertSafeHomeRelativePath } from './fs-ports.js';

type AgentDescriptorSource = z.input<typeof AgentDescriptorSchema>;

const CATALOG_SOURCE: readonly AgentDescriptorSource[] = [
  {
    agentId: 'codex',
    displayName: 'Codex CLI',
    vendor: 'OpenAI',
    traceSourceKind: 'codex',
    binaries: ['codex'],
    installDirs: ['.codex'],
    logRoots: [
      {
        rootId: 'codex-sessions',
        relativePath: '.codex/sessions',
        traceSourceKind: 'codex',
        matchExtensions: ['.jsonl'],
        recursive: true,
        note: '按 YYYY/MM/DD 分层存放 rollout-*.jsonl。',
      },
      {
        rootId: 'codex-archived-sessions',
        relativePath: '.codex/archived_sessions',
        traceSourceKind: 'codex',
        matchExtensions: ['.jsonl'],
        recursive: true,
        note: '用户手动归档的 rollout，格式与 sessions 一致。',
      },
    ],
  },
  {
    agentId: 'claude-code',
    displayName: 'Claude Code',
    vendor: 'Anthropic',
    traceSourceKind: 'claude',
    binaries: ['claude'],
    // `.local/share/claude` 是原生安装器的版本目录，macOS 与 Linux 同构。
    installDirs: ['.claude', '.local/share/claude'],
    logRoots: [
      {
        rootId: 'claude-projects',
        relativePath: '.claude/projects',
        traceSourceKind: 'claude',
        matchExtensions: ['.jsonl'],
        recursive: true,
        note: '每个项目一个 slug 目录，主会话与 subagents/*.jsonl 同层递归。',
      },
    ],
  },
  {
    agentId: 'codefuse',
    displayName: 'CodeFuse CLI',
    vendor: 'Ant Group',
    // CodeFuse 落的是 Claude 同族日志：产品身份与格式归属故意分开。
    traceSourceKind: 'claude',
    binaries: ['cfuse'],
    installDirs: ['.codefuse', '.local/share/codefuse-cli'],
    logRoots: [
      {
        rootId: 'codefuse-projects',
        relativePath: '.codefuse/projects',
        traceSourceKind: 'claude',
        matchExtensions: ['.jsonl'],
        recursive: true,
        note: '主会话与 agent_<uuid>.jsonl 子代理会话同目录；不猜测其它命名形态。',
      },
    ],
  },
  {
    agentId: 'qoder',
    displayName: 'Qoder CLI',
    vendor: 'Qoder',
    traceSourceKind: 'qoder',
    binaries: ['qoder'],
    installDirs: ['.qoder'],
    logRoots: [
      {
        rootId: 'qoder-projects',
        relativePath: '.qoder/projects',
        traceSourceKind: 'qoder',
        matchExtensions: ['.jsonl'],
        recursive: true,
        note: 'logs/sessions 是运行期事件日志而非会话轨迹，未登记为日志根。',
      },
    ],
  },
  {
    agentId: 'qoder-cn',
    displayName: 'Qoder CN CLI',
    vendor: 'Qoder',
    traceSourceKind: 'qoder',
    binaries: ['qoder-cn'],
    installDirs: ['.qoder-cn'],
    logRoots: [
      {
        rootId: 'qoder-cn-projects',
        relativePath: '.qoder-cn/projects',
        traceSourceKind: 'qoder',
        matchExtensions: ['.jsonl'],
        recursive: true,
        note: '与 qoder 国际版是两个已安装产品，因此拆成两个 agentId 分别计数。',
      },
    ],
  },
  {
    agentId: 'openclaw',
    displayName: 'OpenClaw',
    vendor: 'OpenClaw',
    traceSourceKind: 'openclaw',
    binaries: ['openclaw'],
    installDirs: ['.openclaw'],
    logRoots: [
      {
        rootId: 'openclaw-sessions',
        relativePath: '.openclaw/sessions',
        traceSourceKind: 'openclaw',
        matchExtensions: ['.jsonl'],
        recursive: true,
        note: '与 inbox 既有的 .openclaw/sessions 路径口径一致；本机尚未生成该目录。',
      },
    ],
  },
  {
    agentId: 'gemini',
    displayName: 'Gemini CLI',
    vendor: 'Google',
    // 会话历史是 .json，OMK 暂无对应适配器：只登记安装事实，不猜日志根。
    traceSourceKind: null,
    binaries: ['gemini'],
    installDirs: ['.gemini'],
    logRoots: [],
  },
  {
    agentId: 'cursor',
    displayName: 'Cursor CLI',
    vendor: 'Cursor',
    traceSourceKind: null,
    binaries: ['cursor'],
    installDirs: ['.cursor'],
    logRoots: [],
  },
  {
    agentId: 'dsh',
    displayName: 'DSH',
    vendor: 'unknown',
    traceSourceKind: 'dsh',
    binaries: ['dsh'],
    installDirs: ['.dsh'],
    // 已核对：sessions 下是 session.jsonl.zstd（zstd 压缩），现有解析器不读压缩文件，
    // 因此本轮只登记安装事实，不把压缩会话计入可采集范围。
    logRoots: [],
  },
];

function parseCatalogEntry(entry: AgentDescriptorSource, index: number): AgentDescriptor {
  const descriptor = AgentDescriptorSchema.parse(entry);
  try {
    for (const installDir of descriptor.installDirs) assertSafeHomeRelativePath(installDir);
    for (const root of descriptor.logRoots) assertSafeHomeRelativePath(root.relativePath);
  } catch (cause) {
    throw new Error(`Agent 登记表第 ${index + 1} 条（${descriptor.agentId}）路径不合法`, { cause });
  }
  return descriptor;
}

/** 目录在模块加载时即完成校验：任何一条畸形都会让进程启动失败，而不是运行到一半才漏。 */
export const KNOWN_AGENTS: readonly AgentDescriptor[] = Object.freeze(
  CATALOG_SOURCE.map((entry, index) => parseCatalogEntry(entry, index)),
);

export function findAgentDescriptor(agentId: string): AgentDescriptor | undefined {
  return KNOWN_AGENTS.find((descriptor) => descriptor.agentId === agentId);
}
