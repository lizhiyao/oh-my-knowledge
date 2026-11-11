import { join, resolve } from 'node:path';
import { Args, Flags } from '@oclif/core';
import { z } from 'zod';
import { LANG_FLAG, bilingual } from '../../oclif/i18n.js';
import { FileExtractionRunStore } from '../../../knowledge/adapters/run-store.js';
import { ExtractionRunSealRequestSchema, ExtractionRunSealError } from '../../../knowledge/extraction/run-sealing.js';
import { knowledgeOperationSchemas, type KnowledgeOperation } from '../../../knowledge/application/operations.js';
import { KnowCommand, knowJsonFlag, knowWorkspaceFlag } from '../../lib/know-command.js';

const actions = ['list', 'inspect', 'quality', 'resume', 'prepare-associations', 'rebuild-associations', 'seal', 'sealed'] as const;
type Action = typeof actions[number];
type KnowRunsFlags = {
  workspace?: string;
  id?: string;
  'operation-id'?: string;
  operator?: string;
  reason?: string;
  'manifest-digest'?: string;
  'inventory-digest'?: string;
  'storage-namespace'?: string;
  offline?: boolean;
  json: boolean;
};
const sealFlags = ['operation-id', 'operator', 'manifest-digest', 'inventory-digest', 'storage-namespace', 'offline'];

export default class KnowRuns extends KnowCommand {
  static description = bilingual({ zh: '查看、核对、恢复或封存知识提炼执行。', en: 'Inspect, recover, or seal knowledge extraction runs.' });
  static args = { action: Args.string({ required: true, options: actions, description: bilingual({ zh: '运行管理动作。', en: 'Run management action.' }) }) };
  static flags = {
    workspace: knowWorkspaceFlag,
    id: Flags.string({ description: bilingual({ zh: '运行 UUID。', en: 'Run UUID.' }) }),
    input: Flags.string({ description: bilingual({ zh: '关联重建的完整 sources／bodyRefs JSON。', en: 'Complete sources/bodyRefs JSON for association rebuilding.' }) }),
    'run-id': Flags.string({ description: bilingual({ zh: '关联重建的稳定运行 UUID。', en: 'Stable run UUID for association rebuilding.' }) }),
    executor: Flags.string({ description: bilingual({ zh: '关联重建执行器。', en: 'Association rebuild executor.' }) }),
    model: Flags.string({ description: bilingual({ zh: '关联重建模型。', en: 'Association rebuild model.' }) }),
    'confirm-request': Flags.string({ description: bilingual({ zh: 'rebuild-associations：已核对完整请求的 requestDigest。', en: 'rebuild-associations: requestDigest of the inspected complete request.' }) }),
    'operation-id': Flags.string({ description: bilingual({ zh: 'seal：稳定操作 UUID。', en: 'seal: stable operation UUID.' }) }),
    operator: Flags.string({ description: bilingual({ zh: 'seal：显式声明的人类操作者，不构成身份认证。', en: 'seal: declared human operator; not identity authentication.' }) }),
    reason: Flags.string({ description: bilingual({ zh: 'seal：人工处置理由。', en: 'seal: human disposition reason.' }) }),
    'manifest-digest': Flags.string({ description: bilingual({ zh: 'seal：预先读取的原 manifest SHA-256。', en: 'seal: previously inspected original manifest SHA-256.' }) }),
    'inventory-digest': Flags.string({ description: bilingual({ zh: 'seal：预先读取的归档清单 SHA-256。', en: 'seal: previously inspected inventory SHA-256.' }) }),
    'storage-namespace': Flags.string({ options: ['current', 'legacy'], description: bilingual({ zh: 'current extraction-runs/ 或明确选择的 legacy runs/。', en: 'Current extraction-runs/ or explicitly selected legacy runs/.' }) }),
    offline: Flags.boolean({ description: bilingual({ zh: 'seal：声明相关旧程序已停写／离线，不代表进程退出证明。', en: 'seal: declare old writers stopped/offline; not proof of process exit.' }) }),
    json: knowJsonFlag,
    lang: LANG_FLAG,
  };
  static examples = [
    '<%= config.bin %> know runs inspect --workspace ./knowledge --id <run-id> --json',
    '<%= config.bin %> know runs resume --workspace ./knowledge --id <run-id>',
    '<%= config.bin %> know runs seal --workspace ./knowledge --id <run-id> --operation-id <uuid> --operator <human-id> --reason "reviewed offline disposition" --manifest-digest sha256:<digest> --inventory-digest sha256:<digest> --offline --json',
  ];

