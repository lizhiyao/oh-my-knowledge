import { isAbsolute, relative, resolve } from 'node:path';
import { Args, Flags } from '@oclif/core';
import { confirm, input as promptInput, select } from '@inquirer/prompts';
import { z } from 'zod';
import { LANG_FLAG, bilingual } from '../../oclif/i18n.js';
import { knowledgeOperationSchemas, type KnowledgeOperation } from '../../../knowledge/application/operations.js';
import { SourceRefSchema, SourceSelectionSchema, type SourceRef, type SourceSelection } from '../../../knowledge/sources/sources.js';
import { LocalSourceScopeSchema, type LocalSourceScope } from '../../../knowledge/application/local-source-host.js';
import { createLocalKnowledgeApplication } from '../../../knowledge/application/local.js';
import type { KnowledgeApplication } from '../../../knowledge/application/application.js';
import { createLocalKnowledgeGenerationModel } from '../../../knowledge/adapters/generation-host.js';
import type { KnowledgeGenerationModel } from '../../../knowledge/adapters/generation-executor.js';
import { createExtractionArchiveProducer } from '../../../executors/archive.js';
import { UserSettingsStore } from '../../../settings/user-settings.js';
import { getCodexModelSuggestion } from '../../lib/codex-model-hint.js';
import { KnowCommand, knowJsonFlag, knowWorkspaceFlag } from '../../lib/know-command.js';
import { knowledgeCommand } from '../../lib/knowledge-output.js';

const actions = ['prepare', 'generate', 'continue'] as const;
type Action = typeof actions[number];
type GuidedFlags = {
  workspace?: string;
  input?: string;
  id?: string;
  generation?: number;
  'run-id'?: string;
  executor?: string;
  model?: string;
  'confirm-request'?: string;
  scope?: string;
  selection?: string;
  file?: string;
  trace?: string;
  'trace-kind'?: string;
  lines?: string;
  records?: string;
  json: boolean;
  lang?: string;
};

export default class KnowExtract extends KnowCommand {
  static description = bilingual({
    zh: '引导提炼知识，或使用 prepare／generate／continue 显式控制逐阶段请求。',
    en: 'Guide knowledge extraction, or use prepare/generate/continue to control each stage explicitly.',
  });
  static args = { action: Args.string({ options: actions, description: bilingual({ zh: '高级阶段操作；省略则进入引导流程。', en: 'Advanced stage operation; omit for the guided flow.' }) }) };
  static flags = {
    workspace: knowWorkspaceFlag,
    input: Flags.string({ description: bilingual({ zh: '显式阶段的精确来源 JSON。', en: 'Exact-source JSON for explicit stages.' }) }),
    id: Flags.string({ description: bilingual({ zh: '显式 continue：运行 UUID。', en: 'Explicit continue: run UUID.' }) }),
    generation: Flags.integer({ min: 1, description: bilingual({ zh: '显式 continue：日志 generation。', en: 'Explicit continue: journal generation.' }) }),
    'run-id': Flags.string({ description: bilingual({ zh: '稳定运行 UUID；引导模式可用它恢复已有运行。', en: 'Stable run UUID; the guided flow uses it to resume an existing run.' }) }),
    executor: Flags.string({ description: bilingual({ zh: '生成执行器，沿用运行配置。', en: 'Generation executor; defaults to runtime settings.' }) }),
    model: Flags.string({ description: bilingual({ zh: '生成模型，沿用运行配置。', en: 'Generation model; defaults to runtime settings.' }) }),
    'confirm-request': Flags.string({ description: bilingual({ zh: '显式发送：已核对完整请求的 requestDigest。', en: 'Explicit dispatch: requestDigest of the inspected complete request.' }) }),
    scope: Flags.string({ description: bilingual({ zh: '引导：已有可信来源范围 JSON。', en: 'Guided: existing trusted source-scope JSON.' }) }),
    selection: Flags.string({ description: bilingual({ zh: '引导：与 scope 对应的选区 JSON。', en: 'Guided: selection JSON corresponding to the scope.' }) }),
    file: Flags.string({ description: bilingual({ zh: '引导：直接选择当前目录中的项目文件。', en: 'Guided: select a project file from the current directory directly.' }) }),
    trace: Flags.string({ description: bilingual({ zh: '引导：直接选择一份轨迹文件。', en: 'Guided: select a trace file directly.' }) }),
    'trace-kind': Flags.string({ description: bilingual({ zh: 'trace：轨迹类型，如 codex／claude／qoder。', en: 'trace: trace kind, such as codex/claude/qoder.' }) }),
    lines: Flags.string({ description: bilingual({ zh: 'file：行范围 start:end，从 1 开始；省略选择整个文件。', en: 'file: line range start:end, starting at 1; omit for the whole file.' }) }),
    records: Flags.string({ description: bilingual({ zh: 'trace：原记录范围 start:end，从 0 开始。', en: 'trace: original record range start:end, starting at 0.' }) }),
    json: knowJsonFlag,
    lang: LANG_FLAG,
  };
  static examples = [
    '<%= config.bin %> know extract',
    '<%= config.bin %> know extract --file PRODUCT.md --lines 1:80',
    '<%= config.bin %> know extract --trace ./session.jsonl --trace-kind codex --records 0:20',
    '<%= config.bin %> know extract --run-id <run-id>',
    '<%= config.bin %> know extract prepare --workspace ./knowledge --input ./sources.json --json',
    '<%= config.bin %> know extract generate --workspace ./knowledge --input ./sources.json --confirm-request sha256:<digest>',
    '<%= config.bin %> know extract continue --workspace ./knowledge --id <run-id> --generation 5 --confirm-request sha256:<digest>',
  ];

