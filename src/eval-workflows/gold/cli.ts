import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dumpYaml, loadGoldDataset } from './dataset.js';

/** Creates an empty human-gold dataset without coupling it to a report schema. */
export function initGoldDataset(targetDir: string, options: { annotator?: string } = {}): string[] {
  const directory = resolve(targetDir);
  if (existsSync(directory)) {
    const yamlFiles = readdirSync(directory).filter((file) => /\.ya?ml$/.test(file));
    if (yamlFiles.length > 0) {
      throw new Error(`target directory already contains YAML files (${yamlFiles.join(', ')}); use a different directory to avoid overwriting`);
    }
  } else {
    mkdirSync(directory, { recursive: true });
  }
  const metadataPath = join(directory, 'metadata.yaml');
  const annotationsPath = join(directory, 'annotations.yaml');
  const readmePath = join(directory, 'README.md');
  writeFileSync(metadataPath, dumpYaml({
    metadata: {
      annotator: options.annotator ?? 'YOUR-MODEL-OR-TEAM-ID',
      annotatedAt: new Date().toISOString().slice(0, 10),
      version: '0.1',
      scale: { min: 1, max: 5 },
      notes: 'omk gold dataset — 标注者应与评委独立。',
    },
  }));
  writeFileSync(annotationsPath, dumpYaml({
    annotations: [
      { sample_id: 'EXAMPLE_001', score: 4, reason: '示例：替换为真实标注或删除' },
      { sample_id: 'EXAMPLE_002', score: 2 },
    ],
  }));
  if (!existsSync(readmePath)) {
    writeFileSync(readmePath, [
      '# Gold dataset',
      '',
      'OMK 用此目录保存与评委独立的人类锚点评分。',
      '',
      '- `metadata.yaml`：标注者、日期、版本与量程。',
      '- `annotations.yaml`：按 `sample_id` 绑定的评分。',
      '',
      '比较命令只消费 Evaluation Core artifact，不读取旧 evaluation report。',
      '',
    ].join('\n'));
  }
  return [metadataPath, annotationsPath, readmePath];
}

export function validateGoldDataset(dir: string): { ok: boolean; issues: string[]; sampleCount: number } {
  const { dataset, issues } = loadGoldDataset(dir);
  return {
    ok: dataset !== null && issues.length === 0,
    issues: issues.map((issue) => {
      const location = issue.path
        ? ` (${issue.path}${issue.index === undefined ? '' : `:${issue.index}`})`
        : '';
      return `${issue.message}${location}`;
    }),
    sampleCount: dataset?.annotations.length ?? 0,
  };
}
