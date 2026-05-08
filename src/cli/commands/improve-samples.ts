import { CliExit } from '../cli-exit.js';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { tCli, langFromArgv } from '../i18n.js';
import { COMMON_OPTIONS } from '../parse-run-config.js';
import { parseArgsStrictOrExit } from '../parse-strict.js';

interface GenerateSamplesResult {
  samples: unknown[];
  costUSD: number;
}

export async function execute(argv: string[]): Promise<void> {
  const lang = langFromArgv(argv);
  const { values } = parseArgsStrictOrExit({
    args: argv,
    options: {
      ...COMMON_OPTIONS,
      batch: { type: 'boolean', default: false },
      count: { type: 'string' },
      model: { type: 'string', default: 'opus' },
      'skill-dir': { type: 'string', default: 'skills' },
      focus: { type: 'string' },
    },
    allowPositionals: true,
  });

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
    // Single skill mode
    const skillPath: string | undefined = argv.find((a: string) => !a.startsWith('-'));
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