  async run(): Promise<void> {
    const { args, flags } = await this.parse(KnowExtract);
    if (!args.action) {
      await this.runGuided(flags);
      return;
    }
    const action = args.action as Action;
    const allowed = new Set(['workspace', 'executor', 'model', 'json', 'lang', ...(action === 'continue'
      ? ['id', 'generation', 'confirm-request']
      : ['input', 'run-id', ...(action === 'generate' ? ['confirm-request'] : [])])]);
    if (Object.entries(flags).some(([name, value]) => value !== undefined && value !== false && !allowed.has(name))) {
      this.error(this.t('该提炼动作不接受这些参数。', 'These flags are not accepted for this extraction action.'), { exit: 2 });
    }
    let operation: KnowledgeOperation;
    if (action === 'continue') {
      operation = {
        operation: 'continue-stage',
        id: this.required(flags.id, 'id'),
        generation: flags.generation ?? this.error('--generation is required', { exit: 2 }),
        executor: 'configured',
        model: 'configured',
        confirmedRequestDigest: this.required(flags['confirm-request'], 'confirm-request'),
      };
    } else {
      const parsed = action === 'prepare'
        ? knowledgeOperationSchemas['prepare-generation'].omit({ operation: true, executor: true, model: true, runId: true }).safeParse(this.input(flags.input))
        : z.strictObject({ sources: z.array(SourceRefSchema).min(1).max(256) }).safeParse(this.input(flags.input));
      if (!parsed.success) this.error(this.t('提炼输入必须是完整精确的 {sources} 来源引用。', 'Extraction input must contain complete exact source references in {sources}.'), { exit: 2 });
      operation = action === 'prepare'
        ? { operation: 'prepare-generation', sources: parsed.data.sources, executor: 'configured', model: 'configured', runId: flags['run-id'] }
        : {
          operation: 'generate', sources: parsed.data.sources, executor: 'configured', model: 'configured', runId: flags['run-id'],
          confirmedRequestDigest: this.required(flags['confirm-request'], 'confirm-request'),
        };
    }
    await this.executeKnowOperation(operation, flags);
  }

