import { resolve, join, basename, dirname, extname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { Args, Flags } from '@oclif/core';
import { LANG_FLAG, bilingual } from '../oclif/i18n.js';
import { BaseCommand } from '../oclif/base-command.js';
import { integerStringParser } from '../oclif/parsers.js';
import { CliExit } from '../lib/cli-exit.js';
import { tCli, type CliLang } from '../lib/i18n.js';
import { projectReportsDir, globalReportsDir } from '../../eval-core/measurement-dirs.js';
import { loadSamples, parseYaml, type LoadSamplesResult } from '../../inputs/load-samples.js';
import { hashSample } from '../../eval-core/evaluation-reporting.js';
import { hashArtifactSource } from '../../inputs/content-hash.js';
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
 *  best-effort:解析失败的文件跳过。 */
function collectDirSampleIds(dir: string): Set<string> {
  const ids = new Set<string>();
  let files: string[];
  try { files = readdirSync(dir); } catch { return ids; }
  for (const f of files) {
    if (!/\.(json|ya?ml)$/i.test(f) || /^(report|health|_)/i.test(f)) continue;
    const full = join(dir, f);
    try {
      for (const s of getSamplesArray(parseSampleDocument(full), full)) {
        if (typeof s.sample_id === 'string') ids.add(s.sample_id);
      }
    } catch { /* skip unparseable / 非 sample 文件 */ }
  }
  return ids;
}

/** 把新用例追加进已有 sample 文件:读 → 合并(撞 id 去重)→ 保留原 json/yaml 格式与
 *  `{samples:[...]}` wrapper 写回。返回合并后总条数。 */
export function appendSamplesToFile(
  existingFile: string,
  fresh: SampleType[],
  reserved?: ReadonlySet<string>,
): number {
  const doc = parseSampleDocument(existingFile);
  const merged = mergeAppendSamples(getSamplesArray(doc, existingFile), fresh, reserved);
  const nextDoc = Array.isArray(doc) ? merged : { ...(doc as Record<string, unknown>), samples: merged };
  writeFileSync(existingFile, stringifySampleDocument(existingFile, nextDoc));
  return merged.length;
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
  currentContentHash: string;
  samples: SampleType[];
  sampleIds: Set<string>;
  lang?: CliLang;
}): void {
  const { report, treatmentName, currentContentHash, samples, sampleIds } = params;
  const lang = params.lang ?? 'zh';
  const issues: string[] = [];

  // schemaVersion < 2 的报告:artifactHashes 是旧「仅 SKILL.md 正文文本」哈,与当前「整棵可分发树」哈
  // 不同空间,直接比对会必然误报不一致。识别后给可见提示(归入 issues → 触发「请先重跑 eval」),
  // 不拿旧文本哈与当前树哈错配比对。sample 指纹口径未变,下面照常校。
  if ((report.meta.schemaVersion ?? 0) < 2) {
    issues.push(lang === 'zh'
      ? `报告早于树哈纪元（skill 指纹口径已从「仅 SKILL.md 文本」改为「整棵可分发树」），无法与当前指纹比对。`
      : `Report predates the tree-hash era (skill fingerprint changed from SKILL.md-body-text to whole-tree); cannot compare against the current fingerprint.`);
  } else {
    const expectedSkillHash = report.meta.artifactHashes?.[treatmentName];
    if (!expectedSkillHash) {
      issues.push(lang === 'zh'
        ? `报告缺少 ${treatmentName} 的 skill 指纹，无法确认诊断对应当前 SKILL.md。`
        : `Report is missing the skill hash for ${treatmentName}; cannot verify it matches the current SKILL.md.`);
    } else if (expectedSkillHash !== currentContentHash) {
      issues.push(lang === 'zh'
        ? `skill 指纹不一致：报告 ${expectedSkillHash}，当前 ${currentContentHash}。`
        : `Skill hash mismatch: report ${expectedSkillHash}, current ${currentContentHash}.`);
    }
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
  const { createFileStore, createOverlayReportStore } = await import('../../server/report-store.js');

  const model = flags.model;

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
  // 显式 --reports-dir 固定该目录;默认 overlay(项目 .omk/reports 盖全局),findByVariant 记录优先看项目、
  // 空则全局兜底,不因 eval 写默认翻项目而查不到报告。
  const store = flags['reports-dir']
    ? createFileStore(resolve(flags['reports-dir']))
    : createOverlayReportStore(projectReportsDir(), globalReportsDir());
  const reports = await store.findByVariant(treatmentName);

  if (reports.length === 0) {
    const where = flags['reports-dir']
      ? resolve(flags['reports-dir'])
      : (lang === 'zh' ? '项目 .omk/reports 或全局 ~/.oh-my-knowledge/reports' : 'project .omk/reports or global ~/.oh-my-knowledge/reports');
    console.error(lang === 'zh' ? `未找到 ${treatmentName} 的评测报告（报告目录: ${where}）` : `No eval report found for ${treatmentName} in ${where}`);
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

  // 当前内容指纹走整树哈,与 eval 报告口径一致:dir-skill(用户传 .../SKILL.md)哈整棵 skill 目录、
  // 单文件 .md 哈单文件字节。
  const currentContentHash = hashArtifactSource(isDir ? skillDir : resolvedSkillPath, isDir);

  try {
    assertFixReportMatchesCurrentInputs({
      report,
      treatmentName,
      currentContentHash,
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
  const exec = createExecutor(flags.executor ?? 'claude');
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

async function runSampleFromTraces(
  flags: SampleFlags,
  lang: CliLang,
): Promise<void> {
  const { queryObservationInbox, DEFAULT_OBSERVATIONS_DIR } = await import('../../observability/inbox.js');
  const { generateSamplesFromTraces } = await import('../../authoring/generator.js');

  const obsDir = resolve(flags['observations-dir'] ?? DEFAULT_OBSERVATIONS_DIR);
  if (!existsSync(obsDir)) {
    console.error(lang === 'zh'
      ? `observe-inbox 目录不存在: ${obsDir}（先运行 omk observe ingest 生成）`
      : `Observe-inbox dir not found: ${obsDir} (run omk observe ingest first)`);
    throw new CliExit(1);
  }

  // Drop noise-tier signals up front: they're exactly what the generator is told to
  // skip, so filtering here avoids feeding junk to the LLM and keeps the no-op path clean.
  const items = queryObservationInbox(obsDir).filter((it) => it.severity !== 'noise');
  if (items.length === 0) {
    process.stderr.write(lang === 'zh'
      ? `✅ ${obsDir} 没有可回流的失败信号（噪声级已跳过）\n`
      : `✅ No recyclable failure signals in ${obsDir} (noise-level skipped)\n`);
    return;
  }

  const outPath = join(obsDir, 'sample-drafts.json');
  if (existsSync(outPath)) {
    console.error(lang === 'zh'
      ? `草稿已存在: ${outPath}，请先 review 并合入正式集（或删除）后再生成`
      : `Draft already exists: ${outPath}; review/merge (or remove) it before regenerating`);
    throw new CliExit(1);
  }

  const count: number | undefined = flags.count !== undefined ? Math.max(1, Number(flags.count) || 5) : undefined;
  process.stderr.write(lang === 'zh'
    ? `🔭 发现 ${items.length} 个失败信号，正在生成回归用例草稿...\n`
    : `🔭 Found ${items.length} failure signal(s); generating regression-sample drafts...\n`);

  try {
    const { samples, costUSD } = await generateSamplesFromTraces({ items, count, model: flags.model, executorName: flags.executor });
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
    writeFileSync(outPath, JSON.stringify(samples, null, 2));
    process.stderr.write(lang === 'zh'
      ? `\n✅ 生成 ${samples.length} 条草稿用例 → ${outPath}（provenance: production-trace）${cost}\n   ⚠️ 这是草稿：trace 只抓失败信号，有抽样偏差。请人工 review 后再合入正式 eval-samples，不要直接当评测集。\n`
      : `\n✅ Generated ${samples.length} draft sample(s) → ${outPath} (provenance: production-trace)${cost}\n   ⚠️ Draft only: traces capture failures, a biased sample. Review before merging into your eval-samples; don't use as-is.\n`);
  } catch (err: unknown) {
    if (err instanceof CliExit) throw err;
    console.error(lang === 'zh' ? `生成失败: ${(err as Error).message}` : `Generation failed: ${(err as Error).message}`);
    throw new CliExit(1);
  }
}

async function runSample(
  args: SampleArgs,
  flags: SampleFlags,
  lang: CliLang,
): Promise<void> {
  if (flags['from-traces']) {
    await runSampleFromTraces(flags, lang);
    return;
  }
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
          await generateSamples({ skillContent, count, model, focus, noMock: flags['no-mock'], executorName: flags.executor });
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
        const existing = readdirSync(dir).find((f) => /\.(json|ya?ml)$/i.test(f) && !/^(report|health|_)/i.test(f));
        if (existing) existingFile = join(dir, existing);
      }
      outputPath = existingFile ?? join(dir, 'samples.json');
    } else {
      outputPath = resolved.samplesPath;
      if (existsSync(outputPath)) existingFile = outputPath;
    }

    // 已有用例文件:默认报错保护;--append 时追加(下面合并),不报错。
    if (existingFile && !flags.append) {
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
        await generateSamples({ skillContent, count, model, focus, noMock: flags['no-mock'], executorName: flags.executor });
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
        writeFileSync(outputPath, JSON.stringify(samples, null, 2));
        process.stderr.write(tCli('cli.gen.single_done', lang, {
          n: samples.length, path: outputPath, cost,
        }));
      }
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
    zh: '为指定 skill 生成评测用例（eval-samples），支持 batch / single / fix / from-traces 四种模式。',
    en: 'Generate eval samples for the given skill. Supports batch / single / fix / from-traces modes.',
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
        zh: '根据最近评测报告自动修复 sample_design 类型失败',
        en: 'Auto-fix sample_design failures using the most recent eval report',
      }),
      command: '<%= config.bin %> sample skills/my-skill/SKILL.md --fix',
    },
    {
      description: bilingual({
        zh: '从 observe inbox 的失败信号回流生成回归用例草稿',
        en: 'Recycle observe-inbox failure signals into draft regression samples',
      }),
      command: '<%= config.bin %> sample --from-traces',
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
        zh: '生成用例条数。不传由 LLM 按 skill 类型自动决定。',
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
    executor: Flags.string({
      description: bilingual({
        zh: '执行器名，默认 claude（同 omk eval / doctor / evolve）。指定 codex 等其它执行器时，记得连带传一个该执行器能识别的 --model。',
        en: 'Executor name, default claude (same as omk eval / doctor / evolve). When using another executor like codex, also pass a --model it recognizes.',
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
        zh: '在已有用例文件上追加新生成的用例（撞 sample_id 自动加后缀去重，保留原 json/yaml 格式）。不传则已有文件时报错保护。常配 --focus 补特定场景。',
        en: 'Append newly generated samples to the existing samples file (colliding sample_id auto-suffixed, original json/yaml shape kept). Without it, an existing file errors out. Often paired with --focus.',
      }),
      default: false,
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
    'from-traces': Flags.boolean({
      description: bilingual({
        zh: 'from-traces 模式：从 observe inbox 的失败信号回流生成回归用例草稿（provenance: production-trace），落草稿待人工 review。',
        en: 'from-traces mode: recycle observe-inbox failure signals into draft regression samples (provenance: production-trace) for review.',
      }),
      default: false,
    }),
    'observations-dir': Flags.string({
      description: bilingual({
        zh: 'observe inbox 目录（from-traces 模式用），默认项目 .omk/observe-inbox。',
        en: 'Observe inbox dir (from-traces mode), default project .omk/observe-inbox.',
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
