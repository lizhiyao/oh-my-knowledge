import type { ServerResponse } from 'node:http';

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Browser responses must not expose filesystem paths, credentials, or provider errors.
export const STUDIO_SOURCE_UNAVAILABLE = 'studio_source_unavailable';
export const CORE_STUDIO_SOURCE_UNAVAILABLE = 'core_studio_source_unavailable';
// 宿主自身故障（未启动、渲染管线异常），与数据源查询失败区分。
export const STUDIO_INTERNAL_ERROR = 'studio_internal_error';

export const JSON_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
});

export const HTML_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
});

export const TEXT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Type': 'text/plain; charset=utf-8',
  'Cache-Control': 'no-store',
});

/** API 错误响应体 { error: <code> } 的稳定 code 全集；新增 code 在此登记。 */
export type StudioApiErrorCode =
  | 'method_not_allowed'
  | 'missing_query_params'
  | 'invalid_json_body'
  | 'json_body_not_object'
  | 'request_body_too_large'
  | 'unsupported_media_type'
  | 'mutation_not_trusted'
  | 'invalid_review_state'
  | 'analysis_not_found'
  | 'observation_not_found'
  | 'skill_diagnostics_not_found'
  | 'conversation_not_found'
  | 'task_trajectory_not_found'
  | 'experience_session_not_found'
  | 'core_run_not_found'
  | 'live_task_trajectory_unavailable'
  | typeof STUDIO_SOURCE_UNAVAILABLE
  | typeof CORE_STUDIO_SOURCE_UNAVAILABLE;

/** 统一 API 错误契约：JSON 体、稳定 code、no-store。 */
export function writeJsonError(
  response: ServerResponse,
  status: number,
  code: StudioApiErrorCode,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, { ...JSON_HEADERS, ...extraHeaders });
  response.end(JSON.stringify({ error: code }));
}
