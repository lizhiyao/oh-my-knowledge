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
      count: { type: 'string', default: '5' },
      model: { type: 'string', default: 'sonnet' },
      'skill-dir': { type: 'string', default: 'skills' },
    },
    allowPositionals: true,
  });

  const { generateSamples } = await import('../../authoring/generator.js');
  const { readFileSync, writeFileSync } = await import('node:fs');
  const count: number = Math.max(1, Number(values.count) || 5);
  const model: string = values.model as string;

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
        name = entry.slice(0, -3);
        skillPath = fullPath;
        samplesPath = join(skillDir, `${name}.eval-samples.json`);
      } else if (statSync(fullPath).isDirectory()) {
        const skillMd: string = join(fullPath, 'SKILL.md');
        if (!existsSync(skillMd)) continue;
        name = entry;
        skillPath = skillMd;
        samplesPath = join(fullPath, 'eval-samples.json');
      } else {
        continue;
      }

      if (existsSync(samplesPath)) {
        process.stderr.write(tCli('cli.gen.skill_skipped_existing', lang, { name }));
        continue;
      }

      process.stderr.write(tCli('cli.gen.skill_generating', lang, { name, count }));
      try {
        const skillContent: string = readFileSync(skillPath, 'utf-8');
        const { samples, costUSD }: GenerateSamplesResult =
          await generateSamples({ skillContent, count, model });
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
    const outputPath: string = resolve('eval-samples.json');

    if (existsSync(outputPath)) {
      console.error(tCli('cli.gen.samples_already_exists', lang));
      throw new CliExit(1);
    }

    process.stderr.write(tCli('cli.gen.single_generating', lang, { count }));
    try {
      const { samples, costUSD }: GenerateSamplesResult =
        await generateSamples({ skillContent, count, model });
      writeFileSync(outputPath, JSON.stringify(samples, null, 2));
      const cost: string = costUSD > 0 ? ` $${costUSD.toFixed(4)}` : '';
      process.stderr.write(tCli('cli.gen.single_done', lang, {
        n: samples.length, path: outputPath, cost,
      }));
      console.log(tCli('cli.gen.review_hint', lang));
    } catch (err: unknown) {
      console.error(tCli('cli.gen.failed', lang, { message: (err as Error).message }));
      throw new CliExit(1);
    }
  }
}
