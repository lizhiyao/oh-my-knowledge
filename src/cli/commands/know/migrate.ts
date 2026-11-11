import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { Args, Flags } from '@oclif/core';
import { z } from 'zod';
import { LANG_FLAG, bilingual } from '../../oclif/i18n.js';
import { prepareKnowledgeMigration, applyKnowledgeMigration } from '../../../knowledge/adapters/knowledge-migration.js';
import { prepareAssociationMigration, applyAssociationMigration, type AssociationMigrationPlan } from '../../../knowledge/adapters/association-migration.js';
import { prepareSourceMigration, applySourceMigration, SOURCE_MIGRATION_PLAN_MAX_BYTES, type SourceMigrationPlan } from '../../../knowledge/adapters/source-migration.js';
import { planKnowledgeWorkflowMigration, applyKnowledgeWorkflowMigration, type KnowledgeWorkflowMigrationPlan } from '../../../knowledge/adapters/workflow-migration.js';
import { SourceDigestSchema } from '../../../knowledge/sources/sources.js';
import { KnowCommand, knowJsonFlag, knowWorkspaceFlag } from '../../lib/know-command.js';
import { knowledgeReviewCliActor } from '../../lib/knowledge-review-actor.js';

const actions = ['knowledge', 'associations', 'sources', 'workflow'] as const;
type Action = typeof actions[number];
type KnowMigrateFlags = {
  'from-workspace'?: string;
  workspace?: string;
  'operation-id'?: string;
  'matching-build'?: string;
  'matching-build-id'?: string;
  'plan-only'?: boolean;
  input?: string;
  'confirm-plan'?: string;
};

export default class KnowMigrate extends KnowCommand {
  static description = bilingual({ zh: '将旧知识工作区显式迁移到独立副本。', en: 'Explicitly migrate an old knowledge workspace to an independent copy.' });
  static args = { action: Args.string({ required: true, options: actions, description: bilingual({ zh: '迁移数据类型。', en: 'Data type to migrate.' }) }) };
  static flags = {
    'from-workspace': Flags.string({ description: bilingual({ zh: '显式旧工作区。', en: 'Explicit old workspace.' }) }),
    workspace: knowWorkspaceFlag,
    'operation-id': Flags.string({ description: bilingual({ zh: '稳定迁移操作 UUID，重入沿用。', en: 'Stable migration operation UUID; reuse on replay.' }) }),
    'matching-build': Flags.string({ description: bilingual({ zh: 'sources／workflow：匹配旧版本安装档案。', en: 'sources/workflow: matching old-version installation archive.' }) }),
    'matching-build-id': Flags.string({ description: bilingual({ zh: 'sources／workflow：宿主声明的旧构建身份。', en: 'sources/workflow: host-declared old build identity.' }) }),
    'plan-only': Flags.boolean({ description: bilingual({ zh: 'sources／workflow：只读导出固定迁移计划。', en: 'sources/workflow: export the fixed migration plan read-only.' }) }),
    input: Flags.string({ description: bilingual({ zh: 'sources／workflow：执行固定计划 JSON。', en: 'sources/workflow: fixed plan JSON to apply.' }) }),
    'confirm-plan': Flags.string({ description: bilingual({ zh: 'sources／workflow：确认固定计划 SHA-256。', en: 'sources/workflow: confirm the fixed plan SHA-256.' }) }),
    json: knowJsonFlag,
    lang: LANG_FLAG,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(KnowMigrate);
    const action = args.action as Action;
    const applying = (action === 'sources' || action === 'workflow') && flags.input !== undefined;
    const allowedByAction: Record<Action, string[]> = {
      knowledge: ['from-workspace', 'workspace'],
      associations: ['from-workspace', 'workspace', 'operation-id'],
      sources: [], workflow: [],
    };
    const allowed = new Set(action === 'sources' || action === 'workflow'
      ? applying ? ['input', 'confirm-plan', 'json', 'lang'] : ['from-workspace', 'workspace', 'operation-id', 'matching-build', 'matching-build-id', 'plan-only', 'json', 'lang']
      : [...allowedByAction[action], 'json', 'lang']);
    if (Object.entries(flags).some(([name, value]) => value !== undefined && value !== false && !allowed.has(name))) {
      this.error(this.t('该迁移动作不接受这些参数。', 'These flags are not accepted for this migration action.'), { exit: 2 });
    }
    if (action === 'knowledge') {
      await this.runKnowledge(flags);
    } else if (action === 'associations') {
      await this.runAssociations(flags);
    } else {
      await this.runFixedPlan(action, flags, applying);
    }
  }

