/**
 * `omk init` 起步用例集的双语覆盖完整性。
 *
 * 英文版只翻译文字（题干 + rubric 判据），代码、断言与元数据共用。因此「少一条」不会
 * 报错地生成半中半英的用例集，只会在用户手上表现为中文 rubric。这里按当前样本集反推
 * 应有的键集合，两侧都判：缺键与多余键都算漂移。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import InitCommand from '../../src/cli/commands/init.js';
import { loadSamples } from '../../src/eval-workflows/inputs/load-samples.js';
import { runCommand } from '../helpers/run-command.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface RubricEntry { criterion: string; weight: number }
interface GeneratedSample {
  sampleId: string;
  input: { inputKind: string; text: string };
  evaluationContext: { rubric: Record<string, RubricEntry>; reference: string; assertions: unknown };
  annotations: Record<string, unknown>;
}

// 英文集必须和中文集走同一个 strict-mode 加载器：只比字符串会漏掉「翻译后不再合规」。
async function generate(lang: 'zh' | 'en'): Promise<{ samples: GeneratedSample[] }> {
  const dir = await mkdtemp(join(tmpdir(), `omk-init-samples-${lang}-`));
  try {
    await runCommand(InitCommand, ['project', '--samples', '20', '--lang', lang], {
      cwd: dir,
      env: { OMK_HOME: join(dir, 'machine') },
    });
    const file = join(dir, 'project', 'eval-samples.json');
    assert.ok(existsSync(file), 'init should write eval-samples.json');
    const loaded = loadSamples(file);
    // strict-mode 加载器不合规即抛错；两版都过同一道校验。
    assert.equal(loaded.samples.length, 20);
    return JSON.parse(readFileSync(file, 'utf8')) as { samples: GeneratedSample[] };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('omk init 起步用例集按语言生成', () => {
  it('20 条英文版：题干与全部 rubric 判据都是英文，且不含中文', async () => {
    const doc = await generate('en');
    assert.equal(doc.samples.length, 20);
    for (const sample of doc.samples) {
      assert.match(sample.input.text, /^Review the following code\n\n```/);
      assert.doesNotMatch(sample.input.text, /审查以下代码/);
      const rubric: Record<string, RubricEntry> = sample.evaluationContext.rubric;
      assert.ok(Object.keys(rubric).length > 0, `${sample.sampleId} lost its rubric`);
      for (const entry of Object.values(rubric)) {
        assert.doesNotMatch(entry.criterion, /[\u4e00-\u9fff]/u, `${sample.sampleId}: ${entry.criterion}`);
        assert.notEqual(entry.criterion, '');
      }
    }
  });

  it('中文版保持原样，两版的结构、断言与代码完全一致', async () => {
    const zh = await generate('zh');
    const en = await generate('en');
    assert.equal(zh.samples.length, en.samples.length);
    for (const [index, left] of zh.samples.entries()) {
      const right = en.samples[index];
      assert.equal(left.sampleId, right.sampleId);
      // 只有文字随语言变；被测代码、断言、能力标签与权重两版必须逐字一致。
      assert.equal(left.evaluationContext.reference, right.evaluationContext.reference);
      assert.deepEqual(left.evaluationContext.assertions, right.evaluationContext.assertions);
      assert.deepEqual(left.annotations, right.annotations);
      const dimensions = Object.keys(left.evaluationContext.rubric);
      assert.deepEqual(dimensions.sort(), Object.keys(right.evaluationContext.rubric).sort());
      for (const dimension of dimensions) {
        assert.deepEqual(left.evaluationContext.rubric[dimension].weight, right.evaluationContext.rubric[dimension].weight);
      }
    }
    assert.match(zh.samples[0].input.text, /^审查以下代码\n\n```/);
  });
});
