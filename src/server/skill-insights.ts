/**
 * Insight detection — 把 4 类报告(doctor / eval-评分 / eval-功能 / observe)合并成
 * 一组结构化"问题",每个 Insight 自带:
 *   - audience: 该问题主要由谁来修(skill-author / sample-author / omk-maintainer)
 *   - 多 perspective 的证据(支持现象证据 illustration: 真实 prompt / LLM 输出 / 工具调用)
 *   - 改进建议(可带可粘贴 patch 片段)
 *
 * 设计原则:
 *   - 用户语去黑话:title/message 写成"用户能复现的现象",不直接吐 omk 内部枚举
 *   - 受众 explicit:每条 insight 标谁该 own,UI 拆区,不让 skill 开发者看 omk 维护待办
 *   - action 错位修对:环境拦截 → sample.mocks(不是 skill);doctor 盲区 → omk(不是 skill)
 *   - 现象 > 统计:展开 1-2 条真实 sample 的 prompt/output/toolCall 让用户"看见"问题
 *   - 可粘贴 patch:推荐带文件位置 + 代码片段,不只是"改一段"的空话
 *
 * 6 类 detection(audience 标在每条):
 *   1. environment-blocked-mocks   sample-author  评测环境 mock 列表盖不全
 *   2. skill-doc-gap               skill-author + sample-author  skill 文档某段缺/模糊 + sample environment 没声明
 *   3. failure-mode-skill          skill-author   skill 写法上的反模式(硬编码/幻觉/跳步/误读)
 *   4. coverage-gap                sample-author  生产 + 评测都漏的文件
 *   5. production-instability      skill-author + sample-author  真实环境失败率高
 *   6. skill-too-long              skill-author   skill 文档过长 LLM 找不到段落
 *   7. omk-doctor-blindspot        omk-maintainer doctor 应该卡却没规则的反模式
 */
import type { EvaluationReport, VariantResult, ToolCallInfo } from '../types/index.js';
import type { SkillIndexEntry, SkillDoctorSnapshot, SkillObserveSnapshot, SkillEvalSnapshot } from './skill-index.js';

export type InsightCategory =
  | 'environment-blocked-mocks'
  | 'skill-doc-gap'
  | 'failure-mode-skill'
  | 'coverage-gap'
  | 'production-instability'
  | 'skill-too-long'
  | 'omk-doctor-blindspot'
  | 'other';

export type InsightSeverity = 'high' | 'medium' | 'low';

export type InsightAudience = 'skill-author' | 'sample-author' | 'omk-maintainer';

export type InsightPerspective = 'doctor' | 'eval-score' | 'eval-functional' | 'observe';

/** 现象证据:把抽象"X 模式 N 条"翻译成用户能看到的具体行为。 */
export interface InsightIllustration {
  sampleId: string;
  /** 用户给 LLM 的 prompt(截断到 ~200 字)。 */
  samplePrompt?: string;
  /** LLM 最终输出(截断到 ~200 字)。 */
  llmOutput?: string;
  /** LLM 实际调的工具(简化字符串列表,顺序保留)。 */
  toolCalls?: string[];
  /** 哪条 assertion 没过 + value。 */
  failedAssertion?: string;
}

export interface InsightEvidence {
  perspective: InsightPerspective;
  status: 'flagged' | 'blind' | 'silent' | 'na';
  /** 简短说明(用户语,不堆术语)。 */
  message: string;
  ref?: string;
  /** 如果有现象证据,展开看 1-2 条具体 sample 的实际 prompt/output/toolCalls。 */
  illustrations?: InsightIllustration[];
}

/** 可粘贴的 patch 片段。target 指明改哪种文件,location 是文件/章节,snippet 是代码块。 */
export interface InsightPatch {
  target: 'skill' | 'sample-environment' | 'sample-mocks' | 'doctor-rule';
  /** 目标位置描述,如 'sample s003 的 mocks 数组' / 'SKILL.md「项目创建」节'。 */
  location: string;
  /** 代码块或 diff 片段。 */
  snippet: string;
}

export interface InsightRecommendation {
  action: string;
  priority: InsightSeverity;
  patch?: InsightPatch;
}

