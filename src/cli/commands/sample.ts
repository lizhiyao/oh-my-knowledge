import { resolve, relative, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { Args, Flags, type Interfaces } from '@oclif/core';
import { LANG_FLAG, bilingual } from '../oclif/i18n.js';
import { BaseCommand } from '../oclif/base-command.js';
import { nonEmptyStringParser, integerStringParser } from '../oclif/parsers.js';
import { CliExit } from '../lib/cli-exit.js';
import { tCli, type CliLang } from '../lib/i18n.js';
import { formatSampleGenerationFailureHint } from '../lib/generation-failure-hint.js';
import { resolveRuntimeSelection } from '../lib/runtime-defaults.js';
import { generateSkillSamples, discoverSkillSampleTasks, SamplePreparationError } from '../../eval-workflows/sample-generation/skill-samples.js';
import {
  SampleFileAmbiguityError,
} from '../../eval-workflows/inputs/sample-locator.js';
import { shellQuoteArg } from '../../shared/shell-quote.js';
import { withLocalizedSampleDiscovery } from '../lib/localized-sample-discovery.js';
import type { CommandFlags } from '../lib/cmd-flags.js';
import type { ResolvedSkillInput } from '../lib/resolve-skill-input.js';

function userFacingPath(filePath: string): string {
  const rel = relative(process.cwd(), filePath);
  if (rel && rel !== '..' && !rel.startsWith(`..${sep}`)) return rel;
  return filePath;
}

export function sampleNextEvalCommand(
  resolved: Pick<ResolvedSkillInput, 'isDirectorySkill' | 'skillDir' | 'skillPath'>,
): string {
  const treatmentPath = resolved.isDirectorySkill ? resolved.skillDir : resolved.skillPath;
  return `omk eval --control baseline --treatment ${shellQuoteArg(userFacingPath(treatmentPath))}`;
}

export async function runSampleFromTraces(
  flags: SampleFlags,
  lang: CliLang,
  signal?: AbortSignal,
): Promise<void> {
  const { DEFAULT_OBSERVATIONS_DIR } = await import('../../observability/inbox/paths.js');
  const { generateTraceDrafts, TraceDraftPreparationError } = await import('../../eval-workflows/sample-generation/trace-drafts.js');
  const model = flags.model;
  const executorName = flags.executor;
  if (!model || !executorName) {
    throw new Error('internal error: sample generation requires runtime selection before execution');
  }

  const obsDir = resolve(flags['observations-dir'] ?? DEFAULT_OBSERVATIONS_DIR);
  const count = flags.count !== undefined ? Math.max(1, Number(flags.count) || 5) : undefined;
  try {
    const result = await generateTraceDrafts({
      observationsDir: obsDir, skill: flags.skill,
      options: { signal, count, model, executorName, noMock: flags['no-mock'] },
      onGenerating: (signalCount) => process.stderr.write(lang === 'zh'
        ? `🔭 发现 ${signalCount} 个${flags.skill ? ` ${flags.skill} 的` : ''}失败信号，正在生成评测用例草稿...\n`
        : `🔭 Found ${signalCount}${flags.skill ? ` ${flags.skill}` : ''} failure signal(s); generating regression-sample drafts...\n`),
    });
    if (result.draftStatus === 'no-signals') {
      process.stderr.write(lang === 'zh'
        ? `✅ ${obsDir}${flags.skill ? ` 中 ${flags.skill}` : ''} 没有可回流的失败信号（噪声级已跳过）\n`
        : `✅ No recyclable failure signals${flags.skill ? ` for ${flags.skill}` : ''} in ${obsDir} (noise-level skipped)\n`);
      return;
    }
    const { costUSD } = result;
    const cost = costUSD > 0 ? ` $${costUSD.toFixed(4)}` : '';
    if (result.draftStatus === 'empty') {
      // The model conservatively skipped every signal (noise / unreproducible). That's a
      // valid outcome, not a failure — don't write an empty draft file.
      process.stderr.write(lang === 'zh'
        ? `\n✅ 没有可复现的草稿用例（信号多为噪声 / 证据不足，已保守跳过），未写文件${cost}\n`
        : `\n✅ No reproducible draft samples (signals were noise / insufficient evidence; conservatively skipped); nothing written${cost}\n`);
      return;
    }
    process.stderr.write(lang === 'zh'
      ? `\n✅ 生成 ${result.count} 条草稿用例 → ${result.outputPath}（provenance: production-trace）${cost}\n   ⚠️ 这是草稿：trace 只抓失败信号，有抽样偏差。请人工 review 后再合入正式 eval-samples，不要直接当评测集。\n`
      : `\n✅ Generated ${result.count} draft sample(s) → ${result.outputPath} (provenance: production-trace)${cost}\n   ⚠️ Draft only: traces capture failures, a biased sample. Review before merging into your eval-samples; don't use as-is.\n`);
  } catch (err: unknown) {
    if (err instanceof CliExit) throw err;
    if (err instanceof TraceDraftPreparationError) {
      console.error(err.reason === 'missing-inbox'
        ? (lang === 'zh' ? `observe-inbox 目录不存在: ${err.path}（先运行 omk observe ingest 生成）` : `Observe-inbox dir not found: ${err.path} (run omk observe ingest first)`)
        : (lang === 'zh' ? `草稿已存在: ${err.path}，请先 review 并合入正式集（或删除）后再生成` : `Draft already exists: ${err.path}; review/merge (or remove) it before regenerating`));
      throw new CliExit(1);
    }
    const message = (err as Error).message;
    console.error((lang === 'zh' ? `生成失败: ${message}` : `Generation failed: ${message}`)
      + formatSampleGenerationFailureHint(message, flags.executor, lang));
    throw new CliExit(1);
  }
}

async function runSample(
  args: SampleArgs,
  flags: SampleFlags,
  lang: CliLang,
  signal?: AbortSignal,
): Promise<void> {
  if (flags['from-traces']) {
    await runSampleFromTraces(flags, lang, signal);
    return;
  }
  const count: number | undefined = flags.count !== undefined
    ? Math.max(1, Number(flags.count) || 5)
    : undefined;
  const model: string = flags.model;
  const executorName = flags.executor;
  if (!executorName) {
    throw new Error('internal error: sample generation requires runtime selection before execution');
  }
  const focus: string | undefined = flags.focus || undefined;

  if (focus) {
    process.stderr.write(tCli('cli.gen.focus_applied', lang, { focus }));
  }

  if (flags.batch) {
    const skillDir: string = resolve(flags['skill-dir']);
    if (!existsSync(skillDir)) {
      console.error(tCli('cli.common.skill_dir_not_found', lang, { path: skillDir }));
      throw new CliExit(1);
    }

    const tasks = withLocalizedSampleDiscovery(() => discoverSkillSampleTasks(skillDir), lang);
    let generated: number = 0;
    let failed: number = 0;

    for (const task of tasks) {
      const { name } = task;
      if (task.selectionKind === 'flat') {
        process.stderr.write(`⚠️  skipping ${name}: flat skills have no private sample namespace; migrate to ${name}/SKILL.md\n`);
        continue;
      }
      if (task.selectionKind === 'existing') {
        process.stderr.write(tCli('cli.gen.skill_skipped_existing', lang, { name }));
        continue;
      }
      const { skillPath, samplesPath } = task;
      if (count !== undefined) {
        process.stderr.write(tCli('cli.gen.skill_generating', lang, { name, count }));
      } else {
        process.stderr.write(tCli('cli.gen.skill_generating_auto', lang, { name }));
      }
      try {
        const { added, costUSD } = await generateSkillSamples({
          skillPath, samplesPath,
          options: { signal, count, model, focus, noMock: flags['no-mock'], executorName },
        });
        const cost: string = costUSD > 0 ? ` $${costUSD.toFixed(4)}` : '';
        process.stderr.write(tCli('cli.gen.skill_done', lang, {
          name, n: added, path: samplesPath, cost,
        }));
        generated++;
      } catch (err: unknown) {
        failed++;
        const message = (err as Error).message;
        process.stderr.write(tCli('cli.gen.skill_failed', lang, {
          name, message: `${message}${formatSampleGenerationFailureHint(message, flags.executor, lang)}`,
        }));
      }
    }

    if (failed > 0) {
      console.error(tCli('cli.gen.batch_failed_summary', lang, { generated, failed }));
      throw new CliExit(1);
    }
    if (generated === 0) {
      console.log(tCli('cli.gen.batch_none_needed', lang));
    } else {
      console.log(tCli('cli.gen.batch_summary', lang, { n: generated }));
    }
  } else {
    const skillPathArg: string | undefined = args.skillPath;
    if (!skillPathArg) {
      console.error(tCli('cli.gen.specify_skill_path', lang));
      throw new CliExit(1);
    }

    const { resolveSkillInput } = await import('../lib/resolve-skill-input.js');
    let resolved;
    try { resolved = resolveSkillInput(skillPathArg, lang); } catch (err) {
      console.error((err as Error).message);
      throw new CliExit(1);
    }

    try {
      const result = await generateSkillSamples({
        skillPath: resolved.skillPath, samplesPath: resolved.samplesPath, append: flags.append,
        options: { signal, count, model, focus, noMock: flags['no-mock'], executorName },
        onGenerating: () => process.stderr.write(count !== undefined
          ? tCli('cli.gen.single_generating', lang, { count })
          : tCli('cli.gen.single_generating_auto', lang)),
      });
      const cost = result.costUSD > 0 ? ` $${result.costUSD.toFixed(4)}` : '';
      if (result.appended) {
        process.stderr.write(tCli('cli.gen.append_done', lang, {
          added: result.added, total: result.total, path: result.outputPath, cost,
        }));
      } else {
        process.stderr.write(tCli('cli.gen.single_done', lang, {
          n: result.added, path: result.outputPath, cost,
        }));
      }
      console.log(tCli('cli.gen.review_hint', lang, { command: sampleNextEvalCommand(resolved) }));
    } catch (err: unknown) {
      if (err instanceof CliExit) throw err;
      if (err instanceof SamplePreparationError && err.reason === 'exists') {
        console.error(tCli('cli.gen.samples_already_exists', lang, { command: sampleNextEvalCommand(resolved) }));
        throw new CliExit(1);
      }
      const message = err instanceof SampleFileAmbiguityError
        ? tCli('cli.common.ambiguous_sample_files', lang, { paths: err.paths.join(lang === 'zh' ? '、' : ', ') })
        : (err as Error).message;
      console.error(tCli('cli.gen.failed', lang, {
        message: `${message}${formatSampleGenerationFailureHint(message, flags.executor, lang)}`,
      }));
      throw new CliExit(1);
    }
  }
}

export default class Sample extends BaseCommand {
  static description = bilingual({
    zh: '为指定 skill 生成评测用例，支持 batch、single 与 from-traces 模式。',
    en: 'Generate eval samples for a skill in batch, single, or from-traces mode.',
  });

  static examples = [
    {
      description: bilingual({
        zh: '为单个 skill 生成默认数量的用例',
        en: 'Generate default-count samples for a single skill',
      }),
      command: '<%= config.bin %> sample skills/my-skill/SKILL.md',
    },
    {
      description: bilingual({
        zh: '批量为 skill 目录下所有缺 samples 的 skill 生成',
        en: 'Batch-generate samples for all skills missing them',
      }),
      command: '<%= config.bin %> sample --batch --skill-dir skills',
    },
    {
      description: bilingual({
        zh: '从 observe inbox 的失败信号回流生成评测用例草稿',
        en: 'Recycle observe-inbox failure signals into draft regression samples',
      }),
      command: '<%= config.bin %> sample --from-traces',
    },
  ];

  static args = {
    skillPath: Args.string({
      parse: nonEmptyStringParser('skillPath'),
      description: bilingual({
        zh: 'skill 文件路径或 SKILL.md 路径。batch 模式不需要；single 模式必填。',
        en: 'Skill file or SKILL.md path. Not required in batch mode; required for single mode.',
      }),
      required: false,
    }),
  };

  static flags = {
    lang: LANG_FLAG,
    batch: Flags.boolean({
      exclusive: ['from-traces'],
      description: bilingual({
        zh: '批量模式：扫 --skill-dir 下所有缺 samples 的 skill，逐个生成。',
        en: 'Batch mode: scan --skill-dir, generate samples for any skill missing them.',
      }),
      default: false,
    }),
    count: Flags.string({
      description: bilingual({
        zh: '生成用例条数。不传由 LLM 按 skill 类型自动决定。',
        en: 'Number of samples to generate. Defaults to LLM auto-selection by skill type.',
      }),
      parse: integerStringParser('--count', { min: 1 }),
    }),
    model: Flags.string({
      parse: nonEmptyStringParser('--model'),
      description: bilingual({
        zh: '生成 LLM model 名。Codex 自动读取本机配置；也可用 OMK_MODEL 设置环境偏好。',
        en: 'Generation LLM model name. Codex reads the local configured model; OMK_MODEL sets an environment preference.',
      }),
    }),
    executor: Flags.string({
      parse: nonEmptyStringParser('--executor'),
      description: bilingual({
        zh: '执行器名。Codex 任务内自动用 codex；也可用 OMK_EXECUTOR 设置环境偏好。',
        en: 'Executor name. Defaults to codex inside Codex tasks; OMK_EXECUTOR sets an environment preference.',
      }),
    }),
    'skill-dir': Flags.string({
      parse: nonEmptyStringParser('--skill-dir'),
      description: bilingual({
        zh: 'skill 根目录，默认 skills。batch 模式扫此目录。',
        en: 'Skill root dir, default skills. Used by batch mode.',
      }),
      default: 'skills',
    }),
    focus: Flags.string({
      description: bilingual({
        zh: '生成焦点（自然语言提示）。控制 LLM 偏向哪类用例。',
        en: 'Generation focus (NL hint). Steers LLM toward certain sample types.',
      }),
    }),
    append: Flags.boolean({
      description: bilingual({
        zh: '在已有用例文件上追加新生成的用例（撞 sampleId 自动加后缀去重，保留原 json/yaml 格式）。仅单 skill 模式，不支持 --batch / --from-traces。不传则已有文件时报错保护。常配 --focus 补特定场景。',
        en: 'Append newly generated samples to the existing samples file (colliding sampleId auto-suffixed, original json/yaml shape kept). Single-skill mode only; not supported with --batch / --from-traces. Without it, an existing file errors out. Often paired with --focus.',
      }),
      default: false,
    }),
    'no-mock': Flags.boolean({
      description: bilingual({
        zh: '不生成 mocks。执行器不支持工具拦截时会自动启用，避免产生必然失败的 mock_hit。',
        en: 'Skip mocks. Automatically enabled when the executor cannot intercept tools, preventing impossible mock_hit assertions.',
      }),
      default: false,
    }),
    'from-traces': Flags.boolean({
      description: bilingual({
        zh: 'from-traces 模式：从 observe inbox 的失败信号回流生成评测用例草稿（provenance: production-trace），落草稿待人工 review。',
        en: 'from-traces mode: recycle observe-inbox failure signals into draft regression samples (provenance: production-trace) for review.',
      }),
      default: false,
    }),
    'observations-dir': Flags.string({
      dependsOn: ['from-traces'],
      parse: nonEmptyStringParser('--observations-dir'),
      description: bilingual({
        zh: 'observe inbox 目录（from-traces 模式用），默认项目 .omk/observe/inbox。',
        en: 'Observe inbox dir (from-traces mode), default project .omk/observe/inbox.',
      }),
    }),
    skill: Flags.string({
      parse: nonEmptyStringParser('--skill'),
      description: bilingual({
        zh: '仅从指定 skill 的 observe inbox 信号生成草稿（仅 from-traces 模式用）。',
        en: 'Only draft from observe-inbox signals for the specified skill (from-traces mode only).',
      }),
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Sample);
    const lang = this.lang;
    if (flags.skill && !flags['from-traces']) {
      console.error(lang === 'zh' ? '--skill 仅支持 --from-traces 模式。' : '--skill is only supported with --from-traces.');
      this.exit(2);
    }
    // --append 目前只在单 skill 生成路径实现；batch / from-traces 不处理它，
    // 静默忽略会误导(用户以为在追加,实际没有)。提前互斥校验,明确报错。
    if (flags.append && (flags.batch || flags['from-traces'])) {
      console.error(tCli('cli.gen.append_single_only', lang));
      this.exit(2);
    }
    if (args.skillPath && (flags.batch || flags['from-traces'])) {
      console.error(lang === 'zh' ? 'skillPath 不能与 --batch 或 --from-traces 同时使用。' : 'skillPath cannot be combined with --batch or --from-traces.');
      this.exit(2);
    }
    if (!args.skillPath && !flags.batch && !flags['from-traces']) {
      console.error(tCli('cli.gen.specify_skill_path', lang));
      this.exit(2);
    }
    await this.runWithCancellation(async (signal) => {
      const runtime = resolveRuntimeSelection(
        { executor: flags.executor, model: flags.model },
        { lang },
      );
      await runSample(args, {
        ...flags,
        executor: runtime.executor,
        model: runtime.model,
        lang,
      }, lang, signal);
    });
  }
}

export type SampleArgs = Interfaces.InferredArgs<typeof Sample.args>;
export type SampleFlags = CommandFlags<typeof Sample.flags> & { model: string; executor: string };
