import { resolve, join, dirname, extname, relative, sep } from 'node:path';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { Args, Flags } from '@oclif/core';
import { LANG_FLAG, bilingual } from '../oclif/i18n.js';
import { BaseCommand } from '../oclif/base-command.js';
import { integerStringParser } from '../oclif/parsers.js';
import { CliExit } from '../lib/cli-exit.js';
import { tCli, type CliLang } from '../lib/i18n.js';
import { formatSampleGenerationFailureHint } from '../lib/generation-failure-hint.js';
import { resolveRuntimeSelection } from '../lib/runtime-defaults.js';
import { listSampleFilesInDir } from '../../eval-workflows/inputs/load-samples.js';
import {
  getSamplesArray,
  parseSampleDocument,
  stringifySampleDocument,
} from '../../eval-workflows/inputs/sample-document.js';
import {
  defaultSkillLocalSamplesFile,
  findCanonicalSamplesFile,
  findSkillSamplesPath,
} from '../../eval-workflows/inputs/sample-locator.js';
import { shellQuoteArg } from '../../shared/shell-quote.js';
import { withLocalizedSampleDiscovery } from '../lib/localized-sample-discovery.js';
import type { SampleArgs, SampleFlags } from '../lib/cmd-flags.js';
import type {
  EvalSampleSetDocument,
  Sample as SampleType,
} from '../../eval-workflows/inputs/contracts/sample.js';
import { createEvalSampleSetDocument } from '../../eval-workflows/inputs/schemas/sample-set.js';
import type { ResolvedSkillInput } from '../lib/resolve-skill-input.js';

interface GenerateSamplesResult {
  samples: SampleType[];
  costUSD: number;
}

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

/** --append 合并:已有用例原样保留,新用例逐条接在后面;sample_id 撞已有(或本批已用)时
 *  自动加 `-2`/`-3` 后缀去重。模型每次从 s001 重编号,撞 id 不代表内容重复,所以是改名保留
 *  而非丢弃(不做内容级去重)。`reserved` 为额外要避开的 id 集(目录模式跨同目录其它 sample
 *  文件去重用,见 collectDirSampleIds)。 */
export function mergeAppendSamples(
  existing: SampleType[],
  fresh: SampleType[],
  reserved?: ReadonlySet<string>,
): SampleType[] {
  const used = new Set(existing.map((s) => s.sample_id));
  if (reserved) for (const id of reserved) used.add(id);
  const merged: SampleType[] = [...existing];
  for (const sample of fresh) {
    let id = sample.sample_id;
    if (used.has(id)) {
      let n = 2;
      while (used.has(`${id}-${n}`)) n += 1;
      id = `${id}-${n}`;
    }
    used.add(id);
    merged.push(id === sample.sample_id ? sample : { ...sample, sample_id: id });
  }
  return merged;
}

/** 目录模式 append:收集目录内所有 sample 文件的 sample_id,跨文件去重用 —— eval 走目录模式
 *  会把目录下所有文件合并加载,跨文件撞 id 直接报错(load-samples 的 duplicate sample_id)。
 *  复用 listSampleFilesInDir 的排序/过滤口径;best-effort:解析失败的文件跳过。 */
function collectDirSampleIds(dir: string): Set<string> {
  const ids = new Set<string>();
  let files: string[];
  try { files = listSampleFilesInDir(dir); } catch { return ids; }
  for (const f of files) {
    const full = join(dir, f);
    try {
      for (const s of getSamplesArray(parseSampleDocument(full), full)) {
        if (typeof s.sample_id === 'string') ids.add(s.sample_id);
      }
    } catch { /* skip unparseable / 非 sample 文件 */ }
  }
  return ids;
}

/** 目录模式 append 选写回目标：canonical JSON / YAML 二选一；并存时 fail closed。 */
export function pickAppendTargetFile(dir: string): string | null {
  return findCanonicalSamplesFile(dir);
}

/** 把新用例追加进已有 sample 文件:读 → 合并(撞 id 去重)→ 保留原 json/yaml 格式与
 *  versioned wrapper 写回。返回合并后总条数。 */