export interface Insight {
  id: string;
  category: InsightCategory;
  audience: InsightAudience;
  /** 用户语标题。 */
  title: string;
  /** 一句话现象描述(标题之外的细节)。 */
  description?: string;
  severity: InsightSeverity;
  affectedCount: number;
  evidence: InsightEvidence[];
  recommendations: InsightRecommendation[];
}

// ────────── helpers ──────────

interface FailedSample {
  sampleId: string;
  rootCause: string[];
  failureModes: string[];
  diagnosticSummary: string;
  prompt?: string;
  llmOutput?: string;
  toolCalls?: string[];
  firstFailedAssertion?: string;
}

function getVariantName(report: EvaluationReport): string | null {
  return report.meta.variants?.find((v) => v !== 'baseline') ?? null;
}

function summarizeToolCall(tc: ToolCallInfo): string {
  const tool = tc.tool;
  const inp = tc.input as { command?: string; file_path?: string; url?: string; query?: string } | undefined | null;
  let arg = '';
  if (inp) {
    if (typeof inp.command === 'string') arg = inp.command.slice(0, 60);
    else if (typeof inp.file_path === 'string') arg = inp.file_path;
    else if (typeof inp.url === 'string') arg = inp.url;
    else if (typeof inp.query === 'string') arg = inp.query.slice(0, 50);
  }
  const status = tc.success ? '' : ' [失败]';
  return arg ? `${tool}: ${arg}${status}` : `${tool}${status}`;
}

function getFailedSamples(report: EvaluationReport, variant: string): FailedSample[] {
  const out: FailedSample[] = [];
  for (const r of report.results) {
    const v: VariantResult | undefined = r.variants?.[variant];
    if (!v) continue;
    const passed = (v.assertions?.details ?? []).every((d) => d.passed);
    if (passed) continue;
    const isTripwire = (v.diagnostic?.rootCause || []).includes('tripwire_intentional')
      || report.sampleSnapshots?.[r.sample_id]?.tripwire === true;
    if (isTripwire) continue;
    const firstFail = v.assertions?.details?.find((d) => !d.passed);
    out.push({
      sampleId: r.sample_id,
      rootCause: (v.diagnostic?.rootCause ?? []) as string[],
      failureModes: (v.diagnostic?.failureModes ?? []) as string[],
      diagnosticSummary: v.diagnostic?.summary ?? '',
      prompt: report.sampleSnapshots?.[r.sample_id]?.prompt,
      llmOutput: v.outputPreview ?? undefined,
      toolCalls: v.toolCalls?.slice(0, 6).map(summarizeToolCall),
      firstFailedAssertion: firstFail
        ? `${firstFail.type}: ${typeof firstFail.value === 'object' ? JSON.stringify(firstFail.value) : String(firstFail.value)}`
        : undefined,
    });
  }
  return out;
}

function severityOfCount(n: number): InsightSeverity {
  if (n >= 3) return 'high';
  if (n >= 2) return 'medium';
  return 'low';
}

function pickIllustrations(samples: FailedSample[], n = 2): InsightIllustration[] {
  return samples.slice(0, n).map((s) => ({
    sampleId: s.sampleId,
    samplePrompt: s.prompt?.slice(0, 200),
    llmOutput: s.llmOutput?.slice(0, 200),
    toolCalls: s.toolCalls,
    failedAssertion: s.firstFailedAssertion,
  }));
}

// ────────── 7 类 detection ──────────

