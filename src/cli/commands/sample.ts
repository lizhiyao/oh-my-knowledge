import { resolve, join, basename, dirname, extname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { Args, Flags } from '@oclif/core';
import { LANG_FLAG, bilingual } from '../oclif/i18n.js';
import { BaseCommand } from '../oclif/base-command.js';
import { integerStringParser } from '../oclif/parsers.js';
import { CliExit } from '../lib/cli-exit.js';
import { tCli, type CliLang } from '../lib/i18n.js';
import { DEFAULT_REPORTS_DIR } from '../lib/parse-run-config.js';
import { loadSamples, parseYaml, type LoadSamplesResult } from '../../inputs/load-samples.js';
import { hashSample, hashString } from '../../eval-core/evaluation-reporting.js';
import type { SampleArgs, SampleFlags } from '../lib/cmd-flags.js';
import type { Report, Sample as SampleType } from '../../types/index.js';

interface GenerateSamplesResult {
  samples: unknown[];
  costUSD: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isYamlPath(filePath: string): boolean {
  return /\.(ya?ml)$/i.test(filePath);
}

function parseSampleDocument(filePath: string): unknown {
  const raw = readFileSync(filePath, 'utf-8');
  return isYamlPath(filePath) ? parseYaml(raw) : JSON.parse(raw);
}

function getSamplesArray(document: unknown, filePath: string): SampleType[] {
  if (Array.isArray(document)) return document as SampleType[];
  if (isRecord(document) && Array.isArray(document.samples)) return document.samples as SampleType[];
  throw new Error(`invalid samples file shape: ${filePath} (expected an array or an object with a 'samples' field)`);
}

function stringifySampleDocument(filePath: string, document: unknown): string {
  if (isYamlPath(filePath)) return yaml.dump(document, { lineWidth: -1, noRefs: true });
  return JSON.stringify(document, null, 2);
}

function formatIdList(ids: string[]): string {
  const shown = ids.slice(0, 5);
  const suffix = ids.length > shown.length ? ` +${ids.length - shown.length}` : '';
  return shown.join(', ') + suffix;
}

// 下面 3 个 helper 在 sample-fix.test.ts 单测内 in-process import 验证 fix 逻辑。

export function collectSampleDesignFailureIds(report: Pick<Report, 'results'>, treatmentName: string): Set<string> {
  const ids = new Set<string>();
  for (const entry of report.results) {
    const rootCause = entry.variants[treatmentName]?.diagnostic?.rootCause ?? [];
    if (rootCause.includes('sample_design')) ids.add(entry.sample_id);
  }
  return ids;
}

export function assertFixReportMatchesCurrentInputs(params: {
  report: Pick<Report, 'meta'>;
  treatmentName: string;
  skillContent: string;
  samples: SampleType[];
  sampleIds: Set<string>;
  lang?: CliLang;
}): void {
  const { report, treatmentName, skillContent, samples, sampleIds } = params;
  const lang = params.lang ?? 'zh';
  const issues: string[] = [];

  const expectedSkillHash = report.meta.artifactHashes?.[treatmentName];
  const currentSkillHash = hashString(skillContent);
  if (!expectedSkillHash) {
    issues.push(lang === 'zh'
      ? `报告缺少 ${treatmentName} 的 skill 指纹，无法确认诊断对应当前 SKILL.md。`
      : `Report is missing the skill hash for ${treatmentName}; cannot verify it matches the current SKILL.md.`);
  } else if (expectedSkillHash !== currentSkillHash) {
    issues.push(lang === 'zh'
      ? `skill 指纹不一致：报告 ${expectedSkillHash}，当前 ${currentSkillHash}。`
      : `Skill hash mismatch: report ${expectedSkillHash}, current ${currentSkillHash}.`);
  }

  const reportSampleHashes = report.meta.sampleHashes;
  if (!reportSampleHashes) {
    issues.push(lang === 'zh'
      ? '报告缺少用例指纹，无法确认 sample_design 诊断对应当前 samples。'
      : 'Report is missing sample hashes; cannot verify sample_design diagnostics match the current samples.');
  } else {
    const samplesById = new Map(samples.map((sample) => [sample.sample_id, sample]));
    const missingCurrentSamples: string[] = [];
    const missingReportHashes: string[] = [];
    const mismatchedSamples: string[] = [];
    for (const sampleId of sampleIds) {
      const currentSample = samplesById.get(sampleId);
      if (!currentSample) {
        missingCurrentSamples.push(sampleId);
        continue;
      }
      const expectedSampleHash = reportSampleHashes[sampleId];
      if (!expectedSampleHash) {
        missingReportHashes.push(sampleId);
        continue;
      }
      const currentSampleHash = hashSample(currentSample);
      if (expectedSampleHash !== currentSampleHash) {
        mismatchedSamples.push(sampleId);
      }
    }
    if (missingCurrentSamples.length > 0) {
      issues.push(lang === 'zh'
        ? `当前 samples 缺少报告中的用例：${formatIdList(missingCurrentSamples)}。`
        : `Current samples are missing report sample(s): ${formatIdList(missingCurrentSamples)}.`);
    }
    if (missingReportHashes.length > 0) {
      issues.push(lang === 'zh'
        ? `报告缺少这些用例的指纹：${formatIdList(missingReportHashes)}。`
        : `Report is missing hashes for sample(s): ${formatIdList(missingReportHashes)}.`);
    }
    if (mismatchedSamples.length > 0) {
      issues.push(lang === 'zh'
        ? `用例指纹不一致：${formatIdList(mismatchedSamples)}。`
        : `Sample hash mismatch: ${formatIdList(mismatchedSamples)}.`);
    }
  }

  if (issues.length === 0) return;

  const heading = lang === 'zh'
    ? '报告与当前输入不一致，已停止自动修复。'
    : 'Report does not match the current inputs; automatic fixing stopped.';
  const hint = lang === 'zh'
    ? '请先重新运行 omk eval，再执行 omk sample --fix。'
    : 'Re-run omk eval first, then run omk sample --fix again.';
  throw new Error([heading, ...issues, hint].join('\n'));
}

export function writeFixedSamplesToSources(
  loaded: Pick<LoadSamplesResult, 'sourceFiles' | 'sampleSourceById'>,
  samples: SampleType[],
  changedIds: Set<string>,
): string[] {
  if (changedIds.size === 0) return [];

  const fixedById = new Map(samples.map((sample) => [sample.sample_id, sample]));
  const idsByFile = new Map<string, Set<string>>();
  for (const sampleId of changedIds) {
    const filePath = loaded.sampleSourceById[sampleId];
    if (!filePath) throw new Error(`sample ${sampleId} source file not found`);
    const ids = idsByFile.get(filePath) ?? new Set<string>();
    ids.add(sampleId);
    idsByFile.set(filePath, ids);
  }

  const written: string[] = [];
  for (const [filePath, ids] of idsByFile.entries()) {
    const document = parseSampleDocument(filePath);
    const fileSamples = getSamplesArray(document, filePath);
    const nextSamples = fileSamples.map((sample) => (
      ids.has(sample.sample_id) ? (fixedById.get(sample.sample_id) ?? sample) : sample
    ));
    const nextDocument = Array.isArray(document)
      ? nextSamples
      : { ...(document as Record<string, unknown>), samples: nextSamples };
    writeFileSync(filePath, stringifySampleDocument(filePath, nextDocument));
    written.push(filePath);
  }
  return written;
}

async function runSampleFix(
  args: SampleArgs,
  flags: SampleFlags,
  lang: CliLang,
): Promise<void> {
  const { fixSamples } = await import('../../authoring/sample-fixer.js');
  const { createFileStore } = await import('../../server/report-store.js');

  const model = flags.model;
  const reportsDir = resolve(flags['reports-dir'] ?? DEFAULT_REPORTS_DIR);

  const skillPath = args.skillPath;
  if (!skillPath) {
    console.error(lang === 'zh' ? '请指定 skill 路径，如: omk sample skills/my-skill/SKILL.md --fix' : 'Specify skill path: omk sample skills/my-skill/SKILL.md --fix');
    throw new CliExit(1);
  }
  const resolvedSkillPath = resolve(skillPath);
  if (!existsSync(resolvedSkillPath)) {
    console.error(lang === 'zh' ? `skill 文件不存在: ${resolvedSkillPath}` : `Skill file not found: ${resolvedSkillPath}`);
    throw new CliExit(1);
  }

  const isDir = basename(resolvedSkillPath) === 'SKILL.md';
  const skillDir = isDir ? dirname(resolvedSkillPath) : dirname(resolvedSkillPath);
  const samplesInput = isDir
    ? join(skillDir, '.omk')
    : resolve('eval-samples.json');

  if (!existsSync(samplesInput)) {
    console.error(lang === 'zh' ? `samples 路径不存在: ${samplesInput}，先运行 omk sample 生成` : `Samples path not found: ${samplesInput}, run omk sample first`);
    throw new CliExit(1);
  }

  const defaultTreatmentName = isDir
    ? basename(skillDir)
    : basename(resolvedSkillPath, extname(resolvedSkillPath));
  const treatmentName = flags.treatment ?? defaultTreatmentName;

  process.stderr.write(lang === 'zh' ? `🔍 正在查找 ${treatmentName} 的最新评测报告...\n` : `🔍 Scanning latest report for ${treatmentName}...\n`);
  const store = createFileStore(reportsDir);
  const reports = await store.findByVariant(treatmentName);

  if (reports.length === 0) {
    console.error(lang === 'zh' ? `未找到 ${treatmentName} 的评测报告（报告目录: ${reportsDir}）` : `No eval report found for ${treatmentName} in ${reportsDir}`);
    throw new CliExit(1);
  }

  const report = reports[0];
  process.stderr.write(lang === 'zh' ? `📄 使用报告: ${report.id} (${report.meta?.timestamp ?? '?'})\n` : `📄 Using report: ${report.id} (${report.meta?.timestamp ?? '?'})\n`);

  let loadedSamples: LoadSamplesResult;
  try {
    loadedSamples = loadSamples(samplesInput);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(lang === 'zh' ? `samples 加载失败: ${message}` : `Failed to load samples: ${message}`);
    throw new CliExit(1);
  }
  const samples = loadedSamples.samples;
  const skillContent = readFileSync(resolvedSkillPath, 'utf-8');

  const sampleDesignIds = collectSampleDesignFailureIds(report, treatmentName);
  const sampleDesignCount = sampleDesignIds.size;

  if (sampleDesignCount === 0) {
    process.stderr.write(lang === 'zh' ? '✅ 没有 sample_design 类型的失败，无需修复\n' : '✅ No sample_design failures found, nothing to fix\n');
    return;
  }

  try {
    assertFixReportMatchesCurrentInputs({
      report,
      treatmentName,
      skillContent,
      samples,
      sampleIds: sampleDesignIds,
      lang,
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    throw new CliExit(1);
  }

  process.stderr.write(lang === 'zh' ? `🔧 发现 ${sampleDesignCount} 条 sample_design 失败，开始修复...\n` : `🔧 Found ${sampleDesignCount} sample_design failure(s), fixing...\n`);

  const { createExecutor } = await import('../../executors/index.js');
  const exec = createExecutor('claude');
  const executorFn = async (opts: { model: string; system: string; prompt: string; timeoutMs: number; lean?: boolean }) => {
    const result = await exec({
      model: opts.model,
      system: opts.system,
      prompt: opts.prompt,
      timeoutMs: opts.timeoutMs,
      lean: opts.lean,
    });
    return { ok: result.ok, text: result.output ?? '', costUSD: result.costUSD };
  };

  const result = await fixSamples({
    skillContent,
    samples,
    report,
    treatmentKey: treatmentName,
    executor: executorFn,
    model,
  });

  let writtenFiles: string[] = [];
  if (result.fixedCount > 0) {
    const changedIds = new Set(result.fixes.filter((f) => f.changed).map((f) => f.sampleId));
    writtenFiles = writeFixedSamplesToSources(loadedSamples, result.samples as unknown as SampleType[], changedIds);
  }

  for (const f of result.fixes) {
    if (f.changed) {
      process.stderr.write(lang === 'zh' ? `  ✅ ${f.sampleId} 已修复\n` : `  ✅ ${f.sampleId} fixed\n`);
    } else {
      process.stderr.write(lang === 'zh' ? `  ⚠ ${f.sampleId} 未修改${f.error ? `: ${f.error}` : ''}\n` : `  ⚠ ${f.sampleId} unchanged${f.error ? `: ${f.error}` : ''}\n`);
    }
  }

  const cost = result.costUSD > 0 ? ` $${result.costUSD.toFixed(4)}` : '';
  const outputTarget = writtenFiles.length === 0
    ? samplesInput
    : writtenFiles.length === 1
      ? writtenFiles[0]
      : `${writtenFiles.length} files`;
  process.stderr.write(lang === 'zh'
    ? `\n🔧 修复完成: ${result.fixedCount}/${sampleDesignCount} 条已修复 → ${outputTarget}${cost}\n`
    : `\n🔧 Fix complete: ${result.fixedCount}/${sampleDesignCount} fixed → ${outputTarget}${cost}\n`);
}

async function runSample(
  args: SampleArgs,
  flags: SampleFlags,
  lang: CliLang,
): Promise<void> {
  if (flags.fix) {
    await runSampleFix(args, flags, lang);
    return;
  }

  const { generateSamples } = await import('../../authoring/generator.js');
  const count: number | undefined = flags.count !== undefined
    ? Math.max(1, Number(flags.count) || 5)
    : undefined;
  const model: string = flags.model;
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

    for (const entry of entries) {
      let name: string;
      let skillPath: string;
      let samplesPath: string;
      const fullPath: string = join(skillDir, entry);

      if (entry.endsWith('.md') && !entry.endsWith('.eval-samples.json')) {
        name = entry.slice(0, -3);
        skillPath = fullPath;
        samplesPath = join(skillDir, `${name}.eval-samples.json`);
      } else if (statSync(fullPath).isDirectory()) {
        const skillMd: string = join(fullPath, 'SKILL.md');
        if (!existsSync(skillMd)) continue;
        name = entry;
        skillPath = skillMd;
        samplesPath = join(fullPath, '.omk', 'samples.json');
      } else {
        continue;
      }

      if (existsSync(samplesPath)) {
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
          await generateSamples({ skillContent, count, model, focus, noMock: flags['no-mock'] });
        mkdirSync(dirname(samplesPath), { recursive: true });
        writeFileSync(samplesPath, JSON.stringify(samples, null, 2));
        const cost: string = costUSD > 0 ? ` $${costUSD.toFixed(4)}` : '';
        process.stderr.write(tCli('cli.gen.skill_done', lang, {
          name, n: samples.length, path: samplesPath, cost,
        }));
        generated++;
      } catch (err: unknown) {
        process.stderr.write(tCli('cli.gen.skill_failed', lang, {
          name, message: (err as Error).message,
        }));
      }
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
    try { resolved = resolveSkillInput(skillPathArg); } catch (err) {
      console.error(tCli('cli.common.skill_file_not_found', lang, { path: resolve(skillPathArg) }));
      throw new CliExit(1);
    }

    const skillContent: string = readFileSync(resolved.skillPath, 'utf-8');

    const outputPath: string = resolved.samplesPath;

    if (existsSync(outputPath)) {
      console.error(tCli('cli.gen.samples_already_exists', lang));
      throw new CliExit(1);
    }

    if (count !== undefined) {
      process.stderr.write(tCli('cli.gen.single_generating', lang, { count }));
    } else {
      process.stderr.write(tCli('cli.gen.single_generating_auto', lang));
    }
    try {
      const { samples, costUSD }: GenerateSamplesResult =
        await generateSamples({ skillContent, count, model, focus, noMock: flags['no-mock'] });
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, JSON.stringify(samples, null, 2));
      const cost: string = costUSD > 0 ? ` $${costUSD.toFixed(4)}` : '';
      process.stderr.write(tCli('cli.gen.single_done', lang, {
        n: samples.length, path: outputPath, cost,
      }));
      console.log(tCli('cli.gen.review_hint', lang));
    } catch (err: unknown) {
      if (err instanceof CliExit) throw err;
      console.error(tCli('cli.gen.failed', lang, { message: (err as Error).message }));
      throw new CliExit(1);
    }
  }
}

export default class Sample extends BaseCommand {
  static description = bilingual({
    zh: '为指定 skill 生成评测用例（eval-samples），支持 batch / single / fix 三种模式。',
    en: 'Generate eval samples for the given skill. Supports batch / single / fix modes.',
  });

  static examples = [
    {
      description: bilingual({
        zh: '为单个 skill 生成默认数量的样本',
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
        zh: '根据最近评测报告自动修复 sample_design 类型失败',
        en: 'Auto-fix sample_design failures using the most recent eval report',
      }),
      command: '<%= config.bin %> sample skills/my-skill/SKILL.md --fix',
    },
  ];

  static args = {
    skillPath: Args.string({
      description: bilingual({
        zh: 'skill 文件路径或 SKILL.md 路径。batch 模式不需要；single / fix 模式必填。',
        en: 'Skill file or SKILL.md path. Not required in batch mode; required for single / fix.',
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
        zh: '生成样本条数。不传由 LLM 按 skill 类型自动决定。',
        en: 'Number of samples to generate. Defaults to LLM auto-selection by skill type.',
      }),
      parse: integerStringParser('--count', { min: 1 }),
    }),
    model: Flags.string({
      description: bilingual({
        zh: '生成 LLM model 名，默认 sonnet。',
        en: 'Generation LLM model name, default sonnet.',
      }),
      default: 'sonnet',
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
    'no-mock': Flags.boolean({
      description: bilingual({
        zh: '不生成 mocks，eval 时所有工具调用真实执行。',
        en: 'Skip mock generation; all tool calls execute for real during eval.',
      }),
      default: false,
    }),
    fix: Flags.boolean({
      description: bilingual({
        zh: 'fix 模式：基于最近评测报告自动修复 sample_design 类型失败。',
        en: 'Fix mode: auto-fix sample_design failures using the latest eval report.',
      }),
      default: false,
    }),
    'reports-dir': Flags.string({
      description: bilingual({
        zh: '报告目录（fix 模式用），默认 ~/.oh-my-knowledge/reports。',
        en: 'Reports dir (fix mode), default ~/.oh-my-knowledge/reports.',
      }),
    }),
    treatment: Flags.string({
      description: bilingual({
        zh: '指定 treatment 名（fix 模式用），默认推断自 skill 路径。',
        en: 'Treatment name (fix mode), defaults to skill-path inference.',
      }),
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Sample);
    const lang = this.lang;
    await this.runWithCliExit(async () => {
      await runSample(args, { ...flags, lang }, lang);
    });
  }
}