  private async runKnowledge(flags: KnowMigrateFlags): Promise<void> {
    if (!flags['from-workspace']?.trim() || !flags.workspace?.trim()) this.error(this.t('knowledge 迁移须显式提供旧目录和独立新目标。', 'Knowledge migration requires an explicit old workspace and separate new target.'), { exit: 2 });
    try {
      const plan = prepareKnowledgeMigration({
        sourceRoot: flags['from-workspace'], targetRoot: flags.workspace, namespace: 'local',
        actor: { actorKind: 'human', actorId: 'local-user' }, at: new Date().toISOString(), migrationId: randomUUID(),
      });
      const result = applyKnowledgeMigration(plan, plan.planDigest);
      this.log(JSON.stringify({ ...result, migrationId: plan.migrationId, sourceRoot: plan.sourceRoot, targetRoot: plan.targetRoot,
        originalBytesPreserved: true, modelCalls: 0, semanticAcceptance: false, limitations: plan.limitations }, null, 2));
    } catch (cause) {
      this.error(`${this.t('迁移未完成；保留原目录和目标中的计划／原件。', 'Migration did not complete; preserve the source, target plan, and originals.')}\n${cause instanceof Error ? cause.message : String(cause)}`, { exit: 1 });
    }
  }

  private async runAssociations(flags: KnowMigrateFlags): Promise<void> {
    if (!flags['from-workspace']?.trim() || !flags.workspace?.trim() || !z.string().uuid().safeParse(flags['operation-id']).success) {
      this.error(this.t('关联迁移须显式提供旧目录、独立目标和稳定操作 UUID。', 'Association migration requires explicit old/new workspaces and a stable operation UUID.'), { exit: 2 });
    }
    try {
      const sourceRoot = resolve(flags['from-workspace']!);
      const targetRoot = resolve(flags.workspace!);
      const migrationId = flags['operation-id']!;
      const path = join(targetRoot, 'migration', migrationId, 'plan.json');
      let plan: AssociationMigrationPlan;
      if (existsSync(path)) {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error('Invalid migration plan file.');
        plan = JSON.parse(readFileSync(path, 'utf8')) as AssociationMigrationPlan;
        if (plan.sourceRoot !== sourceRoot || plan.targetRoot !== targetRoot || plan.migrationId !== migrationId || plan.namespace !== 'local') {
          throw new Error('Migration invocation does not match its frozen plan.');
        }
      } else {
        plan = prepareAssociationMigration({ sourceRoot, targetRoot, migrationId, namespace: 'local',
          actor: { actorKind: 'human', actorId: 'local-user' }, at: new Date().toISOString() });
      }
      const result = applyAssociationMigration(plan, plan.planDigest);
      this.log(JSON.stringify({ ...result, migrationId, sourceRoot, targetRoot, originalBytesPreserved: true,
        modelCalls: 0, semanticAcceptance: false, limitations: plan.limitations }, null, 2));
    } catch (cause) {
      this.error(`${this.t('迁移未完成；保留原目录、目标计划和原件，以同一 --operation-id 重入。', 'Migration did not complete; preserve the source, target plan, and originals; replay the same --operation-id.')}\n${cause instanceof Error ? cause.message : String(cause)}`, { exit: 1 });
    }
  }

  private async runFixedPlan(action: 'sources' | 'workflow', flags: KnowMigrateFlags, applying: boolean): Promise<void> {
    if (applying && !SourceDigestSchema.safeParse(flags['confirm-plan']).success) {
      this.error(this.t('执行固定迁移计划须提供精确 --confirm-plan。', 'Applying a fixed migration plan requires exact --confirm-plan.'), { exit: 2 });
    }
    if (!applying && (!flags['plan-only'] || !flags['from-workspace']?.trim() || !flags.workspace?.trim()
      || !z.string().uuid().safeParse(flags['operation-id']).success || !flags['matching-build']?.trim() || !flags['matching-build-id']?.trim())) {
      this.error(this.t('计划导出须使用独立旧／新目录、稳定 UUID、匹配构建及 --plan-only。', 'Planning requires separate roots, a stable UUID, a matching build, and --plan-only.'), { exit: 2 });
    }
    try {
      const common = {
        sourceRoot: resolve(flags['from-workspace'] ?? ''), targetRoot: resolve(flags.workspace ?? ''),
        migrationId: flags['operation-id']!, namespace: 'local' as const,
        actor: action === 'workflow' ? knowledgeReviewCliActor(process.env) ?? { actorKind: 'human' as const, actorId: 'local-user' }
          : { actorKind: 'human' as const, actorId: 'local-user' }, at: new Date().toISOString(),
        matchingBuildArchivePath: resolve(flags['matching-build'] ?? ''), matchingBuildId: flags['matching-build-id']!,
      };
      if (action === 'sources') {
        const plan = applying ? this.input(flags.input, SOURCE_MIGRATION_PLAN_MAX_BYTES) as SourceMigrationPlan : prepareSourceMigration(common);
        this.log(JSON.stringify(applying ? { ...applySourceMigration(plan, flags['confirm-plan']!), modelCalls: 0, semanticAcceptance: false, limitations: plan.limitations } : plan, null, 2));
      } else {
        const plan = applying ? this.input(flags.input) as KnowledgeWorkflowMigrationPlan : planKnowledgeWorkflowMigration(common);
        this.log(JSON.stringify(applying ? { ...applyKnowledgeWorkflowMigration(plan, flags['confirm-plan']!), modelCalls: 0, semanticAcceptance: false } : plan, null, 2));
      }
    } catch (cause) {
      this.error(`${this.t('迁移未完成；保留原目录、目标与固定计划。', 'Migration did not complete; preserve the source, target, and fixed plan.')}\n${cause instanceof Error ? cause.message : String(cause)}`, { exit: 1 });
    }
  }
}