/** failureMode `环境拦截` cluster — 实际是 sample 设计问题,不是 skill 问题。 */
function detectEnvironmentBlocked(evalReport: EvaluationReport | null): Insight | null {
  if (!evalReport) return null;
  const variant = getVariantName(evalReport);
  if (!variant) return null;
  const failed = getFailedSamples(evalReport, variant);
  const blocked = failed.filter((f) => f.failureModes.includes('环境拦截'));
  if (blocked.length < 2) return null;

  const sampleIds = blocked.map((s) => s.sampleId).join(', ');
  return {
    id: 'environment-blocked-mocks',
    category: 'environment-blocked-mocks',
    audience: 'sample-author',
    title: `${blocked.length} 条评测样本因 mock 没盖到 LLM 想调的工具而 fail`,
    description: 'LLM 行为正确但工具调用被 mock-strict 拦截 — 这是 sample 设计问题,不是 skill 问题。要么 mock 列表漏写,要么 command_glob/file_path 写得太严没匹配到 LLM 真实调用。',
    severity: severityOfCount(blocked.length),
    affectedCount: blocked.length,
    evidence: [
      {
        perspective: 'eval-functional', status: 'flagged',
        message: `sample ${sampleIds} 失败模式都是「环境拦截」(LLM 调用被 mocks-strict deny)`,
        ref: blocked[0].sampleId,
        illustrations: pickIllustrations(blocked, 2),
      },
      {
        perspective: 'doctor', status: 'silent',
        message: 'doctor 不检查 mock 设计完备性(超出静态体检范围)',
      },
    ],
    recommendations: [
      {
        action: `复查 sample ${blocked[0].sampleId} 的 mocks 列表,确认 LLM 实际调用形态被覆盖`,
        priority: severityOfCount(blocked.length),
        patch: {
          target: 'sample-mocks',
          location: `sample ${blocked[0].sampleId} 的 mocks 数组`,
          snippet: `// 看 LLM 实际调了什么(toolCalls 里),把缺的工具加进去
{
  "tool": "Bash",  // 或 Read/WebFetch 等,跟 illustration 里的 toolCalls 对上
  "match": { "command_glob": "*<LLM 实际调的命令片段>*" },
  "return": { "stdout": "<模拟成功输出>", "exit": 0 }
}`,
        },
      },
      {
        action: 'file_path 严格匹配挂的话,改用 file_path_endswith 后缀匹配',
        priority: 'medium',
        patch: {
          target: 'sample-mocks',
          location: '所有 file_path 严格相等的 mock',
          snippet: `// before: { "match": { "file_path": "tasks/state.json" } }
// after:
{ "match": { "file_path_endswith": "tasks/state.json" } }`,
        },
      },
    ],
  };
}

