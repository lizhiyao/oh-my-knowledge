import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalKnowledgeApplication } from '../../../src/observability/application.js';
import { executeArtifactAuthoring } from '../../../src/studio/application/knowledge/artifact-authoring.js';
import { CarrierLibrary } from '../../../src/knowledge-artifacts/authoring/library.js';
import type { CarrierDetail, CarrierDraft } from '../../../src/studio/view-models/knowledge/artifact-authoring.js';
import { modelProposal } from '../../knowledge/fixtures.js';
import yaml from 'js-yaml';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'omk-carrier-')); roots.push(root);
  const workspace = join(root, 'knowledge');
  const source = join(root, 'trace.jsonl');
  writeFileSync(source, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Alpha 使用 Beta' }] } }));
  const app = createLocalKnowledgeApplication(workspace);
  const snapshot = app.capture({ path: source });
  const run = await app.generate(snapshot.snapshotId, { executor: 'fixture', model: 'fixture', async generate(_system, input) {
    const ref = JSON.parse(input).excerpts.find((entry: { text: string }) => entry.text === 'Alpha 使用 Beta').evidenceRef;
    return { output: JSON.stringify({ proposals: [JSON.parse(JSON.stringify(modelProposal()).replaceAll('record-1', ref))] }), durationMs: 1 };
  } });
  expect(run).toMatchObject({ status: 'completed', rejections: [], committed: [expect.any(Object)] });
  const entry = run.committed[0];
  const execute = (fields: Record<string, unknown>) => executeArtifactAuthoring({ workspace, ...fields }, 'zh');
  const preview = (fields: Record<string, unknown> = {}) => execute({ operation: 'preview', source: { sourceKind: 'new' }, artifactKind: 'skill', name: '工具使用', ids: [entry.knowledgeId], ...fields }) as CarrierDraft;
  const save = (draft: CarrierDraft, content = draft.content) => execute({ operation: 'save', artifactId: draft.artifactId, source: draft.source, artifactKind: draft.artifactKind, name: draft.name, directoryName: draft.directoryName, baselineRevisionId: draft.baselineRevisionId, baselineHash: draft.baselineHash, content, selectedRefs: draft.selectedRefs, tagSelections: draft.tagSelections }) as CarrierDetail;
  const retain = () => { const current = app.detail(entry.knowledgeId); app.maintain(entry.knowledgeId, current.revision.revisionId, 'retain', '核对后维护', current.history.generation); };
  return { root, workspace, app, entry, snapshot, execute, preview, save, retain };
}

