import { CliExit } from '../cli-exit.js';
import { resolve, join, basename, dirname, extname } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { tCli, langFromArgv } from '../i18n.js';
import { COMMON_OPTIONS, DEFAULT_REPORTS_DIR } from '../parse-run-config.js';
import { parseArgsStrictOrExit } from '../parse-strict.js';
import { loadSamples, parseYaml, type LoadSamplesResult } from '../../inputs/load-samples.js';
import type { Sample } from '../../types/index.js';

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

function getSamplesArray(document: unknown, filePath: string): Sample[] {
  if (Array.isArray(document)) return document as Sample[];
  if (isRecord(document) && Array.isArray(document.samples)) return document.samples as Sample[];
  throw new Error(`invalid samples file shape: ${filePath} (expected an array or an object with a 'samples' field)`);
}

function stringifySampleDocument(filePath: string, document: unknown): string {
  if (isYamlPath(filePath)) return yaml.dump(document, { lineWidth: -1, noRefs: true });
  return JSON.stringify(document, null, 2);
}

export function writeFixedSamplesToSources(
  loaded: Pick<LoadSamplesResult, 'sourceFiles' | 'sampleSourceById'>,
  samples: Sample[],
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

export async function execute(argv: string[]): Promise<void> {
  const lang = langFromArgv(argv);
  const { values, positionals } = parseArgsStrictOrExit({
    args: argv,
    options: {
      ...COMMON_OPTIONS,
      batch: { type: 'boolean', default: false },
      count: { type: 'string' },
      model: { type: 'string', default: 'opus' },
      'skill-dir': { type: 'string', default: 'skills' },
      focus: { type: 'string' },
      fix: { type: 'boolean', default: false },
      'reports-dir': { type: 'string' },
      treatment: { type: 'string' },
    },
    allowPositionals: true,
  });

  if (values.fix) {
    await executeFix(values, positionals, lang);
    return;
  }

  const { generateSamples } = await import('../../authoring/generator.js');
  const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
  const path = await import('node:path');
  // count 语义:用户显式给值 → 强制 N 条;不给 → undefined,LLM 按 skill 类型自定数量。
  const count: number | undefined = values.count !== undefined
    ? Math.max(1, Number(values.count) || 5)
    : undefined;
  const model: string = values.model as string;
  const focus: string | undefined = (values.focus as string | undefined) || undefined;

  if (focus) {
    process.stderr.write(tCli('cli.gen.focus_applied', lang, { focus }));
  }

  if (values.batch) {
    // Batch mode: generate for all skills missing eval-samples
    const skillDir: string = resolve(values['skill-dir'] as string);
    if (!existsSync(skillDir)) {
      console.error(tCli('cli.common.skill_dir_not_found', lang, { path: skillDir }));
      throw new CliExit(1);
    }

    const { readdirSync, statSync } = await import('node:fs');
    const entries: string[] = readdirSync(skillDir);
    let generated: number = 0;

    for (const entry of entries) {
      let name: string;
      let skillPath: string;
      let samplesPath: string;
      const fullPath: string = join(skillDir, entry);

      if (entry.endsWith('.md') && !entry.endsWith('.eval-samples.json')) {
        // 单文件 skill 没有 ".omk/" 容器(无目录),沿用 sibling 文件 <name>.eval-samples.json
        name = entry.slice(0, -3);
        skillPath = fullPath;
        samplesPath = join(skillDir, `${name}.eval-samples.json`);
      } else if (statSync(fullPath).isDirectory()) {
        // 目录 skill 走 omk 标准约定: <skill>/.omk/samples.json
        // 与 loadSamples 的目录模式对齐(支持 .omk/ 下多文件合并)
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
          await generateSamples({ skillContent, count, model, focus });
        mkdirSync(path.dirname(samplesPath), { recursive: true });
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
    // Single skill mode — 必须显式传 <skill-path>;flag value (如 --count 3 里的 3)
    // 不会被当成 positional,因为我们用的是 parser 返回的 positionals。
    const skillPath: string | undefined = positionals[0];
    if (!skillPath) {
      console.error(tCli('cli.gen.specify_skill_path', lang));
      throw new CliExit(1);
    }

    const resolvedPath: string = resolve(skillPath);
    if (!existsSync(resolvedPath)) {
      console.error(tCli('cli.common.skill_file_not_found', lang, { path: resolvedPath }));
      throw new CliExit(1);
    }

    const skillContent: string = readFileSync(resolvedPath, 'utf-8');

    // 输出路径推断:如果传入的是 <skill>/SKILL.md(目录式 skill),
    // 写到 <skill>/.omk/samples.json(omk 标准约定);
    // 否则(SKILL.md 不存在 / 单文件 skill / 直接跑 .md)落到 cwd 兜底。
    const skillBasename = path.basename(resolvedPath);
    const skillParentDir = path.dirname(resolvedPath);
    const isStandardSkillLayout = skillBasename === 'SKILL.md';
    const outputPath: string = isStandardSkillLayout
      ? path.join(skillParentDir, '.omk', 'samples.json')
      : resolve('eval-samples.json');

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
        await generateSamples({ skillContent, count, model, focus });
      mkdirSync(path.dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, JSON.stringify(samples, null, 2));
      const cost: string = costUSD > 0 ? ` $${costUSD.toFixed(4)}` : '';
      process.stderr.write(tCli('cli.gen.single_done', lang, {
        n: samples.length, path: outputPath, cost,
      }));
      console.log(tCli('cli.gen.review_hint', lang));
    } catch (err: unknown) {
      // CliExit 透传，保持 eval / improve / doctor 的一致性约束。
      if (err instanceof CliExit) throw err;
      console.error(tCli('cli.gen.failed', lang, { message: (err as Error).message }));
      throw new CliExit(1);
    }
  }
}

async function executeFix(
  values: Record<string, unknown>,
  positionals: string[],
  lang: 'zh' | 'en',
): Promise<void> {
  const { fixSamples } = await import('../../authoring/sample-fixer.js');
  const { createFileStore } = await import('../../server/report-store.js');

  const model = (values.model as string) ?? 'opus';
  const reportsDir = resolve((values['reports-dir'] as string) ?? DEFAULT_REPORTS_DIR);

  // 1. Determine skill path and samples path
  const skillPath = positionals[0];
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

  // 2. Determine treatment name
  const defaultTreatmentName = isDir
    ? basename(skillDir)
    : basename(resolvedSkillPath, extname(resolvedSkillPath));
  const treatmentName = (values.treatment as string) ?? defaultTreatmentName;

  // 3. Find the latest report
  process.stderr.write(lang === 'zh' ? `🔍 正在查找 ${treatmentName} 的最新评测报告...\n` : `🔍 Scanning latest report for ${treatmentName}...\n`);
  const store = createFileStore(reportsDir);
  const reports = await store.findByVariant(treatmentName);

  if (reports.length === 0) {
    console.error(lang === 'zh' ? `未找到 ${treatmentName} 的评测报告（报告目录: ${reportsDir}）` : `No eval report found for ${treatmentName} in ${reportsDir}`);
    throw new CliExit(1);
  }

  const report = reports[0];
  process.stderr.write(lang === 'zh' ? `📄 使用报告: ${report.id} (${report.meta?.timestamp ?? '?'})\n` : `📄 Using report: ${report.id} (${report.meta?.timestamp ?? '?'})\n`);

  // 4. Load samples using the same semantics as eval.
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

  // 5. Count sample_design failures
  let sampleDesignCount = 0;
  for (const entry of report.results) {
    const variant = entry.variants?.[treatmentName] as unknown as Record<string, unknown> | undefined;
    if (!variant) continue;
    const diag = variant.diagnostic as Record<string, unknown> | undefined;
    const rootCause = (diag?.rootCause as string[]) ?? [];
    if (rootCause.includes('sample_design')) sampleDesignCount++;
  }

  if (sampleDesignCount === 0) {
    process.stderr.write(lang === 'zh' ? '✅ 没有 sample_design 类型的失败，无需修复\n' : '✅ No sample_design failures found, nothing to fix\n');
    return;
  }

  process.stderr.write(lang === 'zh' ? `🔧 发现 ${sampleDesignCount} 条 sample_design 失败，开始修复...\n` : `🔧 Found ${sampleDesignCount} sample_design failure(s), fixing...\n`);

  // 6. Create executor wrapper
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

  // 7. Run fixes
  const result = await fixSamples({
    skillContent,
    samples,
    report,
    treatmentKey: treatmentName,
    executor: executorFn,
    model,
  });

  // 8. Write back
  let writtenFiles: string[] = [];
  if (result.fixedCount > 0) {
    const changedIds = new Set(result.fixes.filter((f) => f.changed).map((f) => f.sampleId));
    writtenFiles = writeFixedSamplesToSources(loadedSamples, result.samples, changedIds);
  }

  // 9. Report
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
