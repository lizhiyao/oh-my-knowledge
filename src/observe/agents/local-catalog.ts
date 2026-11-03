/**
 * 本机 Agent 登记表扩展：内置登记表之外的条目由用户级文件声明。
 *
 * 为什么需要它：登记条目的匹配键（安装目录、可执行入口名、日志根相对路径）本身就是产品名，
 * 因此不便公开的产品无法靠改名进入内置表。扩展文件让这些条目留在本机：接入自己的宿主不再
 * 要求改动公开代码，也不再要求把产品名写进公开仓库。
 *
 * 能力边界与内置登记表完全相同，因此不新增信任面：
 * - 文件只能声明 `agent-catalog-v1` 条目，字段校验复用同一个 AgentDescriptorSchema；
 * - 路径复用内置表的同一条判据（assertSafeDescriptorPaths），绝对路径与 `..` 段一律 fail-closed；
 * - 读取只用 readFileSync，没有 exec／spawn，检测阶段也从不运行被登记的二进制。
 *
 * 失效处理刻意严格：文件不存在是「没有扩展条目」，但存在却读不了、JSON 畸形、schema 不合法、
 * 身份重复都抛错并点名文件路径。半份登记表会让清单与采集静默少一个宿主，比直接失败更糟。
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { globalLayout } from '../../evidence/storage/layout.js';
import {
  AgentCatalogFileSchema,
  type AgentDescriptor,
} from './contracts.js';
import { isMissingPathError } from './fs-ports.js';
import { assertSafeDescriptorPaths, KNOWN_AGENTS } from './registry.js';

export class LocalAgentCatalogError extends Error {
  constructor(message: string, readonly catalogPath: string, options?: { cause?: unknown }) {
    super(`${message}（文件：${catalogPath}）`, options);
    this.name = 'LocalAgentCatalogError';
  }
}

export interface LocalAgentCatalogOptions {
  /** 默认 `globalLayout().agentCatalogPath`，即 `<OMK_HOME>/agents.json`。 */
  catalogPath?: string;
}

export interface LocalAgentCatalog {
  path: string;
  /** false 表示文件不存在，登记表按内置条目继续工作。 */
  present: boolean;
  descriptors: AgentDescriptor[];
}

function defaultAgentCatalogPath(): string {
  return globalLayout().agentCatalogPath;
}

export function loadLocalAgentCatalog(options: LocalAgentCatalogOptions = {}): LocalAgentCatalog {
  const catalogPath = options.catalogPath ?? defaultAgentCatalogPath();
  let text: string;
  try {
    text = readFileSync(catalogPath, 'utf8');
  } catch (cause) {
    if (isMissingPathError(cause)) return { path: catalogPath, present: false, descriptors: [] };
    // 存在却读不了（权限、是目录、IO 错误）不能当成「没有扩展条目」，否则清单会少报宿主。
    throw new LocalAgentCatalogError('登记表扩展文件存在但读不了', catalogPath, { cause });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new LocalAgentCatalogError('登记表扩展文件不是合法 JSON', catalogPath, { cause });
  }

  const result = AgentCatalogFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new LocalAgentCatalogError(
      `登记表扩展文件不符合 agent-catalog-v1：${describeIssues(result.error)}`,
      catalogPath,
    );
  }

  const descriptors = result.data.agents.map((entry, index) => validateEntry(entry, index, catalogPath));
  assertNoDuplicateAgentIds(descriptors, catalogPath);
  return { path: catalogPath, present: true, descriptors };
}

/**
 * 内置表与扩展条目按 agentId 合并：同 id 时扩展条目整条替换内置条目（保留原位置），
 * 新 id 追加在末尾。替换是整条而非字段级合并——半新半旧的日志根声明比两份完整声明更难诊断。
 */
export function mergeAgentCatalog(
  builtIn: readonly AgentDescriptor[],
  local: readonly AgentDescriptor[],
): AgentDescriptor[] {
  if (local.length === 0) return [...builtIn];
  const byId = new Map(local.map((descriptor) => [descriptor.agentId, descriptor]));
  const merged = builtIn.map((descriptor) => byId.get(descriptor.agentId) ?? descriptor);
  const consumed = new Set(builtIn.map((descriptor) => descriptor.agentId));
  for (const descriptor of local) {
    if (!consumed.has(descriptor.agentId)) merged.push(descriptor);
  }
  return merged;
}

/** 检测与采集共用的入口：内置表 + 本机扩展文件。 */
export function resolveAgentCatalog(options: LocalAgentCatalogOptions = {}): AgentDescriptor[] {
  return mergeAgentCatalog(KNOWN_AGENTS, loadLocalAgentCatalog(options).descriptors);
}

function validateEntry(entry: AgentDescriptor, index: number, catalogPath: string): AgentDescriptor {
  try {
    assertSafeDescriptorPaths(entry);
  } catch (cause) {
    throw new LocalAgentCatalogError(
      `登记表扩展文件第 ${index + 1} 条（${entry.agentId}）路径不合法`,
      catalogPath,
      { cause },
    );
  }
  return entry;
}

function assertNoDuplicateAgentIds(descriptors: readonly AgentDescriptor[], catalogPath: string): void {
  const seen = new Set<string>();
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.agentId)) {
      throw new LocalAgentCatalogError(
        `登记表扩展文件里身份 ${descriptor.agentId} 重复声明，请合并成一条`,
        catalogPath,
      );
    }
    seen.add(descriptor.agentId);
  }
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}：${issue.message}`)
    .join('；');
}
