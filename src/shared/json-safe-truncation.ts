/**
 * 字符串截断 — UTF-16 surrogate pair 安全。
 *
 * 背景:
 *   `String.prototype.slice` 按 UTF-16 code unit 切。Emoji 和 CJK 扩展字符 B 区
 *   等 supplementary character(代码点 > 0xFFFF) 在 UTF-16 里用 2 个 code unit
 *   表示(高位 0xD800-0xDBFF + 低位 0xDC00-0xDFFF)。在两个 code unit 之间切
 *   会留下"孤悬高位 surrogate",JSON.stringify 输出 `\uD83D` 但下一位不是
 *   `\uDCxx`,严格 JSON parser(jq / serde / Java Jackson 等)解析会报
 *   "Invalid surrogate pair"。Python json / V8 JSON.parse 宽松接受。
 *
 *   这是 omk 报告 JSON 写盘后被 jq 解析失败的真因(线上某下游 jq 消费者
 *   实际撞过这条:报告 line 807 col 313 即此)。
 *
 * 修法:
 *   切完之后检查最后一个 code unit。如果是高位 surrogate,回退一位。这样最多损失
 *   一个 emoji(出现在边界处,本来也要被截掉),但保证输出始终是合法 UTF-16 字符串。
 *
 * 用于所有"会被序列化进 report JSON 或长期持久化"的截断。CLI 实时输出 / prompt
 * 拼接等不持久化的地方用 `String.prototype.slice` 也无所谓,留旧代码即可。
 */
export function safeSliceForJson(s: string, maxLen: number, suffix = '…'): string {
  if (s.length <= maxLen) return s;
  let cut = maxLen;
  const lastCode = s.charCodeAt(cut - 1);
  if (lastCode >= 0xD800 && lastCode <= 0xDBFF) {
    // 末尾是高位 surrogate,后面应该跟低位但被切掉了。回退一位。
    cut -= 1;
  }
  return s.slice(0, cut) + suffix;
}
