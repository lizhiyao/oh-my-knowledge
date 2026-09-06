import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { checkDependencies } from '../../executors/preflight/dependencies.js';
import type { Artifact } from '../../knowledge-artifacts/contracts.js';
import type { CliEvaluationCompileResult } from '../../eval-workflows/input-compilation/index.js';
import type { OmkRuntimePreflightDeclaration } from '../types.js';
import { OmkUserFacingPreflightFailure } from './preflight.js';

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

async function doctorArtifacts(compiled: CliEvaluationCompileResult): Promise<Artifact[]> {
  const targetsById = new Map(compiled.definition.targets.map((target) => [target.targetId, target]));
  return Promise.all(compiled.hostResources.resources.flatMap((resource) => {
    if (resource.resourceKind !== 'artifact') return [];
    const lineage = record(resource.lineage);
    const targetId = typeof lineage?.targetId === 'string' ? lineage.targetId : undefined;
    const target = targetId === undefined ? undefined : targetsById.get(targetId);
    const artifactKind = lineage?.artifactKind;
    if (target === undefined || artifactKind === 'baseline'
        || !['skill', 'prompt', 'agent', 'workflow'].includes(String(artifactKind))) return [];
    return [(async (): Promise<Artifact> => {
      const sourceLocator = typeof lineage?.sourceLocator === 'string'
        ? lineage.sourceLocator
        : resource.locator;
      const isDirectorySkill = typeof lineage?.skillRootLocator === 'string';
      const skillRoot = isDirectorySkill ? resource.locator : undefined;
      const contentPath = skillRoot === undefined
        ? resource.locator
        : join(resource.locator, 'SKILL.md');
      const content = await readFile(contentPath, 'utf8');
      const sourceKind = lineage?.sourceKind;
      return {
        name: target.targetId,
        kind: artifactKind as Artifact['kind'],
        source: ['variant-name', 'file-path', 'git', 'inline', 'custom'].includes(String(sourceKind))
          ? sourceKind as Artifact['source']
          : 'custom',
        content,
        locator: sourceLocator,
        ...(skillRoot === undefined ? {} : { skillRoot }),
        ...(typeof lineage?.workingDirectoryLocator === 'string'
          ? { cwd: lineage.workingDirectoryLocator }
          : {}),
      };
    })()];
  }));
}

function dependencyDoctor(
  compiled: CliEvaluationCompileResult,
  environment: NodeJS.ProcessEnv,
  projectRoot: string,
): OmkRuntimePreflightDeclaration {
  let result: Promise<void> | undefined;
  return Object.freeze({
    preflightKind: 'doctor' as const,
    checkId: 'host-dependencies',
    preflightDisposition: 'check' as const,
    async run(): Promise<void> {
      result ??= (async () => {
        const requirements = compiled.orchestration.dependencyRequirements;
        if (requirements !== undefined) {
          const { baseDirectoryLocator, ...dependencies } = requirements;
          const checked = await checkDependencies({
            ...(dependencies.tools === undefined ? {} : { tools: [...dependencies.tools] }),
            ...(dependencies.files === undefined ? {} : { files: [...dependencies.files] }),
            ...(dependencies.env === undefined ? {} : { env: [...dependencies.env] }),
            ...(dependencies.preflight === undefined ? {} : {
              preflight: [...dependencies.preflight],
            }),
          }, baseDirectoryLocator, environment);
          if (!checked.ok) throw new Error('Evaluation dependency doctor failed.');
        }
        const artifacts = await doctorArtifacts(compiled);
        if (artifacts.length === 0) return;
        const { runDoctor } = await import('../../knowledge-artifacts/doctor/index.js');
        const { renderDoctorReportText } = await import('../../knowledge-artifacts/doctor/renderer.js');
        const { tEvalWorkflowMessage } = await import('../../eval-workflows/messages.js');
        const language = compiled.presentation.language;
        const report = await runDoctor({
          artifacts,
          cwd: projectRoot,
          dependencyCwd: requirements?.baseDirectoryLocator ?? projectRoot,
          executorName: compiled.definition.targets[0]?.executorId ?? 'unknown',
          model: 'core-runtime',
          timeoutMs: compiled.policy.execution.timeoutMs ?? 8_000,
          lang: language,
        });
        if (report.outcome === 'failed') {
          renderDoctorReportText(report, language);
          throw new OmkUserFacingPreflightFailure(
            `doctor failed:\n${tEvalWorkflowMessage('doctor_gate_blocked', language)}`,
          );
        }
      })();
      return result;
    },
  });
}

export function createNodeHostPreflightDeclarations(
  compiled: CliEvaluationCompileResult,
  environment: NodeJS.ProcessEnv,
  projectRoot: string,
): readonly OmkRuntimePreflightDeclaration[] {
  const hasMcpResource = compiled.hostResources.resources.some(
    (resource) => resource.resourceKind === 'mcp-config',
  );
  const hasMockResource = compiled.hostResources.resources.some(
    (resource) => resource.resourceKind === 'mock-plan'
      || resource.resourceKind === 'mock-rule'
      || resource.resourceKind === 'mock-payload',
  );
  const mcpPreflight: OmkRuntimePreflightDeclaration = hasMcpResource
    ? {
        preflightKind: 'mcp-readiness',
        checkId: 'sealed-mcp-resource',
        preflightDisposition: 'check',
        async run(): Promise<void> {
          await Promise.all(compiled.hostResources.resources
            .filter((resource) => resource.resourceKind === 'mcp-config')
            .map((resource) => access(resource.locator, constants.R_OK)));
        },
      }
    : {
        preflightKind: 'mcp-readiness',
        checkId: 'sealed-mcp-resource',
        preflightDisposition: 'not-required',
        reasonCode: 'no-mcp-resource',
      };
  const mockPreflight: OmkRuntimePreflightDeclaration = hasMockResource
    ? {
        preflightKind: 'mock-readiness',
        checkId: 'sealed-mock-resources',
        preflightDisposition: 'check',
        async run(): Promise<void> {
          await Promise.all(compiled.hostResources.resources
            .filter((resource) => resource.resourceKind === 'mock-plan'
              || resource.resourceKind === 'mock-rule'
              || resource.resourceKind === 'mock-payload')
            .map((resource) => access(resource.locator, constants.R_OK)));
        },
      }
    : {
        preflightKind: 'mock-readiness',
        checkId: 'sealed-mock-resources',
        preflightDisposition: 'not-required',
        reasonCode: 'no-mock-resource',
      };
  return Object.freeze([
    dependencyDoctor(compiled, environment, projectRoot),
    Object.freeze({
      preflightKind: 'filesystem' as const,
      checkId: 'sealed-resource-locators',
      preflightDisposition: 'check' as const,
      async run(): Promise<void> {
        await Promise.all(compiled.hostResources.resources.map((resource) => (
          access(resource.locator, constants.R_OK)
        )));
      },
    }),
    Object.freeze(mcpPreflight),
    Object.freeze(mockPreflight),
    Object.freeze({
      preflightKind: 'credential' as const,
      checkId: 'host-credential',
      preflightDisposition: 'not-required' as const,
      reasonCode: 'adapter-validates-credential',
    }),
    Object.freeze({
      preflightKind: 'connectivity' as const,
      checkId: 'provider-connectivity',
      preflightDisposition: 'not-required' as const,
      reasonCode: 'core-execution-is-authoritative',
    }),
  ]);
}
