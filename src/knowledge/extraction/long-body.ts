import { z } from 'zod';
import { SourceDigestSchema, sourceSetPreimage, type SourceSnapshot } from '../sources/sources.js';
import { canonicalJson } from '../store.js';
import { BODY_GENERATION_PROFILE, BODY_PASSAGE_INDEX_ECHO, BodyGenerationResponseSchema, checkGeneratedBodies,
  freezeGenerationWire, generationTextDigest, strictGenerationWire, type GenerationProfile } from './body-generation-wire.js';
import { bodyGenerationSources } from './source-input.js';
import type { SourcePassageRange } from './source-passages.js';

const PLAN_VERSION = 'knowledge-long-body-plan/v1';
export const LONG_BODY_WINDOW_INPUT_VERSION = 'knowledge-body-window-input/v2';
const MAX_WINDOWS = 8;
const WINDOW_PASSAGE_BYTES = 128 * 1024;
const WINDOW_INPUT_BYTES = 192 * 1024;
const WINDOW_OUTPUT_BYTES = 24 * 1024;
const MAX_WINDOW_PROPOSALS = 4;
const MAX_WINDOW_PROPOSAL_SEGMENTS = 2;
const MAX_WINDOW_SEGMENTS = 6;
const STAGE_TIMEOUT_MS = 150_000;
const passageId = z.string().regex(/^p(?:0|[1-9][0-9]*)$/u);

export class LongBodyCapacityError extends Error {
  override readonly name = 'LongBodyCapacityError';
}

export const LongBodyPlanSchema = z.strictObject({
  planVersion: z.literal(PLAN_VERSION),
  planDigest: SourceDigestSchema,
  passageIndexDigest: SourceDigestSchema,
  windows: z.array(z.strictObject({
    startPassageId: passageId,
    endPassageId: passageId,
    visiblePassageCount: z.number().int().positive(),
  })).min(1).max(MAX_WINDOWS),
});
export type LongBodyPlan = z.infer<typeof LongBodyPlanSchema>;

export const BodyWindowGenerationResponseSchema = BodyGenerationResponseSchema.omit({ passageIndexDigest: true }).extend({
  responseKind: z.literal('knowledge-body-window-generation'), schemaVersion: z.literal(1),
});

const WINDOW_SYSTEM = BODY_GENERATION_PROFILE.system.replace(`${BODY_PASSAGE_INDEX_ECHO}\n`, '') + '\n\n' + `【有界正文窗口】本请求使用 ${LONG_BODY_WINDOW_INPUT_VERSION}，bodyWindow 标识完整来源中的一段连续窗口。以下窗口约束优先于前文关于完整来源、writingDraft.text 与全量输出的指令。输入的 passageIndexDigest 和来源标识仍由宿主绑定完整原文，输出无需提供摘要。引文端点和中间片段都必须在本次可见窗口内。writingDraft 的 ref 标识同源归档的未核验写作稿；若提供 writingDraft.text，它是完整草稿，只用于查找线索，可能包含其他窗口的说法；若只提供 ref，则直接使用本窗口原文。只写本窗口可见原文支持的说法。本次独立核对窗口原文，提炼对未来任务有用的事实和方法，保留精确数量、归属、时间、条件及例外。合并重复并略去泛泛建议。每个同组主张用足以回查的最少连续原文范围，只有归因或推断不明确时增加解释。只返回窗口正文 JSON，不声明窗口之外的情况。宿主验证全部窗口结果后才正式保存正文。

【本窗口的有限工作量】输出一至四篇，每篇至多两段，总共至多六段；每段至多约 180 个汉字，只引支持该段的必要范围，通常一条、需要两个时点或不同归属时可用两条。优先收录对未来决策有用、能精确回源的事实、方法和状态变化。合并同义内容，清楚保留旧状态和更新后的状态及时间，保留具体数量、条件和例外。其余暂不输出。确无可提炼内容时 proposals 可为空。

【时间与来源】时间顺序会影响判断时，若可见原文的会话标题、日期标记或来源元数据给出了记录日期，正文应保留该记录日期和其性质。引用同时覆盖承载说法的可见原文及可见的原文日期标记，必要时分开引用。记录日期与事实发生或生效时间分别说明，来源未提供的日期精度保持未知。

【挑选线索】若提供草稿，先找归档草稿中由本窗口原文支持、且会影响未来判断的具体用户状态、经历和变化。优先保留带数量、先后、相对时间或例外的用户自述，明确日期参照和时间精度。先为不同主题保留关键事实，再分配剩余段落写通用方法或建议。草稿没有写到的重要原文仍可选，草稿不能当证据。`;