/** sample.environment.files_available 缺声明 + skill 文档没强调依赖。 */
function detectSkillDocGap(
  doctor: SkillDoctorSnapshot | null,
  evalReport: EvaluationReport | null,
  observe: SkillObserveSnapshot | null,
): Insight | null {
  const depRule = doctor?.results.find((r) => r.ruleId === 'dependencies_present'
    && (r.status === 'warn' || r.status === 'fail'));
  let failedDocSamples: FailedSample[] = [];
  if (evalReport) {
    const variant = getVariantName(evalReport);
    if (variant) {
      failedDocSamples = getFailedSamples(evalReport, variant).filter((f) =>
        f.rootCause.includes('skill_doc_missing') || f.rootCause.includes('skill_doc_unclear'),
      );
    }
  }
  if (!depRule && failedDocSamples.length === 0) return null;

  const missingFiles = (depRule?.detail?.missing_files as string[] | undefined) ?? [];
  const exampleFile = missingFiles[0] ?? 'XXX.md';

  const evidence: InsightEvidence[] = [];
  evidence.push(depRule
    ? {
        perspective: 'doctor', status: 'flagged',
        message: `doctor 静态检查:skill 引用了 ${missingFiles.length || 1} 个文件但 sample 没声明已就绪${missingFiles.length > 0 ? ` (${missingFiles.join(', ')})` : ''}`,
        ref: depRule.ruleId,
      }
    : {
        perspective: 'doctor', status: 'blind',
        message: 'eval 失败 sample 标 skill 文档缺漏,但 doctor 没卡 — 文档可能写得不规范但 doctor 规则识别不出',
      });
  if (failedDocSamples.length > 0) {
    evidence.push({
      perspective: 'eval-functional', status: 'flagged',
      message: `${failedDocSamples.length} 条评测样本失败,LLM 没找到该读哪段文档(${failedDocSamples.map((f) => f.sampleId).join(', ')})`,
      ref: failedDocSamples[0].sampleId,
      illustrations: pickIllustrations(failedDocSamples, 2),
    });
  } else {
    evidence.push({
      perspective: 'eval-functional', status: 'silent',
      message: '本批 evaluation 没命中文档缺漏类失败',
    });
  }
  evidence.push(observe
    ? observe.gapRate >= 0.2
      ? {
          perspective: 'observe', status: 'flagged',
          message: `生产里 ${(observe.gapRate * 100).toFixed(0)}% 段也命中知识库 gap(LLM 找不到该读哪段) — 跟评测信号印证`,
        }
      : {
          perspective: 'observe', status: 'silent',
          message: `生产 gap 率 ${(observe.gapRate * 100).toFixed(0)}%,真实使用中此问题触发不多`,
        }
    : { perspective: 'observe', status: 'na', message: '没跑 observe,无法看真实生产是否也踩' });

  const severity: InsightSeverity = (depRule && failedDocSamples.length >= 2) ? 'high'
    : failedDocSamples.length >= 2 || depRule ? 'medium' : 'low';

  const recs: InsightRecommendation[] = [];
  if (depRule) {
    recs.push({
      action: `在 sample.environment.files_available 加上文件路径,告诉 LLM "这些文件已就绪,无需探测"`,
      priority: severity,
      patch: {
        target: 'sample-environment',
        location: 'samples.json 各 sample 的 environment 块',
        snippet: `"environment": {
  "files_available": [
    "${exampleFile}"${missingFiles.length > 1 ? `,
    "${missingFiles[1]}"` : ''}
  ],
  "notes": "所有依赖文件已就绪,LLM 跳过探测直接进工作流"
}`,
      },
    });
  }
  if (failedDocSamples.length > 0) {
    recs.push({
      action: `在 SKILL.md 引用这些文件的章节加显眼提示,LLM 容易漏读`,
      priority: severity,
      patch: {
        target: 'skill',
        location: 'SKILL.md 中引用 ' + (missingFiles[0] ?? '相关文件') + ' 的章节',
        snippet: `## <相关章节>

⚠️ **必读前置**:本步骤依赖 \`${exampleFile}\` 中的内容,务必先 Read 该文件再继续。

<原步骤说明>...`,
      },
    });
  }

  return {
    id: 'skill-doc-gap',
    category: 'skill-doc-gap',
    audience: failedDocSamples.length > 0 ? 'skill-author' : 'sample-author',
    title: failedDocSamples.length > 0
      ? `LLM 漏读 skill 引用的文件,导致 ${failedDocSamples.length} 条样本失败`
      : 'skill 引用了文件但没声明在 sample.environment 里',
    description: 'skill 文档提到某些前置文件,但 sample 没标"已就绪"。LLM 看 prompt 时会试图先探测/Read 这些文件,在 mocks-strict 环境下被拦,流程在第一步就停。',
    severity,
    affectedCount: failedDocSamples.length || 1,
    evidence,
    recommendations: recs,
  };
}

