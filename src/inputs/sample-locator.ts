import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export const PROJECT_SAMPLE_FILENAMES = ['eval-samples.json', 'eval-samples.yaml', 'eval-samples.yml'] as const;
export const SKILL_LOCAL_SAMPLE_FILENAMES = ['samples.json', 'samples.yaml', 'samples.yml'] as const;

export interface DeprecatedSkillSamplesHint {
  oldPath: string;
  newPath: string;
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

export function hasLoadableSampleFile(dir: string): boolean {
  if (!isExistingDirectory(dir)) return false;
  try {
    return readdirSync(dir).some((file) => SAMPLE_FILE_RE.test(file) && !RESERVED_SAMPLE_FILE_RE.test(file));
  } catch {
    return false;
  }
}

export function findProjectSamplesFile(dir: string): string | null {
  for (const name of PROJECT_SAMPLE_FILENAMES) {
    const candidate = join(dir, name);
    if (isExistingFile(candidate)) return candidate;
  }
  return null;
}

export function skillLocalSamplesDir(skillRoot: string): string {
  return join(skillRoot, '.omk');
}

export function defaultSkillLocalSamplesFile(skillRoot: string): string {
  return join(skillLocalSamplesDir(skillRoot), SKILL_LOCAL_SAMPLE_FILENAMES[0]);
}

export function hasUsableSamplesPath(path: string): boolean {
  if (isExistingFile(path)) return true;
  return hasLoadableSampleFile(path);
}

export function findSkillLocalSamplesDir(skillRoot: string): string | null {
  const dir = skillLocalSamplesDir(skillRoot);
  return hasLoadableSampleFile(dir) ? dir : null;
}

export function findSkillSamplesPath(skillRoot: string): string | null {
  return findSkillLocalSamplesDir(skillRoot);
}

export function findDeprecatedSkillSamplesHint(skillRoot: string): DeprecatedSkillSamplesHint | null {
  if (!isDirectorySkillRoot(skillRoot)) return null;
  for (const name of PROJECT_SAMPLE_FILENAMES) {
    const oldPath = join(skillRoot, name);
    if (isExistingFile(oldPath)) {
      return { oldPath, newPath: defaultSkillLocalSamplesFile(skillRoot) };
    }
  }
  return null;
}

export function findFlatSkillSamplesPath(skillDir: string, skillName: string): string | null {
  for (const ext of ['json', 'yaml', 'yml'] as const) {
    const candidate = join(skillDir, `${skillName}.eval-samples.${ext}`);
    if (isExistingFile(candidate)) return candidate;
  }
  return null;
}

export function defaultFlatSkillSamplesFile(skillDir: string, skillName: string): string {
  return join(skillDir, `${skillName}.eval-samples.json`);
}

export function isDirectorySkillRoot(path: string): boolean {
  return isExistingDirectory(path) && isExistingFile(join(path, 'SKILL.md'));
}

export function findNamedSkillSamplesPath(skillDir: string, skillName: string): string | null {
  const flatSkillPath = join(skillDir, `${skillName}.md`);
  if (isExistingFile(flatSkillPath)) {
    return findFlatSkillSamplesPath(skillDir, skillName);
  }

  const dirSkillRoot = join(skillDir, skillName);
  if (isDirectorySkillRoot(dirSkillRoot)) {
    return findSkillSamplesPath(dirSkillRoot);
  }
  return null;
}

function findSamplesForExistingSkillPath(path: string): string | null {
  if (isExistingDirectory(path)) {
    return findSkillSamplesPath(path);
  }

  const parent = dirname(path);
  if (basename(path) === 'SKILL.md') {
    return findSkillSamplesPath(parent);
  }
  if (/\.md$/i.test(path)) {
    const skillName = basename(path).replace(/\.md$/i, '');
    return findFlatSkillSamplesPath(parent, skillName);
  }
  return findProjectSamplesFile(parent);
}

function findDeprecatedSamplesForExistingSkillPath(path: string): DeprecatedSkillSamplesHint | null {
  if (isExistingDirectory(path)) {
    return findDeprecatedSkillSamplesHint(path);
  }

  if (basename(path) === 'SKILL.md') {
    return findDeprecatedSkillSamplesHint(dirname(path));
  }
  return null;
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

export function findSingleTreatmentDeprecatedSamplesHint(
  treatmentExpr: string,
  skillDir: string,
  cwd: string = process.cwd(),
): DeprecatedSkillSamplesHint | null {
  const resolved = resolve(cwd, treatmentExpr);
  if (existsSync(resolved)) {
    return findDeprecatedSamplesForExistingSkillPath(resolved);
  }

  const flatSkillPath = join(skillDir, `${treatmentExpr}.md`);
  if (isExistingFile(flatSkillPath)) return null;

  return findDeprecatedSkillSamplesHint(join(skillDir, treatmentExpr));
}

function projectSampleSearchDirs(target: string | null, cwd: string): string[] {
  const dirs: string[] = [];
  const add = (dir: string): void => {
    const abs = resolve(dir);
    if (!dirs.includes(abs)) dirs.push(abs);
  };

  if (target) {
    const absTarget = resolve(target);
    if (existsSync(absTarget)) {
      if (isExistingDirectory(absTarget)) {
        if (isDirectorySkillRoot(absTarget)) {
          add(dirname(dirname(absTarget)));
        } else {
          add(absTarget);
          add(dirname(absTarget));
          add(dirname(dirname(absTarget)));
        }
      } else {
        const parent = dirname(absTarget);
        if (basename(absTarget) === 'SKILL.md') {
          add(dirname(dirname(parent)));
        } else {
          add(parent);
          add(dirname(parent));
        }
      }
    }
  }
  add(cwd);
  return dirs;
}

export function findDoctorSamplesPath(target: string | null, cwd: string): string | null {
  if (target) {
    const absTarget = resolve(target);
    if (existsSync(absTarget)) {
      const targetSamples = findSamplesForExistingSkillPath(absTarget);
      if (targetSamples) return targetSamples;
    }
  }

  for (const dir of projectSampleSearchDirs(target, cwd)) {
    const samplesPath = findProjectSamplesFile(dir);
    if (samplesPath) return samplesPath;
  }
  return null;
}

export function findDoctorDeprecatedSamplesHint(target: string | null, cwd: string): DeprecatedSkillSamplesHint | null {
  if (!target) return null;
  const absTarget = resolve(cwd, target);
  if (!existsSync(absTarget)) return null;
  return findDeprecatedSamplesForExistingSkillPath(absTarget);
}
