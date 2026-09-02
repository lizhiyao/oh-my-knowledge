import { SampleFileAmbiguityError } from '../../eval-workflows/inputs/sample-locator.js';
import { tCli, type CliLang } from './i18n.js';

/** 将纯 inputs 层的结构化发现错误映射为 CLI 语言，不让领域模块依赖 i18n。 */
export function withLocalizedSampleDiscovery<T>(operation: () => T, lang: CliLang): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof SampleFileAmbiguityError) {
      throw new Error(tCli('cli.common.ambiguous_sample_files', lang, {
        paths: error.paths.join(lang === 'zh' ? '、' : ', '),
      }));
    }
    throw error;
  }
}