/** failureMode 是 skill 写法层反模式(硬编码/幻觉/跳步/误读) — 真要改 skill。 */
function detectFailureModeSkillIssue(evalReport: EvaluationReport | null): Insight | null {
  if (!evalReport) return null;
  const variant = getVariantName(evalReport);
  if (!variant) return null;
  const failed = getFailedSamples(evalReport, variant);
  if (failed.length === 0) return null;

  const SKILL_MODES = new Set(['硬编码值', '幻觉输出', '工作流跳步', '误读约束', '工具误用']);

  // 排除已被 skill-doc-gap 覆盖的(rootCause skill_doc_missing/unclear)
  const candidates = failed.filter((f) => {
    const docIssue = f.rootCause.includes('skill_doc_missing') || f.rootCause.includes('skill_doc_unclear');
    if (docIssue) return false;
    return f.failureModes.some((m) => SKILL_MODES.has(m));
  });

  // 找最大簇 — 同 failureMode 在 ≥ 2 sample
  const modeCount: Record<string, FailedSample[]> = {};
  for (const f of candidates) {
    for (const m of f.failureModes) {
      if (!SKILL_MODES.has(m)) continue;
      if (!modeCount[m]) modeCount[m] = [];
      modeCount[m].push(f);
    }
  }
  const top = Object.entries(modeCount).filter(([, fs]) => fs.length >= 2)
    .sort((a, b) => b[1].length - a[1].length);
  if (top.length === 0) return null;

  const [topMode, topSamples] = top[0];

  const MODE_USERFACING_DESC: Record<string, string> = {
    '硬编码值': 'LLM 把本来该用变量传的值写死(如 namespace 直接写成 "testuser001")',
    '幻觉输出': 'LLM 声称完成了某动作但实际没调对应工具,输出虚构 id / commit hash / 文件路径',
    '工作流跳步': 'LLM 没按 skill 教的步骤顺序走,跳过了关键中间步骤',
    '误读约束': 'skill 文档里写清楚的约束(如"必须用 X 不能用 Y")LLM 没遵守',
    '工具误用': 'LLM 选错工具或传错参数,反复尝试同一失败动作',
  };

  const MODE_PATCH_HINT: Record<string, { location: string; snippet: string }> = {
    '硬编码值': {
      location: 'SKILL.md 涉及具体值传递的章节(如「参数获取」「身份注入」节)',
      snippet: `# Before(LLM 容易硬编码):
直接把 namespace 设成 "testuser001"。

# After(强制变量化):
**严禁**直接写死 namespace。先调 \`<your-cli> auth status -o json\` 拿到 username,赋给变量后再传:
\`\`\`bash
NAMESPACE=$(<your-cli> auth status -o json | jq -r '.username')
<your-cli> project create --namespace "$NAMESPACE"
\`\`\``,
    },
    '幻觉输出': {
      location: 'SKILL.md 涉及工具调用结果回传的章节',
      snippet: `# 加显眼"诚实输出"约束:
**严禁**编造 commit hash / id / 文件路径等关键标识符。这些值**必须**从前一步工具调用的真实返回里提取,不能凭印象写。
若工具调用失败,如实告知用户失败原因,**不要**伪装成功。`,
    },
    '工作流跳步': {
      location: 'SKILL.md 工作流章节(如「步骤 1...步骤 N」)',
      snippet: `# 用编号 + 必做标记强化顺序:
## 工作流(必须按序执行)
1. **第 1 步必做**: <动作 A>
2. **第 2 步必做**: <动作 B,依赖第 1 步的输出>
3. **第 3 步可选**: <分支 C>

每完成一步,在响应中明确说"已完成第 N 步: ..."`,
    },
    '误读约束': {
      location: 'SKILL.md 中相关约束的位置',
      snippet: `# 把约束抬到段落开头 + 加 ⚠️/❌:
⚠️ **硬规则**: 必须用 \`<工具 A>\`,**严禁**用 \`<工具 B>\` 绕过。
原因: <为什么>。
<原步骤说明>`,
    },
    '工具误用': {
      location: 'SKILL.md 工具选择章节',
      snippet: `# 加工具选择对照表:
| 场景 | 用 | 不用 |
|------|----|------|
| 查询 X | tool-A | tool-B(参数语义不一样) |
...`,
    },
  };

  return {
    id: `failure-mode-skill:${topMode}`,
    category: 'failure-mode-skill',
    audience: 'skill-author',
    title: `${topSamples.length} 条样本踩同一个写法坑:${topMode}`,
    description: MODE_USERFACING_DESC[topMode] ?? `多 sample 共享 failureMode 「${topMode}」,skill 文档对此没抑制`,
    severity: severityOfCount(topSamples.length),
    affectedCount: topSamples.length,
    evidence: [
      {
        perspective: 'eval-functional', status: 'flagged',
        message: `sample ${topSamples.map((s) => s.sampleId).join(', ')} 都因「${topMode}」失败 — 单一原因反复踩,说明 skill 没抑制这种写法`,
        ref: topSamples[0].sampleId,
        illustrations: pickIllustrations(topSamples, 2),
      },
    ],
    recommendations: [
      {
        action: `在 SKILL.md 中针对「${topMode}」加专门提示`,
        priority: severityOfCount(topSamples.length),
        ...(MODE_PATCH_HINT[topMode] ? {
          patch: {
            target: 'skill',
            location: MODE_PATCH_HINT[topMode].location,
            snippet: MODE_PATCH_HINT[topMode].snippet,
          },
        } : {}),
      },
      {
        action: '加针对该模式的诱错样本(tripwire),防止 skill 改进后再退化',
        priority: 'low',
      },
    ],
  };
}