  private async runGuided(flags: GuidedFlags): Promise<void> {
    const guidedFlags = ['scope', 'selection', 'file', 'trace', 'trace-kind', 'lines', 'records'] as const;
    const advancedOnly = ['input', 'id', 'generation', 'confirm-request'] as const;
    if (advancedOnly.some(name => flags[name] !== undefined)) {
      this.error(this.t('引导流程不接受显式阶段参数；请先选择 prepare／generate／continue。', 'The guided flow does not accept explicit-stage flags; select prepare/generate/continue first.'), { exit: 2 });
    }
    const runId = flags['run-id'];
    if (runId !== undefined && guidedFlags.some(name => flags[name] !== undefined)) {
      this.error(this.t('恢复已有运行时不能重新选择来源。', 'Resuming an existing run cannot change its source selection.'), { exit: 2 });
    }
    if (runId === undefined && (['trace-kind', 'lines', 'records'] as const).some(name => flags[name] !== undefined)
      && !flags.file && !flags.trace) {
      this.error(this.t('范围参数须与 --file 或 --trace 一起使用。', 'Range flags require --file or --trace.'), { exit: 2 });
    }
    await this.runWithCancellation(async signal => {
      if (runId !== undefined) {
        const workspace = this.workspace(flags.workspace);
        const app = createLocalKnowledgeApplication(workspace);
        const { journal } = app.inspect(runId);
        const executorOverride = flags.executor?.trim();
        const modelOverride = flags.model?.trim();
        if ((executorOverride && executorOverride !== journal.executor) || (modelOverride && modelOverride !== journal.model)) {
          this.error(this.t('恢复须沿用原运行的执行器和模型。请移除不匹配的 --executor 或 --model。',
            'Resuming requires the recorded executor and model. Remove the mismatched --executor or --model.'), { exit: 2 });
        }
        const model = createLocalKnowledgeGenerationModel(journal.executor, journal.model, createExtractionArchiveProducer);
        const sources = journal.sources.map(({ snapshotId, sourceVersion }) => ({ snapshotId, sourceVersion }));
        return this.runGuidedStages(app, sources, model, workspace, runId, signal);
      }

      const settings = new UserSettingsStore().resolve({ workspace: flags.workspace, executor: flags.executor, model: flags.model });
      const codex = settings.executor === 'codex' && !settings.model ? getCodexModelSuggestion() : undefined;
      const modelName = settings.model || (codex?.fromConfig ? codex.model : '');
      if (!modelName) {
        this.error(this.t('请通过 --model 或 OMK_MODEL 指定提炼模型。使用 Codex 时，也可以在 Codex 配置中设置默认模型。',
          'Set an extraction model with --model or OMK_MODEL. For Codex, you can also set a default model in the Codex config.'), { exit: 2 });
      }
      const model = createLocalKnowledgeGenerationModel(settings.executor, modelName, createExtractionArchiveProducer);
      const selected = await this.guideSources(flags);
      const app = createLocalKnowledgeApplication(settings.workspace, { sourceScope: selected.scope });
      const preview = app.previewSources(selected.selections, { signal });
      this.log(JSON.stringify(preview, null, 2));
      const save = await confirm({
        message: this.t(`将上述选定来源保存到 ${settings.workspace}？保存不授权发送模型。`, `Save the selected sources to ${settings.workspace}? Saving does not authorize model dispatch.`),
        default: false,
      });
      if (!save) {
        this.log(this.t('已停止；没有保存来源或调用模型。', 'Stopped; no sources were saved and no model was called.'));
        return;
      }
      const rebuilt = app.previewResolvedSources(preview.items.map(item => item.resolvedSelection), {
        expectedDigest: preview.previewDigest,
        signal,
      });
      const captured = await app.captureSources({ previewId: rebuilt.previewId, previewDigest: rebuilt.previewDigest }, signal);
      const sources = captured.saveManifest.items.map(({ snapshotId, sourceVersion }) => ({ snapshotId, sourceVersion }));
      this.log(this.t(`已保存 ${sources.length} 份来源。接下来逐阶段核对模型请求。`, `Saved ${sources.length} source(s). Each model request will be reviewed next.`));
      await this.runGuidedStages(app, sources, model, settings.workspace, undefined, signal);
    });
  }

