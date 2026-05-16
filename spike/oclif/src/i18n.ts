// 双语字典 + lang 解析。spike 阶段只验证「同一份 string table 能不能给 oclif help
// formatter 跟 command runtime 复用」。完整 i18n hook 试 oclif help 是否能按 --lang
// 切换 description 输出——见 task #101。

export type Lang = 'zh' | 'en';

export function resolveLang(argv: string[] = process.argv): Lang {
  // 优先级:CLI --lang > OMK_LANG > 默认 zh。复刻 src/cli/i18n.ts L26-28。
  const flagIdx = argv.findIndex((a) => a === '--lang' || a.startsWith('--lang='));
  if (flagIdx >= 0) {
    const val = argv[flagIdx].includes('=')
      ? argv[flagIdx].split('=')[1]
      : argv[flagIdx + 1];
    if (val === 'zh' || val === 'en') return val;
  }
  const env = process.env.OMK_LANG;
  if (env === 'zh' || env === 'en') return env;
  return 'zh';
}

export interface BiText {
  zh: string;
  en: string;
}

export function t(text: BiText, lang: Lang = resolveLang()): string {
  return text[lang];
}

// 「同一字符串两种语言并排」格式,适合塞进 oclif 静态 description 字段(因为 oclif help
// formatter 不会按 lang 切换)。task #101 验证能否 hook 让 help 输出只显示一种语言。
export function bilingual(text: BiText): string {
  return `${text.zh}\n${text.en}`;
}