/** observe 高失败率 — 真实环境 skill 跑不稳。 */
function detectProductionInstability(
  doctor: SkillDoctorSnapshot | null,
  observe: SkillObserveSnapshot | null,
): Insight | null {
  if (!observe || observe.failureRate < 0.4) return null;
  const depRule = doctor?.results.find((r) => r.ruleId === 'dependencies_present'
    && (r.status === 'warn' || r.status === 'fail'));

  return {
    id: 'production-instability',
    category: 'production-instability',
    audience: 'skill-author',
    title: `生产环境跑这个 skill 时,工具失败率 ${(observe.failureRate * 100).toFixed(0)}%`,
    description: '真实用户用这个 skill,LLM 调出去的工具经常报错。可能是凭证/网络/上游 SLA 问题,也可能是 skill 教错了用什么工具/参数。',
    severity: 'high',
    affectedCount: Math.round(observe.segmentCount * observe.failureRate),
    evidence: [
      {
        perspective: 'observe', status: 'flagged',
        message: `${observe.segmentCount} 段产线轨迹,工具调用失败率 ${(observe.failureRate * 100).toFixed(0)}%`,
      },
      depRule
        ? {
            perspective: 'doctor', status: 'flagged',
            message: `doctor 也警告依赖问题:${depRule.message}`,
            ref: depRule.ruleId,
          }
        : {
            perspective: 'doctor', status: doctor ? 'silent' : 'na',
            message: doctor
              ? 'doctor 没警告依赖,失败可能在 CLI/凭证/上游 API 层(skill 自身可能没错)'
              : '没跑 doctor,无法对照',
          },
    ],
    recommendations: [
      {
        action: '排查产线工具失败原因:CLI 安装 / 凭证有效期 / 网络 / 上游 API SLA',
        priority: 'high',
      },
      ...(depRule ? [{
        action: '依据 doctor 警告补依赖声明 / 改 skill 引用',
        priority: 'high' as InsightSeverity,
      }] : []),
      {
        action: '如果不是 skill 写错而是环境问题,在 skill 加重试 / 容错指南',
        priority: 'medium' as InsightSeverity,
        patch: {
          target: 'skill',
          location: 'SKILL.md 工具调用章节',
          snippet: `# 容错指南:
若 \`<工具>\` 调用失败:
1. 检查环境(凭证 / 网络 / 工具版本)
2. 重试 1-2 次
3. 仍失败:**如实告知用户**,不要继续假装完成`,
        },
      },
    ],
  };
}

/** observe gap + eval coverage 漏 — sample 没盖到生产真实使用的文件。 */
function detectCoverageGap(
  evalReport: EvaluationReport | null,
  observe: SkillObserveSnapshot | null,
): Insight | null {
  if (!observe || observe.gapRate === 0) return null;
  let evalUncovered: string[] = [];
  if (evalReport?.analysis?.coverage) {
    const variant = getVariantName(evalReport);
    if (variant && evalReport.analysis.coverage[variant]) {
      evalUncovered = evalReport.analysis.coverage[variant].uncoveredFiles || [];
    }
  }

  const evidence: InsightEvidence[] = [
    {
      perspective: 'observe', status: 'flagged',
      message: `生产里 ${(observe.gapRate * 100).toFixed(0)}% 段命中知识库 gap — LLM 在真实使用中找不到该读哪段`,
    },
  ];
  if (evalUncovered.length > 0) {
    evidence.push({
      perspective: 'eval-functional', status: 'flagged',
      message: `评测样本也漏覆盖 ${evalUncovered.length} 个文件:${evalUncovered.slice(0, 3).join(', ')}${evalUncovered.length > 3 ? '...' : ''}`,
    });
  } else {
    evidence.push({
      perspective: 'eval-functional', status: 'silent',
      message: '评测覆盖率 OK,gap 主要来自生产用法跟 sample 设计有差距',
    });
  }

  const severity: InsightSeverity = observe.gapRate >= 0.4 ? 'high'
    : observe.gapRate >= 0.2 ? 'medium' : 'low';

  return {
    id: 'coverage-gap',
    category: 'coverage-gap',
    audience: 'sample-author',
    title: '生产 + 评测都没覆盖到部分知识库文件',
    description: '观测到生产用户访问了 skill 引用的某些文件,但你的评测 sample 没测到这些路径 — sample 设计跟真实使用脱节。',
    severity,
    affectedCount: Math.max(evalUncovered.length, Math.round(observe.segmentCount * observe.gapRate)),
    evidence,
    recommendations: [
      ...(evalUncovered.length > 0
        ? [{
          action: `补 1-2 条 sample 专门测覆盖这些文件:${evalUncovered.slice(0, 2).join(', ')}`,
          priority: severity,
          patch: {
            target: 'sample-environment' as const,
            location: 'samples.json 加新 sample',
            snippet: `{
  "sample_id": "s${String(99).padStart(3, '0')}",
  "prompt": "<让 LLM 必须读 ${evalUncovered[0]} 才能完成的任务>",
  "rubric": "应该 Read ${evalUncovered[0]} 后再继续",
  "assertions": [
    { "type": "tool_input_contains", "value": "Read:${evalUncovered[0]}", "weight": 1 }
  ],
  "environment": { "files_available": ["${evalUncovered[0]}"] }
}`,
          },
        }]
        : []),
      {
        action: '检查 skill 是否引用了实际不存在 / 不该引用的文件,清理冗余引用',
        priority: 'low',
      },
    ],
  };
}