function windowProfile(system: string): GenerationProfile {
  const stageKind = 'body_window', promptVersion = 'knowledge-body-window/v2', outputName = 'knowledge_body_window_v1';
  const domain = z.toJSONSchema(BodyWindowGenerationResponseSchema, { target: 'draft-2020-12', io: 'input', reused: 'ref',
    cycles: 'throw', unrepresentable: 'throw' });
  const wireSchema = strictGenerationWire(domain);
  const wireId = generationTextDigest(canonicalJson({ wireVersion: 'omk-knowledge-body-window-wire/v1', domain, wireSchema,
    mappingPolicy: 'host-window-passage-index-binding/v1', zodVersion: z.core.version }));
  const profileId = generationTextDigest(canonicalJson({ stageKind, promptVersion, inputVersion: LONG_BODY_WINDOW_INPUT_VERSION, planVersion: PLAN_VERSION,
    systemDigest: generationTextDigest(system), wireId, stageTimeoutMs: STAGE_TIMEOUT_MS }));
  freezeGenerationWire(wireSchema);
  return Object.freeze({ stageKind, profileId, promptVersion, system, wireId, outputName, wireSchema, stageTimeoutMs: STAGE_TIMEOUT_MS });
}
export const BODY_WINDOW_PROFILE = windowProfile(WINDOW_SYSTEM);

type FullProjection = ReturnType<typeof bodyGenerationSources>;
type WindowResponse = z.infer<typeof BodyWindowGenerationResponseSchema>;
type WindowWritingDraft = { ref: unknown; text: string };

function planProjection(projection: FullProjection): LongBodyPlan {
  const windows: LongBodyPlan['windows'] = [];
  let startPassageId: string | undefined, endPassageId = '', visiblePassageCount = 0, bytes = 2;
  const finish = () => {
    if (startPassageId === undefined) return;
    if (windows.length === MAX_WINDOWS) throw new LongBodyCapacityError(`Long body window count capacity exceeded: limit ${MAX_WINDOWS}.`);
    windows.push({ startPassageId, endPassageId, visiblePassageCount });
    startPassageId = undefined;
    visiblePassageCount = 0;
    bytes = 2;
  };
  for (const source of projection.sources) for (const excerpt of source.excerpts) for (const passage of excerpt.passages) {
    const passageBytes = Buffer.byteLength(canonicalJson(passage));
    if (passageBytes + 2 > WINDOW_PASSAGE_BYTES) {
      throw new LongBodyCapacityError(`Long body passage capacity exceeded: uses ${passageBytes + 2} bytes, limit ${WINDOW_PASSAGE_BYTES}.`);
    }
    if (visiblePassageCount && bytes + passageBytes + 1 > WINDOW_PASSAGE_BYTES) finish();
    startPassageId ??= passage.passageId;
    endPassageId = passage.passageId;
    bytes += passageBytes + (visiblePassageCount ? 1 : 0);
    visiblePassageCount++;
  }
  finish();
  if (!windows.length) throw new Error('Long body requires at least one source passage.');
  const preimage = { planVersion: PLAN_VERSION, passageIndexDigest: projection.passageIndexDigest, windows } as const;
  return { ...preimage, planDigest: generationTextDigest(canonicalJson(preimage)) };
}

