import { TEXT_HEADERS, writeJsonError } from '../errors.js';
import { assertTrustedMutationRequest } from '../request-errors.js';
import type { StudioRouteContext } from './contracts.js';

/**
 * 声明式路由表：pattern 段语法为 `:param`（单段）与 `*rest`（多段，含 `/`）。
 * 统一承担 method 矩阵（不匹配 → 405 + Allow）、路径参数解码
 * （解码失败置空串，后续查询自然 404）与 mutation 可信校验；
 * handler 只在匹配成功后被调用，返回值恒为已处理。
 */
export interface StudioRouteDefinition<C extends StudioRouteContext> {
  readonly pattern: string;
  /** 默认 GET；'ANY' 用于 307/302 重定向等需要保留原方法的入口。 */
  readonly method?: string | readonly string[] | 'ANY';
  /** true 时先跑跨站可信校验（RequestBodyError 由宿主统一投影）。 */
  readonly mutation?: boolean;
  readonly handler: (
    context: C & { readonly params: Readonly<Record<string, string>> },
  ) => void | Promise<void>;
}

interface CompiledRoute<C extends StudioRouteContext> {
  readonly definition: StudioRouteDefinition<C>;
  readonly regex: RegExp;
  readonly paramNames: readonly string[];
  readonly score: readonly number[];
  readonly methods: ReadonlySet<string> | 'ANY';
}

const LITERAL_SCORE = 2;
const PARAM_SCORE = 1;
const WILDCARD_SCORE = 0;

function compilePattern(pattern: string): Pick<CompiledRoute<never>, 'regex' | 'paramNames' | 'score'> {
  const paramNames: string[] = [];
  const score: number[] = [];
  const source = pattern.split('/').map((segment) => {
    if (segment.startsWith(':')) {
      paramNames.push(segment.slice(1));
      score.push(PARAM_SCORE);
      return '([^/]+)';
    }
    if (segment.startsWith('*')) {
      paramNames.push(segment.slice(1));
      score.push(WILDCARD_SCORE);
      return '(.+)';
    }
    score.push(LITERAL_SCORE);
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return { regex: new RegExp(`^${source}$`), paramNames, score };
}

function compareScore(a: readonly number[], b: readonly number[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] ?? -1) - (b[index] ?? -1);
    if (diff !== 0) return diff;
  }
  return 0;
}

function compile<C extends StudioRouteContext>(
  definition: StudioRouteDefinition<C>,
): CompiledRoute<C> {
  const { regex, paramNames, score } = compilePattern(definition.pattern);
  const method = definition.method ?? 'GET';
  return {
    definition,
    regex,
    paramNames,
    score,
    methods: method === 'ANY'
      ? 'ANY'
      : new Set((Array.isArray(method) ? method : [method]).map((value) => value.toUpperCase())),
  };
}

export type StudioRouter<C extends StudioRouteContext> = (context: C) => Promise<boolean>;

export function createStudioRouter<C extends StudioRouteContext>(
  definitions: readonly StudioRouteDefinition<C>[],
): StudioRouter<C> {
  // 字面量段优先于 :param，:param 优先于 *rest，保证 /api/conversations/activity
  // 这类精确路由不会被参数模式吞掉。
  const routes = definitions.map(compile<C>).sort((a, b) => compareScore(b.score, a.score));
  return async (context) => {
    const method = (context.request.method ?? 'GET').toUpperCase();
    const pathMatched: CompiledRoute<C>[] = [];
    for (const route of routes) {
      const match = route.regex.exec(context.path);
      if (!match) continue;
      if (route.methods !== 'ANY' && !route.methods.has(method)) {
        pathMatched.push(route);
        continue;
      }
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, index) => {
        const raw = match[index + 1] ?? '';
        try {
          params[name] = decodeURIComponent(raw);
        } catch {
          params[name] = '';
        }
      });
      if (route.definition.mutation) assertTrustedMutationRequest(context.request);
      await route.definition.handler({ ...context, params });
      return true;
    }
    if (pathMatched.length > 0) {
      const allowed = new Set<string>();
      for (const route of pathMatched) {
        if (route.methods === 'ANY') continue;
        for (const value of route.methods) allowed.add(value);
      }
      const allow = [...allowed].sort().join(', ');
      if (context.path.startsWith('/api/')) {
        writeJsonError(context.response, 405, 'method_not_allowed', { Allow: allow });
      } else {
        context.response.writeHead(405, { ...TEXT_HEADERS, Allow: allow });
        context.response.end('method_not_allowed');
      }
      return true;
    }
    return false;
  };
}