  private async runGuidedStages(app: KnowledgeApplication, sources: readonly SourceRef[], model: KnowledgeGenerationModel,
    workspace: string, runId: string | undefined, signal: AbortSignal): Promise<void> {
    let result = runId ? app.resume(runId, signal) : await app.prepareGeneration(sources, model, runId, signal);
    for (let step = 0; step < 64; step++) {
      if (result.journal.status === 'completed') {
        this.log(this.t('提炼已完成；正文仍是待审候选，没有自动保留或接受关联。', 'Extraction completed; bodies remain pending candidates without automatic retention or association approval.'));
        this.log(JSON.stringify({ runId: result.journal.runId, status: result.journal.status, bodies: result.journal.bodies }, null, 2));
        for (const body of result.journal.bodies) this.log(knowledgeCommand(workspace, 'show', { id: body.knowledgeId, revision: body.revisionId }));
        return;
      }
      if (result.nextAction === 'prepare_next_stage') {
        result = await app.prepareGeneration(sources, model, result.journal.runId, signal);
      }
      if (result.nextAction !== 'continue_stage') {
        const issues = result.journal.stages.at(-1)?.issues.join('; ') ?? '';
        this.error(this.t(`运行未处于可明确继续的状态（status=${result.journal.status}，nextAction=${result.nextAction}，issues=${issues}）；已保留记录，不自动重试或重发。`, `The run is not safely continuable (status=${result.journal.status}, nextAction=${result.nextAction}, issues=${issues}); records are preserved without automatic retry or redispatch.`), { exit: 1 });
      }
      const stage = result.journal.stages.find(item => item.state === 'prepared');
      if (!stage) this.error(this.t('没有已准备且未发送的阶段；请先核对运行记录。', 'No prepared unsent stage exists; inspect the run first.'), { exit: 1 });
      this.log(JSON.stringify({
        stageKind: stage.stageKind,
        runId: result.journal.runId,
        generation: result.journal.generation,
        executor: result.journal.executor,
        model: result.journal.model,
        requestDigest: stage.requestDigest,
        system: stage.system,
        input: stage.input,
        wireId: stage.wireId,
        wireSchema: stage.wireSchema,
        producer: stage.producer,
      }, null, 2));
      const approved = await confirm({
        message: this.t(`确认发送阶段 ${stage.stageKind} 的上述完整请求？`, `Dispatch the complete ${stage.stageKind} request shown above?`),
        default: false,
      });
      if (!approved) {
        this.log(this.t('已停止，没有发送该阶段。之后可用同一运行继续引导：', 'Stopped without dispatching this stage. Resume the guided flow with the same run:'));
        this.log(knowledgeCommand(workspace, 'extract', { 'run-id': result.journal.runId }));
        return;
      }
      const initial = result.journal.stages.every(item => item.state === 'prepared');
      result = initial
        ? await app.generate(sources, model, result.journal.runId, signal, { confirmedRequestDigest: stage.requestDigest })
        : await app.continueStage(result.journal.runId, result.journal.generation, model, signal, { confirmedRequestDigest: stage.requestDigest });
    }
    this.error(this.t('引导达到阶段上限；已保留记录，请核对运行后再继续。', 'The guided stage limit was reached; records are preserved. Inspect the run before continuing.'), { exit: 1 });
  }

  private async guideSources(flags: GuidedFlags): Promise<{ scope: LocalSourceScope; selections: SourceSelection[] }> {
    if (flags.file && flags.trace || flags.scope && (flags.file || flags.trace) || flags.selection && !flags.scope) {
      this.error(this.t('请只选择一种来源方式；--selection 须配 --scope。', 'Choose only one source mode; --selection requires --scope.'), { exit: 2 });
    }
    if (flags.scope) {
      const scope = this.sourceScope(flags.scope)!;
      if (flags.selection) {
        const parsed = z.array(SourceSelectionSchema).min(1).max(256).safeParse(this.input(flags.selection));
        if (!parsed.success) this.error(this.t('选区必须是 selections JSON 数组。', 'The selection must be a JSON array of selections.'), { exit: 2 });
        return { scope, selections: parsed.data };
      }
      return { scope, selections: [await this.selectFromScope(scope)] };
    }
    if (flags.file || flags.trace) return this.directSource(flags.file, flags.trace, flags);
    const sourceKind = await select({
      message: this.t('选择提炼来源类型。', 'Choose a source type.'),
      choices: [
        { value: 'file', name: this.t('当前目录中的项目文件', 'Project file from the current directory') },
        { value: 'trace', name: this.t('一份 Agent 轨迹文件', 'An agent trace file') },
      ],
    });
    return this.directSource(sourceKind === 'file' ? await promptInput({ message: this.t('文件路径：', 'File path:'), required: true }) : undefined,
      sourceKind === 'trace' ? await promptInput({ message: this.t('轨迹路径：', 'Trace path:'), required: true }) : undefined, flags);
  }

