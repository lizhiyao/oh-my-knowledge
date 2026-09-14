/**
 * ISO 时间戳的展示口径：`T` 换成空格、去掉小数秒，并且只在值确实以 `Z` 结尾时标注 `UTC`
 * （外部 trace 里的 `+08:00` 之类偏移不能被标成 UTC）。缺值统一给 `—`，不留空列。
 * 收件箱、会话、知识与受管页面共用一份，避免同一条证据链在不同表格里精度读数不一致。
 * 不用服务器本地时区渲染：那会让同一条记录在不同机器上读出不同时刻。
 */
export function displayTime(value: string | undefined): string {
  if (!value) return '—';
  return value.replace('T', ' ').replace(/(?:\.\d+)?Z$/, ' UTC');
}