  async run(): Promise<void> {
    const { args, flags } = await this.parse(KnowRuns);
    const action = args.action as Action;
    const allowedByAction: Record<Action, string[]> = {
      list: [], quality: [], inspect: ['id'], resume: ['id'],
      'prepare-associations': ['input', 'run-id', 'executor', 'model'],
      'rebuild-associations': ['input', 'run-id', 'executor', 'model', 'confirm-request'],
      seal: [...sealFlags, 'id', 'reason'], sealed: ['id', 'storage-namespace'],
    };
    const allowed = new Set([...allowedByAction[action], 'workspace', 'json', 'lang']);
    if (Object.entries(flags).some(([name, value]) => value !== undefined && value !== false && !allowed.has(name))) {
      this.error(this.t('该运行动作不接受这些参数。', 'These flags are not accepted for this run action.'), { exit: 2 });
    }
    if (action === 'seal' || action === 'sealed') {
      await this.runSeal(action, flags);
      return;
    }
    let operation: KnowledgeOperation;
    if (action === 'list' || action === 'quality') operation = { operation: action === 'list' ? 'runs' : 'quality' };
    else if (action === 'inspect' || action === 'resume') operation = { operation: action, id: this.required(flags.id, 'id') };
    else {
      const parsed = knowledgeOperationSchemas['prepare-rebuild-associations'].omit({ operation: true, executor: true, model: true, runId: true })
        .safeParse(this.input(flags.input));
      if (!parsed.success) this.error(this.t('重建需要完整 sources 与精确 bodyRefs。', 'Rebuilding requires complete sources and exact bodyRefs.'), { exit: 2 });
      operation = action === 'prepare-associations'
        ? { operation: 'prepare-rebuild-associations', ...parsed.data, executor: 'configured', model: 'configured', runId: flags['run-id'] }
        : {
          operation: 'rebuild-associations', ...parsed.data, executor: 'configured', model: 'configured', runId: flags['run-id'],
          confirmedRequestDigest: this.required(flags['confirm-request'], 'confirm-request'),
        };
    }
    await this.executeKnowOperation(operation, flags);
  }

  private async runSeal(action: 'seal' | 'sealed', flags: KnowRunsFlags): Promise<void> {
    if (!flags.workspace?.trim()) this.error(this.t('封存操作必须显式提供 --workspace，不读取全局设置。', 'Sealing requires explicit --workspace and does not read global settings.'), { exit: 2 });
    const namespace = flags['storage-namespace'] === 'legacy' ? 'legacy' as const : 'current' as const;
    if (flags.id !== undefined && !z.string().uuid().safeParse(flags.id).success) this.error(this.t('--id 必须是运行 UUID。', '--id must be a run UUID.'), { exit: 2 });
    let request: z.infer<typeof ExtractionRunSealRequestSchema> | undefined;
    if (action === 'seal') {
      const checked = ExtractionRunSealRequestSchema.safeParse({
        runId: flags.id, operationId: flags['operation-id'], storageNamespace: namespace,
        actor: { actorKind: 'human', actorId: flags.operator }, reason: flags.reason,
        expectedManifestDigest: flags['manifest-digest'], expectedInventoryDigest: flags['inventory-digest'],
        offlineDeclared: flags.offline === true,
      });
      if (!checked.success) this.error(this.t('请提供运行、稳定操作、操作者、理由及预先读取的摘要。', 'Provide the run, stable operation, operator, reason, and previously inspected digests.'), { exit: 2 });
      request = checked.data;
    }
    try {
      const workspace = resolve(flags.workspace);
      const store = new FileExtractionRunStore(join(workspace, 'extraction-runs'), workspace);
      const result = request ? store.seal(request) : flags.id ? store.inspectSeal(flags.id, namespace) : store.listSeals();
      const safe = (value: unknown) => {
        if (!value || typeof value !== 'object') return value;
        const copy = { ...value } as Record<string, unknown>;
        delete copy.originalRun;
        return copy;
      };
      const value = Array.isArray(result)
        ? result.filter(item => flags['storage-namespace'] === undefined || item.request.storageNamespace === namespace).map(safe)
        : safe(result);
      if (flags.json) this.log(JSON.stringify(value, null, 2));
      else this.log([this.t('人工封存／执行状态未知；不代表成功、费用已知、进程退出或语义通过。', 'Human disposition / execution unknown; this does not establish success, known costs, process exit or semantic acceptance.'), JSON.stringify(value, null, 2)].join('\n\n'));
    } catch (cause) {
      const code = cause instanceof ExtractionRunSealError ? cause.sealCode : 'run_seal_unconfirmed';
      this.error(`${code} · ${this.t('封存未获确认。保留文件并先查询 runs sealed；不以新运行绕过未知状态。', 'Sealing was not confirmed. Preserve files and inspect runs sealed first; never bypass an unknown state with a new run.')}`, { exit: 1 });
    }
  }
}