/** doctor skill_readable warn — skill 文档过长。 */
function detectSkillTooLong(
  doctor: SkillDoctorSnapshot | null,
  observe: SkillObserveSnapshot | null,
): Insight | null {
  const readableRule = doctor?.results.find((r) => r.ruleId === 'skill_readable' && r.status === 'warn');
  if (!readableRule) return null;

  const evidence: InsightEvidence[] = [
    { perspective: 'doctor', status: 'flagged', message: readableRule.message, ref: readableRule.ruleId },
  ];
  if (observe && observe.gapRate >= 0.2) {
    evidence.push({
      perspective: 'observe', status: 'flagged',
      message: `生产 gap ${(observe.gapRate * 100).toFixed(0)}% — 长 skill 让 LLM 找不到段落,跟 doctor 警告印证`,
    });
  }
  return {
    id: 'skill-too-long',
    category: 'skill-too-long',
    audience: 'skill-author',
    title: 'skill 文档太长,LLM 容易漏读',
    description: 'skill 内容超过推荐上限。长 skill 在 LLM 上下文里会被压缩注意力,LLM 跟着前几段走,后面的关键约束容易漏读。',
    severity: observe && observe.gapRate >= 0.3 ? 'medium' : 'low',
    affectedCount: 1,
    evidence,
    recommendations: [
      {
        action: '把示例 / 长段移到 references/ 子文件,SKILL.md 主体保持精简',
        priority: 'medium',
        patch: {
          target: 'skill',
          location: 'SKILL.md + 新建 references/ 目录',
          snippet: `# 拆分前(SKILL.md 18000 字)
## 工作流详解
<2000 字详细示例 1>
<2000 字详细示例 2>
...

# 拆分后(SKILL.md 主体 5000 字)
## 工作流(简版)
- 步骤 A:见 [references/workflow-a.md](references/workflow-a.md) 的详细示例
- 步骤 B:见 [references/workflow-b.md](references/workflow-b.md)`,
        },
      },
      {
        action: '考虑拆成多个子 skill,各负责单一职责',
        priority: 'low',
      },
    ],
  };
}

