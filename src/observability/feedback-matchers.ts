/**
 * 用户文本反馈信号匹配器簇。
 *
 * 从用户消息文本里识别四类信号:
 *   - 用户纠正(user correction):「不对 / 不是 / 错了 / 你应该 / 重来」等
 *   - 目标切换(user goal shift):「换个方向 / 先不 / 另一个问题」等
 *   - 负向反馈(negative feedback):「没用 / 垃圾 / 做错了」等;高歧义词
 *     (「有问题 / 不行 / 不需要 / 看不懂 / 不符合」)需配合 BENIGN_NEGATIVE_*
 *     上下文规则排除「描述对象本身有问题」的中性表达
 *   - 正向反馈(positive feedback):「很好 / 做得好 / good job / awesome」等
 *
 * 每类信号提供两个 API:
 *   - findXxxMatches(text): 返回所有命中范围(TextMatchRange[]),供 renderer 高亮
 *   - hasXxxSignal(text): 命中即 true,供计数 / 判定逻辑
 *
 * 词表与上下文规则是观测语义的一部分,改动会影响 `negativeFeedbackCount`、
 * `positiveFeedbackCount`、`userCorrectionCount`、`userGoalShiftCount` 四个
 * indicators 字段的值,继而影响 Report 比较学。词表变更前先确认 inbox 测试
 * (`test/observability/inbox.test.ts`)的影响。
 *
 * 阶段 3 拆分历史:这些常量、helper、公开函数原本住在 `experience.ts` 末尾。
 * 拆出独立文件后,experience.ts 通过 re-export 维持对外签名兼容,renderer
 * 通过 feedback-projection facade 间接消费。
 */

export interface TextMatchRange {
  start: number;
  end: number;
}

const TEXT_BOUNDARY_CHARS = new Set([
  ' ', '\n', '\r', '\t',
  ',', '，', ';', '；', '、', '.', '。', '!', '！', '?', '？', ':', '：',
  '"', "'", '“', '”', '‘', '’', '(', ')', '[', ']', '{', '}', '<', '>', '《', '》',
]);
const BOUNDED_USER_CORRECTION_TERMS = ['不对', '不是', '错了'];
const PHRASE_USER_CORRECTION_TERMS = [
  '不是这个',
  '不要这样',
  '理解错',
  '看错',
  '你应该',
  '应该是',
  '直接用',
  '直接按',
  '改成',
  '重来',
];
const USER_GOAL_SHIFT_TERMS = [
  '换个方向',
  '重新来',
  '重来',
  '先不',
  '不用这个',
  '先不用',
  '暂时不用',
  '不看这个',
  '换一个',
  '换下一个',
  '另一个问题',
  '另外一个问题',
  '先看别的',
  '先处理别的',
  '新开一个',
  '新启动一个',
  '另开一个',
  '再开一个',
  '参考apply-cc的能力新开',
  '拉下最新',
  '拉取最新',
  '切到最新',
];
const NEGATIVE_FEEDBACK_TERMS = [
  '没有用',
  '没用',
  '太慢',
  '别再',
  '怎么又',
  '赶紧',
  '做错了',
  '做错',
  '完全错',
  '错得离谱',
  '很垃圾',
  '太垃圾',
  '乱来',
  '瞎搞',
  '白干',
  '浪费时间',
  '没有价值',
  '没价值',
  '没意义',
  '不好用',
  '用不了',
  '没有帮助',
  '没帮助',
  '毫无帮助',
  '太菜',
  '很菜',
  '真菜',
  '菜了',
  '菜啊',
];
const BOUNDED_NEGATIVE_FEEDBACK_TERMS = ['失败', '垃圾', '菜'];
// 高歧义负向词:前面紧跟描述对象的名词(代码 / 这段 / 这里 等)时是在描述对象有问题, 不算用户对 skill 的负向反馈。
// 命中后用 BENIGN_NEGATIVE_FEEDBACK_PREFIXES 做"先做不算"的紧邻前缀过滤, 命中即跳过。
// 详见 memory: feedback_keyword_context_rule.md。
const AMBIGUOUS_NEGATIVE_FEEDBACK_TERMS = ['有问题', '不需要', '看不懂', '不符合', '不行'];
// 紧邻命中即"在描述对象有问题, 不算用户对 skill 的负向反馈":
// 1. 前缀: <object> + 高歧义词        (代码有问题 / 逻辑不符合)
// 2. 前缀: <object>(里|中|上) + 高歧义词 (代码里不需要)
// 3. 后缀: 高歧义词 + 的<object>      (有问题的代码)
// 不放"方案/方法/做法/思路/样式/规范/标准"等评价类词, 这些前接"不行/不符合"通常是负向反馈。
const BENIGN_NEGATIVE_OBJECT_RE = /(?:代码|这段|这部分|这里|那里|文件|字段|逻辑|函数|接口|参数|配置|路径|目录|架构|写法|算法|文档|输出|结果|结构|文本|展示|渲染|输入|响应|脚本|代码块|代码段|代码片段|网络|信号|环境|机器|电脑)$/;
const BENIGN_NEGATIVE_OBJECT_LOC_RE = /(?:代码|文件|脚本|目录|文档|项目|仓库)(?:里|中|上)$/;
const BENIGN_NEGATIVE_OBJECT_SUFFIX_RE = /^的(?:代码|这段|这部分|逻辑|函数|接口|文件|字段|写法|算法|文档|脚本|实现|方法|方案|内容|结构|部分|地方|步骤|代码块|代码段|代码片段)/;
const ADDITIONAL_NEGATIVE_FEEDBACK_TERMS = [
  '不对',
  '错了',
  '有误',
  '不可以',
  '不是这个',
  '不是我要的',
  '跑偏',
  '绕路',
  '你没懂',
  '没懂',
  '重做',
  '重新做',
  '重来',
  '不符合预期',
];
const POSITIVE_FEEDBACK_TERMS = [
  '非常好',
  '很好',
  '做得好',
  '做的好',
  '做得不错',
  '做的不错',
  '不错',
  '很棒',
  '优秀',
  '厉害',
  '很厉害',
  '值得鼓励',
  '很有用',
  '非常有用',
  '很有价值',
  '非常有价值',
  '很有帮助',
  '非常有帮助',
  'good job',
  'great job',
  'well done',
  'nice work',
  'excellent',
  'awesome',
];

