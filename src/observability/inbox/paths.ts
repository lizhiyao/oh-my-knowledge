import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { globalLayout, projectLayout } from '../../evidence/storage/layout.js';
import { isReportFileName } from '../../evidence/storage/file-names.js';
import { resolveDataDirectory } from '../../evidence/storage/directory-selection.js';

/**
 * inbox 根目录一律按**调用时**的 `cwd()` 求值（函数，不是 import 时冻结的常量），与
 * `evidence/storage/directories.ts` 同口径：Studio 与 MCP 是长会话，按请求解析才不会和
 * CLI 的当前项目分叉。本模块只算路径，不建目录——建目录属于写路径自己的副作用。
 */

/** 项目级 inbox 根目录(相对调用时 cwd)。 */
export function projectObservationsDir(cwd: string = process.cwd()): string {
  return projectLayout(cwd).observeInboxDir;
}

/** 全局 inbox 根目录。 */
export function globalObservationsDir(): string {
  return globalLayout().observeInboxDir;
}

/**
 * inbox 根下是否已有观测数据：报告、显式捕获或复核状态任一存在即算。
 * 「目录存在」不算——空目录可能是别的命令顺手建的，不能据此判定用户观测过。
 */
export function hasObservationInboxData(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir, { withFileTypes: true }).some((entry) => {
      if (entry.isFile()) return entry.name === 'review-state.json';
      if (!entry.isDirectory()) return false;
      if (entry.name === 'captures') {
        try {
          return readdirSync(join(dir, entry.name)).some((file) => file.endsWith('.capture.json'));
        } catch {
          return false;
        }
      }
      if (entry.name !== 'reports') return false;
      try {
        return readdirSync(join(dir, entry.name)).some(isReportFileName);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function isV2ObservationInboxDir(dir: string): boolean {
  const normalized = resolve(dir);
  return basename(normalized) === 'inbox' && basename(dirname(normalized)) === 'observe';
}

/** Inbox roots keep generated reports below `reports/`. */
export function observationReportsDir(observationsDir: string): string {
  return join(observationsDir, 'reports');
}

/** Canonical inbox roots place drafts in the sibling `observe/drafts/` domain. */
export function observationDraftsDir(observationsDir: string): string {
  if (isV2ObservationInboxDir(observationsDir)) return join(dirname(observationsDir), 'drafts');
  return join(observationsDir, 'drafts');
}

/** Canonical inbox roots place immutable source records in `observe/archive/`. */
export function observationArchiveDir(observationsDir: string): string {
  if (isV2ObservationInboxDir(observationsDir)) return join(dirname(observationsDir), 'archive');
  return join(observationsDir, 'archive');
}

/**
 * 用户未指定 inbox 时的读取目标：项目有数据取项目，否则全局有数据取全局，都空回项目。
 * `globalFallback` 可注入（默认真实全局目录），仅供测试用受控 temp 目录复现 project↔global 兜底。
 */
export function defaultObservationsDir(globalFallback: string = globalObservationsDir()): string {
  return resolveDataDirectory(projectObservationsDir(), globalFallback, hasObservationInboxData);
}

/**
 * 读取目标 inbox：调用方指定了目录就照它读（不参与兜底，`--observations-dir` 指到哪就读哪），
 * 未指定才由 `defaultObservationsDir()` 挑选。
 */
export function resolveObservationsDir(dir?: string): string {
  return dir ?? defaultObservationsDir();
}