/** doctor 盲区 — 多个 sample 同 failureMode 但 doctor 无对应规则。属于 omk 维护者待办。 */
function detectOmkDoctorBlindspot(
  doctor: SkillDoctorSnapshot | null,
  evalReport: EvaluationReport | null,
): Insight | null {
  if (!evalReport) return null;
  const variant = getVariantName(evalReport);
  if (!variant) return null;
  const failed = getFailedSamples(evalReport, variant);
  const SKILL_MODES = new Set(['硬编码值', '幻觉输出', '工作流跳步', '误读约束']);

  const candidates = failed.filter((f) => {
    const docIssue = f.rootCause.includes('skill_doc_missing') || f.rootCause.includes('skill_doc_unclear');
    if (docIssue) return false;
    return f.failureModes.some((m) => SKILL_MODES.has(m));
  });
  if (candidates.length < 2) return null;

  const observedModes = [...new Set(candidates.flatMap((c) => c.failureModes.filter((m) => SKILL_MODES.has(m))))];

  return {
    id: 'omk-doctor-blindspot',
    category: 'omk-doctor-blindspot',
    audience: 'omk-maintainer',
    title: `omk 工具反馈:doctor 没规则识别 ${observedModes.join(' / ')} 类反模式`,
    description: '本次评测里 ≥ 2 条 sample 因这些行为反模式失败,但 doctor 跑下来全 pass。说明 doctor 当前规则覆盖不到这类问题 — 给 omk 仓库提 issue 加 composer rule 即可。普通 skill 开发者可忽略本条。',
    severity: candidates.length >= 3 ? 'medium' : 'low',
    affectedCount: candidates.length,
    evidence: [
      {
        perspective: 'eval-functional', status: 'flagged',
        message: `${candidates.length} 条样本因 ${observedModes.join(' / ')} 失败,doctor 全 pass`,
        ref: candidates[0].sampleId,
      },
      {
        perspective: 'doctor',
        status: doctor ? 'blind' : 'na',
        message: doctor
          ? `doctor 当前 BUILTIN_RULES 不含这类反模式检测 — 需 omk 加 LLM-judge composer rule`
          : '没跑 doctor 无法对照',
      },
    ],
    recommendations: [
      {
        action: '给 omk 仓库提 issue:doctor 加 composer rule 识别 ' + observedModes.join(' / ') + ' 类反模式',
        priority: 'medium',
        patch: {
          target: 'doctor-rule',
          location: 'omk 仓库 src/doctor/health/(新建 composer rule)',
          snippet: `// omk 仓库新增 composer rule(omk 维护者负责,非 skill 开发者职责)
export const skillAntiPatternComposer: ComposerRule = {
  id: 'skill_anti_patterns',
  kind: 'composer',
  severity: 'warn',
  labelKey: 'doctor.skill_anti_patterns.label',
  async checkAll(ctx): Promise<ComposerOutcome[]> {
    // 用 LLM judge 扫 skill 文本,识别 ${observedModes.join(' / ')} 等反模式
    return [...];
  },
};`,
        },
      },
    ],
  };
}

// ────────── 入口 ──────────

const SEVERITY_RANK: Record<InsightSeverity, number> = { high: 3, medium: 2, low: 1 };

export function detectInsights(
  entry: SkillIndexEntry,
  evalReport: EvaluationReport | null,
): Insight[] {
  const out: Insight[] = [];
  const detectors: Array<() => Insight | null> = [
    () => detectEnvironmentBlocked(evalReport),
    () => detectSkillDocGap(entry.doctor, evalReport, entry.observe),
    () => detectFailureModeSkillIssue(evalReport),
    () => detectCoverageGap(evalReport, entry.observe),
    () => detectProductionInstability(entry.doctor, entry.observe),
    () => detectSkillTooLong(entry.doctor, entry.observe),
    () => detectOmkDoctorBlindspot(entry.doctor, evalReport),
  ];
  for (const detect of detectors) {
    const ins = detect();
    if (ins) out.push(ins);
  }
  out.sort((a, b) => {
    const sa = SEVERITY_RANK[a.severity];
    const sb = SEVERITY_RANK[b.severity];
    if (sa !== sb) return sb - sa;
    return b.affectedCount - a.affectedCount;
  });
  return out;
}

export function flattenRecommendations(insights: Insight[]): InsightRecommendation[] {
  const seen = new Map<string, InsightRecommendation>();
  for (const ins of insights) {
    for (const rec of ins.recommendations) {
      const prev = seen.get(rec.action);
      if (!prev || SEVERITY_RANK[rec.priority] > SEVERITY_RANK[prev.priority]) {
        seen.set(rec.action, rec);
      }
    }
  }
  return [...seen.values()].sort((a, b) => SEVERITY_RANK[b.priority] - SEVERITY_RANK[a.priority]);
}

/** 按 audience 分桶 — UI 拆区用。 */
export function groupInsightsByAudience(insights: Insight[]): Record<InsightAudience, Insight[]> {
  const out: Record<InsightAudience, Insight[]> = {
    'skill-author': [],
    'sample-author': [],
    'omk-maintainer': [],
  };
  for (const ins of insights) out[ins.audience].push(ins);
  return out;
}

export type _SkillEvalSnapshotForInsight = SkillEvalSnapshot;
