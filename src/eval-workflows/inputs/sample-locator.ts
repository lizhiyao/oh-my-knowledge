import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * 自动发现只认一个稳定 stem，以及两种一等格式。
 *
 * `.yml`、`samples.*`、`<skill>.eval-samples.*` 仍可通过显式 `--samples`
 * 读取，但不会参与隐式发现，避免同一作用域出现多套命名与静默优先级。
 */
export const EVAL_SAMPLE_FILENAMES = ['eval-samples.json', 'eval-samples.yaml'] as const;

export class SampleFileAmbiguityError extends Error {
  readonly paths: readonly string[];

  constructor(paths: readonly string[]) {
    super(`Ambiguous eval sample files: ${paths.join(', ')}`);
    this.name = 'SampleFileAmbiguityError';
    this.paths = Object.freeze([...paths]);
  }
}

const SAMPLE_FILE_RE = /\.(json|ya?ml)$/i;
const RESERVED_SAMPLE_FILE_RE = /^(report|health|_)/i;

function isExistingFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isExistingDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function hasLoadableSampleFile(dir: string): boolean {
  if (!isExistingDirectory(dir)) return false;
  try {
    return readdirSync(dir).some((file) => SAMPLE_FILE_RE.test(file) && !RESERVED_SAMPLE_FILE_RE.test(file));
  } catch {
    return false;
  }
}

/**
 * 在一个自动发现作用域内解析 canonical sample 文件。
 * JSON 与 YAML 同时存在代表两份互相竞争的真相，必须 fail closed。
 */
export function findCanonicalSamplesFile(dir: string): string | null {
  const matches = EVAL_SAMPLE_FILENAMES
    .map((name) => join(dir, name))
    .filter(isExistingFile);
  if (matches.length > 1) {
    throw new SampleFileAmbiguityError(matches);
  }
  return matches[0] ?? null;
}

export function findProjectSamplesFile(dir: string): string | null {
  return findCanonicalSamplesFile(dir);
}

export function skillLocalSamplesDir(skillRoot: string): string {
  return join(skillRoot, '.omk');
}

export function defaultSkillLocalSamplesFile(skillRoot: string): string {
  return join(skillLocalSamplesDir(skillRoot), EVAL_SAMPLE_FILENAMES[0]);
}

/** 显式 --samples 继续支持单文件或分片目录。 */
export function hasUsableSamplesPath(path: string): boolean {
  if (isExistingFile(path)) return true;
  return hasLoadableSampleFile(path);
}

export function findSkillSamplesPath(skillRoot: string): string | null {
  return findCanonicalSamplesFile(skillLocalSamplesDir(skillRoot));
}

export function isDirectorySkillRoot(path: string): boolean {
  return isExistingDirectory(path) && isExistingFile(join(path, 'SKILL.md'));
}

export function findNamedSkillSamplesPath(skillDir: string, skillName: string): string | null {
  // variant 解析对同名 flat / directory skill 是 file-first；samples 发现必须同口径，
  // 否则会执行 flat skill 却加载 directory skill 的私有用例。
  if (isExistingFile(join(skillDir, `${skillName}.md`))) return null;
  const dirSkillRoot = join(skillDir, skillName);
  return isDirectorySkillRoot(dirSkillRoot) ? findSkillSamplesPath(dirSkillRoot) : null;
}

function findSamplesForExistingSkillPath(path: string): string | null {
  if (isExistingDirectory(path)) {
    return findSkillSamplesPath(path);
  }

  const parent = dirname(path);
  if (basename(path) === 'SKILL.md') {
    return findSkillSamplesPath(parent);
  }
  // 扁平 skill 没有独立的私有 sample 命名空间，交给调用方回退项目级文件。
  if (/\.md$/i.test(path)) return null;
  return findProjectSamplesFile(parent);
}

export function findSingleTreatmentSamplesPath(
  treatmentExpr: string,
  skillDir: string,
  cwd: string = process.cwd(),
): string | null {
  const resolved = resolve(cwd, treatmentExpr);
  if (existsSync(resolved)) {
    const samplesPath = findSamplesForExistingSkillPath(resolved);
    if (samplesPath) return samplesPath;
  }
  return findNamedSkillSamplesPath(skillDir, treatmentExpr);
}
