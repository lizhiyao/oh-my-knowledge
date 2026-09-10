import { Errors } from '@oclif/core';
import { z } from 'zod';
import type { CliLang } from './i18n.js';

const timestamp = z.iso.datetime({ offset: true });

export function resolveObservationWindow(
  input: { from?: string; to?: string; last?: string },
  lang: CliLang,
  now = Date.now(),
): { from?: string; to?: string } {
  const invalid = (flag: string): never => {
    throw new Errors.CLIError(lang === 'zh'
      ? `${flag} 无效。日期须为带时区的 ISO 时间，--last 须为有效的天／小时／分钟窗口（如 7d），且起始时间不能晚于结束时间。`
      : `${flag} is invalid. Use ISO timestamps with a timezone and a valid --last window (such as 7d); start must not follow end.`, { exit: 2 });
  };
  let from = input.from;
  const to = input.to;
  for (const [flag, value] of [['--from', from], ['--to', to]] as const) {
    if (value !== undefined && (!timestamp.safeParse(value).success || !Number.isFinite(Date.parse(value)))) invalid(flag);
  }
  if (input.last !== undefined) {
    const match = /^(\d+)([dhm])$/.exec(input.last);
    if (!match) invalid('--last');
    const count = Number(match![1]);
    const milliseconds = count * ({ d: 86_400_000, h: 3_600_000, m: 60_000 }[match![2]] ?? NaN);
    const start = now - milliseconds;
    if (!Number.isSafeInteger(count) || count <= 0 || !Number.isSafeInteger(milliseconds)
        || !Number.isFinite(new Date(start).getTime())) invalid('--last');
    from ??= new Date(start).toISOString();
  }
  if (from !== undefined && to !== undefined && Date.parse(from) > Date.parse(to)) invalid('--from/--to');
  return { from, to };
}
