/**
 * CLI 文案字典 barrel。
 *
 * 命名约定: `cli.<command>.<event>` 或 `cli.common.<event>`。
 * 占位符用 `{name}` 形式,在 tCli(params) 处替换。
 *
 * 各子文件按 command/domain 分组(init / run / gen / evolve / help / common),
 * 本文件只做类型 union 与 dict 合并,不直接持有条目。新增文案请编辑对应子文件,
 * 并把新 key 追加到该子文件的 `*MessageKey` union。
 *
 * ============================================================================
 * 翻译守则 (受 cc-viewer i18n 方案启发)
 * ============================================================================
 *
 * 1. **彻底本地化, 不接受中英混搭**
 *    "中文用户读到的中文"和"英文用户读到的英文"必须是各自语言里自然的表达,
 *    不能机械翻译, 不能在中文里塞英文短语解释术语。如果某个英文短语没有
 *    自然的中文译法, 重新组织句子结构, 而不是混着写。
 *
 * 2. **保留原文的白名单 (产品术语 / 命令 / 文件名)**
 *    以下 token 在两种语言里都保留原文, 不翻译:
 *    - 产品名: omk, oh-my-knowledge, Claude, npm
 *    - 命令名: init, doctor, eval, observe, evolve, sample, studio, gold
 *    - omk 核心业务术语: skill, variant, sample, judge, executor (出现在产品
 *      UI 里时首字母可大写如 "Skill 评测", 描述句中保持小写)
 *    - 技术参数: --lang, --control, --treatment, --bootstrap, --judge-repeat,
 *      OMK_LANG, JUDGE_PROMPT_VERSION_*
 *    - 文件名 / 路径: eval-samples.json, skills/v1.md, ~/.oh-my-knowledge/...
 *    - 数学概念缩写: CI, α, RAG (其译法可在配套描述里说明, 但术语本身留原文)
 *
 * 3. **必须翻译的内容**
 *    动作 (run / edit / scaffold / generate), 状态 (success / failed /
 *    invalid), 引导文案 (next steps / try this / see also), 解释性描述。
 *
 * 4. **不要机械直译**
 *    "Next steps:" 译 "下一步:" 而不是 "下一步骤:"。
 *    "Run: ..." 译 "运行: ..." 而不是 "跑: ..."。
 *    选用 omk 项目长期使用的中文措辞 (LLM judge 译"评委" 不译"判官", 见
 *    feedback_ui_translation.md)。
 *
 * 5. **新增 key 流程**
 *    a. 选定对应子文件 (init / run / gen / evolve / help / common)
 *    b. 在子文件的 `*MessageKey` union 里加新 key
 *    c. 在子文件的 dict 里同时给出 zh / en (Record 类型强制 zh/en 双写, 漏写
 *       tsc 直接报错)
 *    d. 自查: 中文里有没有非白名单的英文? 英文里有没有中文?
 *    e. 自查: 措辞自然度 — 把中文版念出来, 像不像中文项目的命令行输出?
 *    f. test/cli-i18n.test.ts 会跑 runtime parity 检查
 *
 * 未来扩 Lang (zh-TW / ja / ko ...): 改 src/types/shared.ts 的 Lang union,
 * Record 类型自动强制每 key 加新语言版本。
 */

import { commonDict, type CommonMessageKey } from './i18n-dict/common.js';
import { evolveDict, type EvolveMessageKey } from './i18n-dict/evolve.js';
import { genDict, type GenMessageKey } from './i18n-dict/gen.js';
import { helpDict, type HelpMessageKey } from './i18n-dict/help.js';
import { initDict, type InitMessageKey } from './i18n-dict/init.js';
import { installDict, type InstallMessageKey } from './i18n-dict/install.js';
import { listDict, type ListMessageKey } from './i18n-dict/list.js';
import { promoteDict, type PromoteMessageKey } from './i18n-dict/promote.js';
import { rollbackDict, type RollbackMessageKey } from './i18n-dict/rollback.js';
import { runDict, type RunMessageKey } from './i18n-dict/run.js';
import type { CliMessage } from './i18n-dict/types.js';

export type { CliMessage } from './i18n-dict/types.js';

export type CliMessageKey =
  | CommonMessageKey
  | EvolveMessageKey
  | GenMessageKey
  | HelpMessageKey
  | InitMessageKey
  | InstallMessageKey
  | ListMessageKey
  | PromoteMessageKey
  | RollbackMessageKey
  | RunMessageKey;

export const CLI_DICT: Record<CliMessageKey, CliMessage> = {
  ...commonDict,
  ...evolveDict,
  ...genDict,
  ...helpDict,
  ...initDict,
  ...installDict,
  ...listDict,
  ...promoteDict,
  ...rollbackDict,
  ...runDict,
};