export function appendSamplesToFile(
  existingFile: string,
  fresh: SampleType[],
  reserved?: ReadonlySet<string>,
): number {
  const doc = parseSampleDocument(existingFile);
  const merged = mergeAppendSamples(getSamplesArray(doc, existingFile), fresh, reserved);
  const nextDoc: EvalSampleSetDocument = {
    ...(doc as EvalSampleSetDocument),
    samples: merged,
  };
  writeFileSync(existingFile, stringifySampleDocument(existingFile, nextDoc));
  return merged.length;
}

export async function runSampleFromTraces(
  flags: SampleFlags,
  lang: CliLang,
): Promise<void> {
  const { queryObservationInbox, DEFAULT_OBSERVATIONS_DIR } = await import('../../observability/inbox/index.js');
  const { generateSamplesFromTraces } = await import('../../knowledge-artifacts/authoring/generator.js');
  const model = flags.model;
  const executorName = flags.executor;
  if (!model || !executorName) {
    throw new Error('internal error: sample generation requires runtime selection before execution');
  }

  const obsDir = resolve(flags['observations-dir'] ?? DEFAULT_OBSERVATIONS_DIR);
  if (!existsSync(obsDir)) {
    console.error(lang === 'zh'
      ? `observe-inbox 目录不存在: ${obsDir}（先运行 omk observe ingest 生成）`
      : `Observe-inbox dir not found: ${obsDir} (run omk observe ingest first)`);
    throw new CliExit(1);
  }

  // Drop noise-tier signals up front: they're exactly what the generator is told to
  // skip, so filtering here avoids feeding junk to the LLM and keeps the no-op path clean.
  let items = queryObservationInbox(obsDir).filter((it) => it.severity !== 'noise');
  if (flags.skill) {
    items = items.filter((it) => it.skillName === flags.skill);
  }
  if (items.length === 0) {
    process.stderr.write(lang === 'zh'
      ? `✅ ${obsDir}${flags.skill ? ` 中 ${flags.skill}` : ''} 没有可回流的失败信号（噪声级已跳过）\n`
      : `✅ No recyclable failure signals${flags.skill ? ` for ${flags.skill}` : ''} in ${obsDir} (noise-level skipped)\n`);
    return;
  }

  const { observationDraftsDir } = await import('../../observability/inbox/index.js');
  const outPath = join(observationDraftsDir(obsDir), 'sample-drafts.json');
  if (existsSync(outPath)) {
    console.error(lang === 'zh'
      ? `草稿已存在: ${outPath}，请先 review 并合入正式集（或删除）后再生成`
      : `Draft already exists: ${outPath}; review/merge (or remove) it before regenerating`);
    throw new CliExit(1);
  }

  const count: number | undefined = flags.count !== undefined ? Math.max(1, Number(flags.count) || 5) : undefined;
  process.stderr.write(lang === 'zh'
    ? `🔭 发现 ${items.length} 个${flags.skill ? ` ${flags.skill} 的` : ''}失败信号，正在生成评测用例草稿...\n`
    : `🔭 Found ${items.length}${flags.skill ? ` ${flags.skill}` : ''} failure signal(s); generating regression-sample drafts...\n`);

  try {
    const { samples, costUSD } = await generateSamplesFromTraces({
      items,
      count,
      model,
      executorName,
      noMock: flags['no-mock'],
    });
    const cost = costUSD > 0 ? ` $${costUSD.toFixed(4)}` : '';
    if (samples.length === 0) {
      // The model conservatively skipped every signal (noise / unreproducible). That's a
      // valid outcome, not a failure — don't write an empty draft file.
      process.stderr.write(lang === 'zh'
        ? `\n✅ 没有可复现的草稿用例（信号多为噪声 / 证据不足，已保守跳过），未写文件${cost}\n`
        : `\n✅ No reproducible draft samples (signals were noise / insufficient evidence; conservatively skipped); nothing written${cost}\n`);
      return;
    }
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(createEvalSampleSetDocument(samples), null, 2));
    process.stderr.write(lang === 'zh'
      ? `\n✅ 生成 ${samples.length} 条草稿用例 → ${outPath}（provenance: production-trace）${cost}\n   ⚠️ 这是草稿：trace 只抓失败信号，有抽样偏差。请人工 review 后再合入正式 eval-samples，不要直接当评测集。\n`
      : `\n✅ Generated ${samples.length} draft sample(s) → ${outPath} (provenance: production-trace)${cost}\n   ⚠️ Draft only: traces capture failures, a biased sample. Review before merging into your eval-samples; don't use as-is.\n`);
  } catch (err: unknown) {
    if (err instanceof CliExit) throw err;
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
): Promise<void> {
  if (flags.skill && !flags['from-traces']) {
    console.error(lang === 'zh' ? '--skill 仅支持 --from-traces 模式。' : '--skill is only supported with --from-traces.');
    throw new CliExit(2);
  }
  // --append 目前只在单 skill 生成路径实现；batch / from-traces 不处理它，
  // 静默忽略会误导(用户以为在追加,实际没有)。提前互斥校验,明确报错。
  if (flags.append && (flags.batch || flags['from-traces'])) {
    console.error(tCli('cli.gen.append_single_only', lang));
    throw new CliExit(2);
  }
  if (flags['from-traces']) {
    await runSampleFromTraces(flags, lang);
    return;
  }
  const { generateSamples } = await import('../../knowledge-artifacts/authoring/generator.js');
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

    const entries: string[] = readdirSync(skillDir);
    let generated: number = 0;
    let failed: number = 0;

    for (const entry of entries) {
      let name: string;
      let skillPath: string;
      let samplesPath: string;
      let existingSamplesPath: string | null;
      const fullPath: string = join(skillDir, entry);

      if (entry.endsWith('.md')) {
        const flatName = entry.slice(0, -3);
        process.stderr.write(`⚠️  skipping ${flatName}: flat skills have no private sample namespace; migrate to ${flatName}/SKILL.md\n`);
        continue;
      } else if (statSync(fullPath).isDirectory()) {
        const skillMd: string = join(fullPath, 'SKILL.md');
        if (!existsSync(skillMd)) continue;
        if (existsSync(join(skillDir, `${entry}.md`))) continue;
        name = entry;
        skillPath = skillMd;
        samplesPath = defaultSkillLocalSamplesFile(fullPath);
        existingSamplesPath = withLocalizedSampleDiscovery(() => findSkillSamplesPath(fullPath), lang);
      } else {
        continue;
      }

      if (existingSamplesPath) {
        process.stderr.write(tCli('cli.gen.skill_skipped_existing', lang, { name }));
        continue;
      }

      if (count !== undefined) {
        process.stderr.write(tCli('cli.gen.skill_generating', lang, { name, count }));
      } else {
        process.stderr.write(tCli('cli.gen.skill_generating_auto', lang, { name }));
      }
      try {
        const skillContent: string = readFileSync(skillPath, 'utf-8');
        const { samples, costUSD }: GenerateSamplesResult =
          await generateSamples({ skillContent, count, model, focus, noMock: flags['no-mock'], executorName });
        mkdirSync(dirname(samplesPath), { recursive: true });
        writeFileSync(
          samplesPath,
          JSON.stringify(createEvalSampleSetDocument(samples), null, 2),
        );
        const cost: string = costUSD > 0 ? ` $${costUSD.toFixed(4)}` : '';
        process.stderr.write(tCli('cli.gen.skill_done', lang, {
          name, n: samples.length, path: samplesPath, cost,
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

    const skillContent: string = readFileSync(resolved.skillPath, 'utf-8');

    let outputPath: string;
    let existingFile: string | null = null;
    if (!extname(resolved.samplesPath)) {
      const dir = resolved.samplesPath;
      if (existsSync(dir) && statSync(dir).isDirectory()) {
        existingFile = withLocalizedSampleDiscovery(() => pickAppendTargetFile(dir), lang);
      }
      outputPath = existingFile ?? join(dir, 'eval-samples.json');
    } else {
      outputPath = resolved.samplesPath;
      if (existsSync(outputPath)) existingFile = outputPath;
    }

    // 已有用例文件:默认报错保护;--append 时追加(下面合并),不报错。
    if (existingFile && !flags.append) {
      console.error(tCli('cli.gen.samples_already_exists', lang, { command: sampleNextEvalCommand(resolved) }));
      throw new CliExit(1);
    }

    if (count !== undefined) {
      process.stderr.write(tCli('cli.gen.single_generating', lang, { count }));
    } else {
      process.stderr.write(tCli('cli.gen.single_generating_auto', lang));
    }
    try {
      const { samples, costUSD }: GenerateSamplesResult =
        await generateSamples({ skillContent, count, model, focus, noMock: flags['no-mock'], executorName });
      const cost: string = costUSD > 0 ? ` $${costUSD.toFixed(4)}` : '';
      if (existingFile && flags.append) {
        // 追加:读已有 → 合并(撞 id 去重)→ 保留原 json/yaml 格式与 wrapper 写回。
        // 目录模式额外跨同目录其它 sample 文件去重,避免 eval 合并加载时撞 id 报错;
        // 显式单文件路径无同目录合并语义,不需要。
        const reserved = extname(resolved.samplesPath) ? undefined : collectDirSampleIds(dirname(existingFile));
        const total = appendSamplesToFile(existingFile, samples as SampleType[], reserved);
        process.stderr.write(tCli('cli.gen.append_done', lang, {
          added: samples.length, total, path: existingFile, cost,
        }));
      } else {
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(
          outputPath,
          JSON.stringify(createEvalSampleSetDocument(samples), null, 2),
        );
        process.stderr.write(tCli('cli.gen.single_done', lang, {
          n: samples.length, path: outputPath, cost,
        }));
      }
      console.log(tCli('cli.gen.review_hint', lang, { command: sampleNextEvalCommand(resolved) }));
    } catch (err: unknown) {
      if (err instanceof CliExit) throw err;
      const message = (err as Error).message;
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
      description: bilingual({
        zh: '生成 LLM model 名。Codex 自动读取本机配置；也可用 OMK_MODEL 设置环境偏好。',
        en: 'Generation LLM model name. Codex reads the local configured model; OMK_MODEL sets an environment preference.',
      }),
    }),
    executor: Flags.string({
      description: bilingual({
        zh: '执行器名。Codex 任务内自动用 codex；也可用 OMK_EXECUTOR 设置环境偏好。',
        en: 'Executor name. Defaults to codex inside Codex tasks; OMK_EXECUTOR sets an environment preference.',
      }),
    }),
    'skill-dir': Flags.string({
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
        zh: '在已有用例文件上追加新生成的用例（撞 sample_id 自动加后缀去重，保留原 json/yaml 格式）。仅单 skill 模式，不支持 --batch / --from-traces。不传则已有文件时报错保护。常配 --focus 补特定场景。',
        en: 'Append newly generated samples to the existing samples file (colliding sample_id auto-suffixed, original json/yaml shape kept). Single-skill mode only; not supported with --batch / --from-traces. Without it, an existing file errors out. Often paired with --focus.',
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
      description: bilingual({
        zh: 'observe inbox 目录（from-traces 模式用），默认项目 .omk/observe/inbox。',
        en: 'Observe inbox dir (from-traces mode), default project .omk/observe/inbox.',
      }),
    }),
    skill: Flags.string({
      description: bilingual({
        zh: '仅从指定 skill 的 observe inbox 信号生成草稿（仅 from-traces 模式用）。',
        en: 'Only draft from observe-inbox signals for the specified skill (from-traces mode only).',
      }),
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Sample);
    const lang = this.lang;
    await this.runWithCliExit(async () => {
      const runtime = resolveRuntimeSelection(
        { executor: flags.executor, model: flags.model },
        { lang },
      );
      await runSample(args, {
        ...flags,
        executor: runtime.executor,
        model: runtime.model,
        lang,
      }, lang);
    });
  }
}