  private directSource(file: string | undefined, trace: string | undefined, flags: GuidedFlags) {
    if (file) {
      const absolute = resolve(file);
      const relativePath = relative(process.cwd(), absolute);
      if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
        this.error(this.t('项目文件必须位于当前目录内。', 'The project file must be inside the current directory.'), { exit: 2 });
      }
      const range = flags.lines ? this.range(flags.lines, 'lines') : undefined;
      return {
        scope: LocalSourceScopeSchema.parse({ scopeVersion: 'knowledge-source-scope/v1', projects: [{ projectId: 'cli-project', root: process.cwd() }], traces: [] }),
        selections: [{ sourceKind: 'project_file' as const, projectId: 'cli-project', relativePath,
          lineRanges: range ? [{ startLine: range.start, endLine: range.end }] : null }],
      };
    }
    const traceKind = this.required(flags['trace-kind'], 'trace-kind');
    const range = flags.records ? this.range(flags.records, 'records') : undefined;
    if (!range) this.error(this.t('轨迹需要 --records start:end，明确选择原记录范围。', 'A trace requires --records start:end to select original records explicitly.'), { exit: 2 });
    return {
      scope: LocalSourceScopeSchema.parse({ scopeVersion: 'knowledge-source-scope/v1', projects: [], traces: [{ sourceId: 'cli-trace', traceKind, path: resolve(trace!) }] }),
      selections: [{ sourceKind: 'agent_trace' as const, sourceId: 'cli-trace', traceKind,
        recordRanges: [{ startRecord: range.start, endRecord: range.end }] }],
    };
  }

  private async selectFromScope(scope: LocalSourceScope): Promise<SourceSelection> {
    const choices = [
      ...scope.projects.map(project => ({ value: `project:${project.projectId}`, name: `项目 ${project.projectId}` })),
      ...scope.traces.map(trace => ({ value: `trace:${trace.sourceId}`, name: `轨迹 ${trace.sourceId}` })),
    ];
    if (!choices.length) this.error(this.t('scope 中没有可选来源。', 'The scope has no selectable sources.'), { exit: 2 });
    const selected = await select({ message: this.t('选择来源。', 'Select a source.'), choices });
    if (selected.startsWith('trace:')) {
      const sourceId = selected.slice(6);
      const bound = scope.traces.find(trace => trace.sourceId === sourceId)!;
      const range = this.range(await promptInput({ message: this.t('原记录范围 start:end（从 0 开始）：', 'Original record range start:end (starting at 0):'), required: true }), 'records');
      return { sourceKind: 'agent_trace', sourceId, traceKind: bound.traceKind,
        recordRanges: [{ startRecord: range.start, endRecord: range.end }] };
    }
    const projectId = selected.slice(8);
    const sourceKind = await select({
      message: this.t('选择项目文件或固定 Git 文件。', 'Choose a project file or fixed Git file.'),
      choices: [{ value: 'project_file', name: '项目文件' }, { value: 'git_blob', name: '固定 Git 文件' }],
    });
    const relativePath = await promptInput({ message: this.t('相对路径：', 'Relative path:'), required: true });
    const revision = sourceKind === 'git_blob'
      ? await promptInput({ message: this.t('Git revision：', 'Git revision:'), required: true }) : undefined;
    const rawRange = await promptInput({ message: this.t('行范围 start:end（从 1 开始；留空选择整个文件）：', 'Line range start:end (starting at 1; blank selects the whole file):') });
    const range = rawRange.trim() ? this.range(rawRange, 'lines') : undefined;
    const lineRanges = range ? [{ startLine: range.start, endLine: range.end }] : null;
    if (sourceKind === 'git_blob') return { sourceKind, projectId, relativePath, revision: revision!, lineRanges };
    return { sourceKind: 'project_file', projectId, relativePath, lineRanges };
  }

  private range(value: string, name: string): { start: number; end: number } {
    const match = /^(\d+):(\d+)$/.exec(value.trim());
    if (!match) this.error(this.t(`--${name} 必须是 start:end。`, `--${name} must be start:end.`), { exit: 2 });
    const start = Number(match[1]), end = Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || name === 'lines' && start < 1) {
      this.error(this.t(`--${name} 范围无效。`, `--${name} range is invalid.`), { exit: 2 });
    }
    return { start, end };
  }
}