export function createLongBodyPlan(sources: readonly SourceSnapshot[]): LongBodyPlan {
  return planProjection(bodyGenerationSources(sources));
}

function requirePlan(projection: FullProjection, plan: LongBodyPlan) {
  if (canonicalJson(LongBodyPlanSchema.parse(plan)) !== canonicalJson(planProjection(projection))) throw new Error('Long body source plan mismatch.');
}

function requireSourceSet(sources: readonly SourceSnapshot[], sourceSetId: string) {
  const refs = sources.map(({ snapshotId, sourceVersion }) => ({ snapshotId, sourceVersion }));
  if (sourceSetId !== generationTextDigest(canonicalJson(sourceSetPreimage(refs)))) throw new Error('Long body source set mismatch.');
}

function rangeOrdinals(range: SourcePassageRange): readonly [number, number] {
  const start = passageId.safeParse(range.startPassageId), end = passageId.safeParse(range.endPassageId);
  if (!start.success || !end.success) throw new Error('Invalid long body passage identity.');
  const first = Number(start.data.slice(1)), last = Number(end.data.slice(1));
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first > last) throw new Error('Invalid long body passage range.');
  return [first, last];
}

function windowRange(plan: LongBodyPlan, ordinal: number) {
  const window = Number.isSafeInteger(ordinal) && plan.windows[ordinal];
  if (!window) throw new Error('Unknown long body window.');
  return window;
}

function projectVisible(projection: FullProjection, visible: (id: string) => boolean): FullProjection {
  return { ...projection, sources: projection.sources.flatMap(source => {
    const excerpts = source.excerpts.flatMap(excerpt => {
      const passages = excerpt.passages.filter(passage => visible(passage.passageId));
      return passages.length ? [{ ...excerpt, passages }] : [];
    });
    return excerpts.length ? [{ ...source, excerpts }] : [];
  }) };
}

function windowProjection(sources: readonly SourceSnapshot[], sourceSetId: string, draft: WindowWritingDraft, plan: LongBodyPlan): FullProjection {
  if (draft.ref === undefined) throw new Error('Long body requires an archived writing draft reference.');
  requireSourceSet(sources, sourceSetId);
  const projection = bodyGenerationSources(sources);
  requirePlan(projection, plan);
  return projection;
}

function serializeWindow(projection: FullProjection, sourceSetId: string, draft: WindowWritingDraft, plan: LongBodyPlan, ordinal: number): string {
  const window = windowRange(plan, ordinal);
  const [first, last] = rangeOrdinals(window);
  const visible = (id: string) => { const index = Number(id.slice(1)); return index >= first && index <= last; };
  const request = {
    inputVersion: LONG_BODY_WINDOW_INPUT_VERSION, sourceSetId, planDigest: plan.planDigest, ...projectVisible(projection, visible),
    bodyWindow: { index: ordinal + 1, count: plan.windows.length, visiblePassageCount: window.visiblePassageCount },
  };
  if (Buffer.byteLength(draft.text) <= WINDOW_INPUT_BYTES) {
    const complete = canonicalJson({ ...request, writingDraft: { ref: draft.ref, text: draft.text } });
    if (Buffer.byteLength(complete) <= WINDOW_INPUT_BYTES) return complete;
  }
  const input = canonicalJson({ ...request, writingDraft: { ref: draft.ref } });
  const bytes = Buffer.byteLength(input);
  if (bytes > WINDOW_INPUT_BYTES) {
    throw new LongBodyCapacityError(`Long body model input capacity exceeded: window ${ordinal + 1} uses ${bytes} bytes, limit ${WINDOW_INPUT_BYTES}.`);
  }
  return input;
}

