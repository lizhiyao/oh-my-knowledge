/** RFC 6901 必须先解码 ~1，再解码 ~0；输入格式由调用边界的 Schema 校验。 */
export function decodePointerToken(token: string): string {
  return token.replaceAll('~1', '/').replaceAll('~0', '~');
}

/** RFC 6901 token 编码；先转义 ~，再转义 /。 */
export function encodePointerToken(token: string): string {
  return token.replaceAll('~', '~0').replaceAll('/', '~1');
}

export type PointerResolution =
  | { readonly resolved: true; readonly value: unknown }
  | { readonly resolved: false };

/** 遍历已由 Schema 验证的 JSON Pointer；仅访问对象自身属性及规范数组索引。 */
export function resolveJsonPointer(value: unknown, pointer: string): PointerResolution {
  let current = value;
  if (pointer === '') return { resolved: true, value: current };
  for (const encoded of pointer.slice(1).split('/')) {
    const token = decodePointerToken(encoded);
    if (current === null || typeof current !== 'object') return { resolved: false };
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(token) || Number(token) >= current.length) {
        return { resolved: false };
      }
      current = current[Number(token)];
    } else {
      if (!Object.hasOwn(current, token)) return { resolved: false };
      current = (current as Record<string, unknown>)[token];
    }
  }
  return { resolved: true, value: current };
}
