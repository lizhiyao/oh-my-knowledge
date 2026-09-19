/** 与规范 JSON 一致的 UTF-16 字典序，不依赖宿主 locale。 */
export function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