export function bodyWindowInput(sources: readonly SourceSnapshot[], sourceSetId: string, draft: WindowWritingDraft, plan: LongBodyPlan, ordinal: number): string {
  return serializeWindow(windowProjection(sources, sourceSetId, draft, plan), sourceSetId, draft, plan, ordinal);
}

export function assertLongBodyWindowInputs(sources: readonly SourceSnapshot[], sourceSetId: string, draft: WindowWritingDraft, plan: LongBodyPlan): void {
  const projection = windowProjection(sources, sourceSetId, draft, plan);
  for (const ordinal of plan.windows.keys()) serializeWindow(projection, sourceSetId, draft, plan, ordinal);
}

function allRanges(response: WindowResponse): SourcePassageRange[] {
  return response.proposals.flatMap(proposal => [
    ...proposal.requiredContexts.map(context => context.evidence),
    ...proposal.segments.flatMap(segment => segment.evidence),
  ]);
}

/** Native outputs select passages. The verified source index identity is supplied only inside the host compiler. */
function compileWindowProposals(sources: readonly SourceSnapshot[], plan: LongBodyPlan, proposals: WindowResponse['proposals']) {
  const raw = canonicalJson({ responseKind: 'knowledge-body-generation', schemaVersion: 3, passageIndexDigest: plan.passageIndexDigest, proposals });
  return checkGeneratedBodies(raw, sources);
}

function requireWindowOutput(raw: string, sources: readonly SourceSnapshot[], plan: LongBodyPlan, ordinal: number) {
  if (Buffer.byteLength(raw) > WINDOW_OUTPUT_BYTES) throw new Error('Long body window output capacity exceeded.');
  if (Buffer.from(raw).toString('utf8') !== raw) throw new Error('Invalid long body window output Unicode.');
  const response = BodyWindowGenerationResponseSchema.parse(JSON.parse(raw));
  if (response.proposals.length > MAX_WINDOW_PROPOSALS
    || response.proposals.some(proposal => proposal.segments.length > MAX_WINDOW_PROPOSAL_SEGMENTS)
    || response.proposals.reduce((count, proposal) => count + proposal.segments.length, 0) > MAX_WINDOW_SEGMENTS) {
    throw new Error('Long body window proposal or segment capacity exceeded.');
  }
  const [first, last] = rangeOrdinals(windowRange(plan, ordinal));
  for (const range of allRanges(response)) {
    const [start, end] = rangeOrdinals(range);
    if (start < first || end > last) throw new Error('Long body evidence is outside the visible window.');
  }
  const compiled = compileWindowProposals(sources, plan, response.proposals);
  if (compiled.rejected.length) throw new Error('Long body window has rejected proposals.');
  return { response, compiled };
}

export function checkLongBodyWindowOutput(raw: string, sources: readonly SourceSnapshot[], plan: LongBodyPlan, ordinal: number) {
  requirePlan(bodyGenerationSources(sources), plan);
  return requireWindowOutput(raw, sources, plan, ordinal).compiled;
}

/** Publish only after every archived window validates. Keep window-local claims and evidence intact. */
export function collectLongBodyWindows(sources: readonly SourceSnapshot[], plan: LongBodyPlan, outputs: readonly string[]) {
  requirePlan(bodyGenerationSources(sources), plan);
  if (outputs.length !== plan.windows.length) throw new Error('Long body publication requires one result per window in order.');
  const custody = new Map<string, number>();
  const proposals = outputs.flatMap((raw, ordinal) => requireWindowOutput(raw, sources, plan, ordinal).response.proposals.map((proposal, index) => {
    const proposalId = `w${ordinal}-p${index}`;
    custody.set(proposalId, ordinal);
    return { ...proposal, proposalId };
  }));
  const compiled = compileWindowProposals(sources, plan, proposals);
  if (compiled.rejected.length) throw new Error('Long body publication has rejected proposals.');
  return { ...compiled, accepted: compiled.accepted.map(value => ({ ...value, windowOrdinal: custody.get(value.proposalId)! })) };
}