export function findUserCorrectionMatches(value: string): TextMatchRange[] {
  const ranges: TextMatchRange[] = [];
  for (const term of PHRASE_USER_CORRECTION_TERMS) {
    pushTermMatches(value, term, ranges, false);
  }
  for (const term of BOUNDED_USER_CORRECTION_TERMS) {
    pushTermMatches(value, term, ranges, true);
  }
  return ranges.sort((a, b) => a.start - b.start);
}

export function hasUserCorrectionSignal(value: string): boolean {
  return findUserCorrectionMatches(value).length > 0;
}

export function findUserGoalShiftMatches(value: string): TextMatchRange[] {
  const ranges: TextMatchRange[] = [];
  for (const term of USER_GOAL_SHIFT_TERMS) {
    pushTermMatches(value, term, ranges, false);
  }
  return ranges.sort((a, b) => a.start - b.start);
}

export function hasUserGoalShiftSignal(value: string): boolean {
  return findUserGoalShiftMatches(value).length > 0;
}

export function findNegativeFeedbackMatches(value: string): TextMatchRange[] {
  const ranges: TextMatchRange[] = [];
  for (const term of [...NEGATIVE_FEEDBACK_TERMS, ...ADDITIONAL_NEGATIVE_FEEDBACK_TERMS].sort((a, b) => b.length - a.length)) {
    pushTermMatches(value, term, ranges, false);
  }
  for (const term of [...BOUNDED_NEGATIVE_FEEDBACK_TERMS].sort((a, b) => b.length - a.length)) {
    pushTermMatches(value, term, ranges, true);
  }
  for (const term of [...AMBIGUOUS_NEGATIVE_FEEDBACK_TERMS].sort((a, b) => b.length - a.length)) {
    pushTermMatches(value, term, ranges, false, false, (haystack, index) => !isBenignNegativeFeedbackContext(haystack, index, term));
  }
  return ranges.sort((a, b) => a.start - b.start);
}

function isBenignNegativeFeedbackContext(value: string, hitIndex: number, term: string): boolean {
  const before = value.slice(Math.max(0, hitIndex - 6), hitIndex);
  if (BENIGN_NEGATIVE_OBJECT_RE.test(before)) return true;
  if (BENIGN_NEGATIVE_OBJECT_LOC_RE.test(before)) return true;
  const after = value.slice(hitIndex + term.length, hitIndex + term.length + 10);
  if (BENIGN_NEGATIVE_OBJECT_SUFFIX_RE.test(after)) return true;
  return false;
}

export function hasNegativeFeedbackSignal(value: string): boolean {
  return findNegativeFeedbackMatches(value).length > 0;
}

export function findPositiveFeedbackMatches(value: string): TextMatchRange[] {
  const ranges: TextMatchRange[] = [];
  for (const term of POSITIVE_FEEDBACK_TERMS) {
    pushTermMatches(value, term, ranges, false, true);
  }
  return ranges.sort((a, b) => a.start - b.start);
}

export function hasPositiveFeedbackSignal(value: string): boolean {
  return findPositiveFeedbackMatches(value).length > 0;
}

function pushTermMatches(
  value: string,
  term: string,
  ranges: TextMatchRange[],
  requireBoundary: boolean,
  caseInsensitive = false,
  contextAllow?: (value: string, index: number) => boolean,
): void {
  const haystack = caseInsensitive ? value.toLowerCase() : value;
  const needle = caseInsensitive ? term.toLowerCase() : term;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    const end = index + needle.length;
    if ((!requireBoundary || (isTextBoundary(value[index - 1]) && isTextBoundary(value[end])))
      && !ranges.some((range) => index < range.end && end > range.start)
      && (!contextAllow || contextAllow(value, index))) {
      ranges.push({ start: index, end });
    }
    index = haystack.indexOf(needle, index + needle.length);
  }
}

function isTextBoundary(value: string | undefined): boolean {
  if (value === undefined) return true;
  return TEXT_BOUNDARY_CHARS.has(value);
}
