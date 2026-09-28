import { Args, Flags } from '@oclif/core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { BaseCommand } from '../../oclif/base-command.js';
import { LANG_FLAG, bilingual } from '../../oclif/i18n.js';
import { prepareLocalTask } from '../../../eval-workflows/hosts/local-task/application.js';

export default class EvalTask extends BaseCommand {
  static description = bilingual({ zh: '从固定快照执行可信本地任务 A/B，采集产物并独立验收。', en: 'Run trusted local task A/B from a fixed snapshot, collect artifacts and verify outcomes independently.' });
  static args = { definition: Args.string({ required: true, description: bilingual({ zh: '本地任务 YAML／JSON 定义。', en: 'Local task YAML/JSON definition.' }) }) };
  static flags = {
    lang: LANG_FLAG,
    'dry-run': Flags.boolean({ description: bilingual({ zh: '预览封存计划，不执行任务。', en: 'Preview the sealed plan without executing tasks.' }) }),
    output: Flags.string({ default: '.omk/eval', description: bilingual({ zh: '报告输出目录。', en: 'Report output directory.' }) }),
  };
  async run(): Promise<void> {
    const { args, flags } = await this.parse(EvalTask);
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'omk-local-task-'));
    try {
      await this.runWithCancellation(async (signal) => {
        const application = await prepareLocalTask({ definitionPath: resolve(args.definition), temporaryRoot,
          outputDirectory: resolve(flags.output),
          authenticationFile: join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json'),
        });
        if (flags['dry-run']) { this.log(JSON.stringify(application.preview, null, 2)); return; }
        process.stderr.write(`${JSON.stringify(application.preview, null, 2)}\n`);
        const { result, artifacts, reference, diagnosticsDirectory, diagnosticReferences } = await application.run(signal);
        this.log(JSON.stringify({ runId: result.runId, outputDirectory: resolve(flags.output), reference, diagnosticsDirectory, diagnosticReferences, report: artifacts.report }, null, 2));
        if (result.status !== 'completed' || artifacts.execution.records.some((record) => record.executionStatus !== 'completed')
          || artifacts.evaluation.records.some((record) => record.evaluationStatus !== 'completed'
            || record.observations.some((observation) => observation.observationStatus !== 'observed'))) this.exit(1);
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}