describe('reviewed knowledge carrier authoring', () => {
  it('exports tag/property snapshots, rejects changed tags, and updates metadata without duplicating knowledge', async () => {
    const s = await setup(); s.retain();
    s.app.tag(s.entry.knowledgeId, 0, ['排障/证据判断', 'Taro']);
    const header = (content: string) => yaml.load(content.match(/^---\n([\s\S]*?)\n---/)![1]) as Record<string, unknown>;
    const draft = s.preview({ artifactKind: 'prompt' });
    expect(header(draft.content)).toMatchObject({ tags: ['排障/证据判断', 'Taro'], knowledge_types: ['fact'], evidence_bases: ['inference'], verification_status: 'not_assessed', knowledge_revisions: [`${s.entry.knowledgeId}/${s.entry.revisionId}`] });
    s.app.tag(s.entry.knowledgeId, 1, ['排障']);
    expect(() => s.save(draft)).toThrow('conflict');
    const first = s.save(s.preview({ artifactKind: 'prompt' }));
    s.app.tag(s.entry.knowledgeId, 2, []);
    const update = s.preview({ source: { sourceKind: 'library', artifactId: first.artifactId }, artifactKind: 'prompt' });
    expect(header(update.content).tags).toEqual([]);
    expect(update.content.match(/### 项目 Alpha 使用工具 Beta/g)).toHaveLength(1);
    const second = s.save(update);
    expect(s.execute({ operation: 'show', id: first.artifactId, version: 1 })).toMatchObject({ content: first.content });
    expect(second.knowledgeRefs).toEqual(first.knowledgeRefs);
    const skill = header(s.preview().content);
    expect(skill.metadata).toMatchObject({ omk_tags: '[]', omk_knowledge_types: '["fact"]', omk_verification_status: 'not_assessed' });
    expect(Object.values(skill.metadata as object).every(value => typeof value === 'string')).toBe(true);
  });
  it('preserves imported custom properties and body bytes while validating malformed property headers', async () => {
    const s = await setup(); s.retain(); s.app.tag(s.entry.knowledgeId, 0, ['new']);
    const local = join(s.root, 'prompt.md');
    writeFileSync(local, '---\ntags:\n  - existing\ncustom: "kept"\n---\n\nOriginal body  \n\n');
    const fields = { artifactKind: 'prompt', source: { sourceKind: 'local', path: local } };
    const draft = s.preview(fields);
    const metadata = yaml.load(draft.content.match(/^---\n([\s\S]*?)\n---/)![1]) as Record<string, unknown>;
    expect(metadata).toMatchObject({ tags: ['existing', 'new'], custom: 'kept' });
    expect(draft.content).toContain('\n\nOriginal body  \n\n');
    expect(readFileSync(local, 'utf8')).not.toContain('omk_schema');
    for (const invalid of ['tags: [unfinished', 'tags: single-value', 'tags: [123]']) {
      writeFileSync(local, `---\n${invalid}\n---\nBody`);
      expect(() => s.preview(fields)).toThrow('carrier_invalid_metadata');
    }
  });
  it('requires retained current revisions; rendering preserves conditions, uncertainty and source identity', async () => {
    const s = await setup();
    expect(() => s.preview()).toThrow('conflict');
    s.retain();
    const draft = s.preview();
    expect(draft.content).toContain('未记录版本');
    expect(draft.content).toContain('未来适用范围尚未验证');
    expect(draft.content).toContain('背景');
    expect(draft.content).toContain('推断');
    expect(draft.content).toContain('Alpha 使用 Beta');
    expect(draft.content).toContain(s.entry.revisionId);
    expect(draft.content).toContain(s.snapshot.snapshotId);
    expect(draft.content).toContain('保留表示愿意维护，不代表已证实');
    const edited = `${draft.content}\n `;
    const saved = s.save(draft, edited);
    expect(readFileSync(saved.locator, 'utf8')).toBe(edited);
    expect(saved.knowledgeRefs).toEqual(draft.selectedRefs);
    expect(saved.locator).toContain(`/${draft.directoryName}/SKILL.md`);
    expect(saved.content).toContain(`name: \"${draft.directoryName}\"`);
    expect(() => s.save(s.preview(), 'invalid skill')).toThrow('carrier_invalid_skill');
    expect(s.execute({ operation: 'list' })).toMatchObject([{ artifactId: saved.artifactId, version: 1, drifted: false }]);
    expect(() => s.save(draft)).toThrow('conflict');
  });
  it('saves prompt versions without duplicating previously incorporated revisions or losing original content', async () => {
    const s = await setup(); s.retain();
    const first = s.save(s.preview({ artifactKind: 'prompt' }));
    const update = s.preview({ source: { sourceKind: 'library', artifactId: first.artifactId }, artifactKind: 'prompt' });
    expect(update.content).toBe(first.content);
    const next = s.save(update);
    expect(next.contentHash).toBe(first.contentHash);
    expect(next.version).toBe(2);
    expect(next.baseline?.revisionId).toBe(first.revisionId);
    expect(next.knowledgeRefs).toEqual(first.knowledgeRefs);
    expect(s.execute({ operation: 'show', id: first.artifactId, version: 1 })).toMatchObject({ content: first.content, contentHash: first.contentHash });
    expect(() => s.save(update)).toThrow('conflict');
  });
  it('preserves local skill assets in managed versions and rejects changes to either the baseline or knowledge', async () => {
    const s = await setup(); s.retain();
    const local = join(s.root, 'original'); mkdirSync(local); mkdirSync(join(local, 'references'));
    writeFileSync(join(local, 'SKILL.md'), '---\nname: old\ndescription: local\n---\n\nOriginal instructions\n');
    writeFileSync(join(local, 'references', 'guide.md'), 'Original asset');
    writeFileSync(join(s.workspace, 'SKILL.md'), '---\nname: nested\ndescription: nested source\n---\n');
    expect(() => s.preview({ source: { sourceKind: 'local', path: join(s.workspace, 'SKILL.md') } })).toThrow('source_contains_destination');
    const fields = { source: { sourceKind: 'local', path: join(local, 'SKILL.md') } };
    const draft = s.preview(fields);
    writeFileSync(join(local, 'references', 'guide.md'), 'Changed asset');
    expect(() => s.save(draft)).toThrow('conflict');
    const fresh = s.preview(fields);
    const result = s.save(fresh);
    expect(readFileSync(join(local, 'SKILL.md'), 'utf8')).not.toContain('知识');
    expect(readFileSync(join(result.locator, '..', 'references', 'guide.md'), 'utf8')).toBe('Changed asset');
    const stale = s.preview();
    const current = s.app.detail(s.entry.knowledgeId); s.app.maintain(s.entry.knowledgeId, current.revision.revisionId, 'discard', '暂不采用', current.history.generation);
    expect(() => s.save(stale)).toThrow('conflict');
  });
  it('reports unavailable evidence, detects external drift and refuses symlink redirects', async () => {
    const s = await setup(); s.retain(); s.app.deleteSource(s.snapshot.snapshotId);
    const draft = s.preview(); expect(draft.content).toContain('来源不可用');
    const saved = s.save(draft); writeFileSync(saved.locator, 'externally edited');
    expect(new CarrierLibrary(s.workspace).show(saved.artifactId).drifted).toBe(true);
    expect(() => s.preview({ source: { sourceKind: 'library', artifactId: saved.artifactId } })).toThrow('conflict');
    const redirected = join(s.root, 'redirected'); mkdirSync(redirected); symlinkSync(s.root, join(redirected, 'artifacts'));
    expect(() => new CarrierLibrary(redirected).list()).toThrow('invalid_directory');
    const container = join(s.workspace, 'artifacts', saved.artifactId, 'v1', 'content');
    const moved = join(s.root, 'moved-content'); renameSync(container, moved); symlinkSync(moved, container);
    expect(() => new CarrierLibrary(s.workspace).show(saved.artifactId)).toThrow('invalid_directory');
  });
  it('recovers a dead local writer and removes its unpublished staging before the next save', async () => {
    const s = await setup(); s.retain(); const first = s.save(s.preview());
    const folder = join(s.workspace, 'artifacts', first.artifactId);
    const dead = spawnSync(process.execPath, ['-e', ''], { cwd: s.root });
    expect(dead.status).toBe(0);
    const lock = join(folder, 'write.lock');
    writeFileSync(lock, JSON.stringify({ owner: randomUUID(), pid: dead.pid, hostname: hostname(), acquiredAt: new Date(0).toISOString() }));
    utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    mkdirSync(join(folder, '.staging-aborted')); writeFileSync(join(folder, '.staging-aborted', 'partial'), 'unfinished');
    const update = s.preview({ source: { sourceKind: 'library', artifactId: first.artifactId }, ids: [] });
    expect(s.save(update).version).toBe(2);
    expect(readdirSync(folder)).toEqual(['v1', 'v2']);
  });
  it('retains case and method roles, and preserves original whitespace when appending', async () => {
    for (const knowledgeKind of ['case', 'method'] as const) {
      const s = await setup();
      const current = s.app.detail(s.entry.knowledgeId);
      const { title, content, entities, evidence } = current.revision;
      const statementId = content.statements[0].statementId;
      const organization = knowledgeKind === 'case'
        ? { knowledgeKind, situation: '明确场景', actionStatementIds: [statementId], outcomeStatementIds: [], gaps: ['尚无结果依据'] }
        : { knowledgeKind, purpose: '明确目的', instructionStatementIds: [statementId] };
      s.app.revise(s.entry.knowledgeId, current.revision.revisionId, current.history.generation, { title, content: { ...content, organization }, entities, evidence }, '澄清组织形式');
      s.retain();
      const local = join(s.root, 'prompt.txt'); const original = 'Original instructions  \n\n'; writeFileSync(local, original);
      const draft = s.preview({ artifactKind: 'prompt', source: { sourceKind: 'local', path: local } });
      expect(draft.content.slice(draft.content.indexOf('\n---\n') + 5)).toContain(original);
      expect(draft.content).toContain(knowledgeKind === 'case' ? '行动' : '方法步骤');
      expect(draft.content).toContain(knowledgeKind === 'case' ? '尚无结果依据' : '明确目的');
      expect(s.save(draft).knowledgeRefs).toHaveLength(1);
    }
  });
  it('cleans staging and locks on cancelled publication, leaving the previous version readable', async () => {
    const s = await setup(); s.retain(); const first = s.save(s.preview());
    const draft = s.preview({ source: { sourceKind: 'library', artifactId: first.artifactId }, ids: [] });
    const controller = new AbortController();
    expect(() => new CarrierLibrary(s.workspace).save(draft, controller.signal, () => controller.abort())).toThrow();
    expect(readdirSync(join(s.workspace, 'artifacts', first.artifactId))).toEqual(['v1']);
    expect(new CarrierLibrary(s.workspace).show(first.artifactId).content).toBe(first.content);
    const oversized = { ...draft, artifactId: randomUUID(), source: { sourceKind: 'new' as const }, content: '中'.repeat(1024 * 1024) };
    expect(() => new CarrierLibrary(s.workspace).save(oversized)).toThrow('capacity');

  });
});
