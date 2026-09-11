import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSkillSamples, generateSkillSamples } from '../../src/knowledge-artifacts/authoring/sample-generation.js';
import { createEvalSampleSetDocument } from '../../src/eval-workflows/inputs/schemas/sample-set.js';

const sample = { sample_id: 'new', prompt: 'Check the input' };
const serialized = (id: string) => JSON.stringify(createEvalSampleSetDocument([{ ...sample, sample_id: id }]));

describe('宿主无关的样本生成与保存用例', () => {
  let root: string;
  let skillPath: string;
  let samplesPath: string;
  const options = { model: 'fixture', executorName: 'fixture', count: 1, focus: 'failure', noMock: true };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omk-generation-use-case-'));
    skillPath = join(root, 'SKILL.md');
    samplesPath = join(root, '.omk', 'eval-samples.json');
    writeFileSync(skillPath, '# Skill\nPreserve these bytes.\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('保留生成输入，创建版本化样本并返回结构化结果', async () => {
    const generate = vi.fn(async () => ({ samples: [sample], costUSD: 0.25 }));
    const result = await generateSkillSamples({ skillPath, samplesPath, options }, generate);
    expect(generate).toHaveBeenCalledWith({ ...options, skillContent: '# Skill\nPreserve these bytes.\n' });
    expect(result).toEqual({ outputPath: samplesPath, added: 1, total: 1, costUSD: 0.25, appended: false });
    expect(JSON.parse(readFileSync(samplesPath, 'utf8'))).toEqual(createEvalSampleSetDocument([sample]));
  });

  it('生成前拒绝已有文件，不调用模型', async () => {
    writeFileSync(samplesPath = join(root, 'eval-samples.json'), serialized('old'));
    const generate = vi.fn();
    await expect(generateSkillSamples({ skillPath, samplesPath, options }, generate)).rejects.toMatchObject({ reason: 'exists' });
    expect(generate).not.toHaveBeenCalled();
  });

  it('目录追加保留软链，并避开其他分片的样本 ID', async () => {
    const shared = join(root, 'shared.json');
    const directory = join(root, 'samples.v2');
    mkdirSync(directory);
    writeFileSync(shared, serialized('old'));
    writeFileSync(join(directory, 'other.json'), serialized('new'));
    const alias = join(directory, 'eval-samples.json');
    symlinkSync(shared, alias);
    const generate = vi.fn(async () => ({ samples: [sample], costUSD: 0 }));
    await generateSkillSamples({ skillPath, samplesPath: directory, options, append: true }, generate);
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(shared, 'utf8')).samples.map((s: { sample_id: string }) => s.sample_id)).toEqual(['old', 'new-2']);
  });

  it('生成期间出现目标文件时保留外部内容', async () => {
    samplesPath = join(root, 'eval-samples.json');
    const generate = vi.fn(async () => {
      writeFileSync(samplesPath, serialized('external'));
      return { samples: [sample], costUSD: 0 };
    });
    await expect(generateSkillSamples({ skillPath, samplesPath, options }, generate)).rejects.toThrow();
    expect(readFileSync(samplesPath, 'utf8')).toBe(serialized('external'));
  });

  it.each(['before', 'after'])('取消发生在生成%s时均不写文件', async (when) => {
    const controller = new AbortController();
    if (when === 'before') controller.abort();
    const generate = vi.fn(async () => {
      controller.abort();
      return { samples: [sample], costUSD: 0 };
    });
    await expect(generateSkillSamples({ skillPath, samplesPath, options: { ...options, signal: controller.signal } }, generate)).rejects.toThrow();
    expect(generate).toHaveBeenCalledTimes(when === 'before' ? 0 : 1);
    expect(existsSync(samplesPath)).toBe(false);
  });

  it.each([true, false])('有效样本直接复用，不生成也不重写（explicit=%s）', async (explicit) => {
    samplesPath = join(root, 'eval-samples.json');
    writeFileSync(samplesPath, serialized('old'));
    const generate = vi.fn();
    expect(await ensureSkillSamples({ skillPath, samplesPath, options, explicit }, generate)).toEqual({ status: 'existing' });
    expect(generate).not.toHaveBeenCalled();
    expect(readFileSync(samplesPath, 'utf8')).toBe(serialized('old'));
  });

  it.each(['missing', 'broken', 'empty'])('显式样本%s时不自动生成', async (state) => {
    samplesPath = join(root, 'eval-samples.json');
    const content = state === 'broken' ? '{broken' : JSON.stringify(createEvalSampleSetDocument([]));
    if (state !== 'missing') writeFileSync(samplesPath, content);
    const generate = vi.fn();
    await expect(ensureSkillSamples({ skillPath, samplesPath, options, explicit: true }, generate)).rejects.toThrow();
    expect(generate).not.toHaveBeenCalled();
    if (state !== 'missing') expect(readFileSync(samplesPath, 'utf8')).toBe(content);
  });

  it('仅缺失的隐式样本允许生成，空结果不得落盘', async () => {
    const generate = vi.fn(async () => ({ samples: [], costUSD: 0 }));
    await expect(ensureSkillSamples({ skillPath, samplesPath, options, explicit: false }, generate)).rejects.toMatchObject({ reason: 'generated-empty' });
    expect(existsSync(samplesPath)).toBe(false);
  });

  it('自动生成复用相同保存用例并向宿主报告实际路径', async () => {
    const onGenerating = vi.fn();
    const generate = vi.fn(async () => ({ samples: [sample], costUSD: 0 }));
    const result = await ensureSkillSamples({ skillPath, samplesPath, options, explicit: false, onGenerating }, generate);
    expect(result).toMatchObject({ status: 'generated', outputPath: samplesPath, added: 1 });
    expect(onGenerating).toHaveBeenCalledWith(samplesPath);
    expect(JSON.parse(readFileSync(samplesPath, 'utf8')).samples).toEqual([sample]);
  });
});
