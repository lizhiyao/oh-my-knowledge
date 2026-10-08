/**
 * 终端展示前清理不可信字符，避免控制符、双向重排和零宽字符伪造输出。
 *
 * 用 Unicode **属性类**而非手列码点 —— 手列清单天然有缺口(BiDi、U+2028 / 2029、Tags 块都曾漏一轮补一轮),
 * 属性类一次覆盖整类、新码点自动纳入:
 *   - `\p{Cc}` 控制符(C0 / C1 / DEL,含 ESC / 换行 / 回车 / TAB)→ 杀 ANSI / OSC 转义与终端控制;
 *   - `\p{Cf}` 格式符(BiDi 重排 / 隔离、零宽、joiners、BOM、Tags、interlinear)→ 防 Trojan-Source 视觉伪造与零宽隐藏 / 分割;
 *   - `\p{Zl}` / `\p{Zp}` 行 / 段分隔(U+2028 / 2029)→ LF 的 Unicode 孪生,防换行伪造;
 *   - `\p{Mn}` / `\p{Me}` 非间距 / 封闭组合附加符 → 变可见,避免零前进宽度令列宽与终端错位
 *     (间距组合符 `\p{Mc}` 合法占 1 列,保留);
 *   - Hangul filler(U+115F / U+1160 / U+3164,属 Lo 不在上述任何类)→ 零宽显示诡计,补列。
 */
export function sanitizeCell(s: string): string {
  return s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Mn}\p{Me}ᅟᅠㅤ]/gu, '�');
}
