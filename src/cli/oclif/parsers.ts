import { resolveLang, type BiText } from './i18n.js';

interface NumericStringParserOptions {
  min?: number;
  minExclusive?: number;
  max?: number;
}

const DECIMAL_RE = /^-?(?:\d+(?:\.\d+)?|\.\d+)$/;

function localize(text: BiText, lang = resolveLang(process.argv)): string {
  return lang === 'zh' ? text.zh : text.en;
}

function requirement(flag: string, kind: 'integer' | 'number', options: NumericStringParserOptions): BiText {
  const noun = kind === 'integer'
    ? { zh: '整数', en: 'integer' }
    : { zh: '数字', en: 'number' };
  const article = kind === 'integer' ? 'an' : 'a';
  if (options.min !== undefined && options.max !== undefined) {
    return {
      zh: `${flag} 必须是 ${options.min} 到 ${options.max} 之间的${noun.zh}`,
      en: `${flag} must be ${article} ${noun.en} between ${options.min} and ${options.max}`,
    };
  }
  if (options.min !== undefined) {
    return {
      zh: `${flag} 必须是大于等于 ${options.min} 的${noun.zh}`,
      en: `${flag} must be ${article} ${noun.en} greater than or equal to ${options.min}`,
    };
  }
  if (options.minExclusive !== undefined) {
    return {
      zh: `${flag} 必须是大于 ${options.minExclusive} 的${noun.zh}`,
      en: `${flag} must be ${article} ${noun.en} greater than ${options.minExclusive}`,
    };
  }
  if (options.max !== undefined) {
    return {
      zh: `${flag} 必须是小于等于 ${options.max} 的${noun.zh}`,
      en: `${flag} must be ${article} ${noun.en} less than or equal to ${options.max}`,
    };
  }
  return {
    zh: `${flag} 必须是${noun.zh}`,
    en: `${flag} must be ${article} ${noun.en}`,
  };
}

function numericError(
  flag: string,
  input: string,
  kind: 'integer' | 'number',
  options: NumericStringParserOptions,
  lang = resolveLang(process.argv),
): Error {
  const req = requirement(flag, kind, options);
  return new Error(localize({
    zh: `${req.zh}，实际为 ${JSON.stringify(input)}。`,
    en: `${req.en} (got ${JSON.stringify(input)}).`,
  }, lang));
}

export function integerStringParser(flag: string, options: NumericStringParserOptions = {}) {
  const lang = resolveLang(process.argv);
  return async (input: string): Promise<string> => {
    const raw = input.trim();
    if (!/^-?\d+$/.test(raw)) {
      throw numericError(flag, input, 'integer', options, lang);
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) {
      throw numericError(flag, input, 'integer', options, lang);
    }
    if (options.min !== undefined && value < options.min) {
      throw numericError(flag, input, 'integer', options, lang);
    }
    if (options.minExclusive !== undefined && value <= options.minExclusive) {
      throw numericError(flag, input, 'integer', options, lang);
    }
    if (options.max !== undefined && value > options.max) {
      throw numericError(flag, input, 'integer', options, lang);
    }
    return input;
  };
}

export function numberStringParser(flag: string, options: NumericStringParserOptions = {}) {
  const lang = resolveLang(process.argv);
  return async (input: string): Promise<string> => {
    const raw = input.trim();
    const value = Number(raw);
    if (!DECIMAL_RE.test(raw) || !Number.isFinite(value)) {
      throw numericError(flag, input, 'number', options, lang);
    }
    if (options.min !== undefined && value < options.min) {
      throw numericError(flag, input, 'number', options, lang);
    }
    if (options.minExclusive !== undefined && value <= options.minExclusive) {
      throw numericError(flag, input, 'number', options, lang);
    }
    if (options.max !== undefined && value > options.max) {
      throw numericError(flag, input, 'number', options, lang);
    }
    return input;
  };
}

export function enumStringParser(flag: string, values: readonly string[]) {
  const lang = resolveLang(process.argv);
  return async (input: string): Promise<string> => {
    if (values.includes(input)) return input;
    const joined = values.join(' / ');
    throw new Error(localize({
      zh: `${flag} 必须是 ${joined} 之一，实际为 ${JSON.stringify(input)}。`,
      en: `${flag} must be one of ${joined} (got ${JSON.stringify(input)}).`,
    }, lang));
  };
}
