/**
 * skill-index 缓存 — 覆盖两轮 PR #95 review feedback:
 *
 *   review P2-4 (cache 引入本身):buildSkillIndex 跨调用缓存 SkillIndex result,
 *     fingerprint = reports id+timestamp 拼接 + doctorsDir / analysesDir 各自
 *     的 dir-content fingerprint。命中同 fingerprint 时复用对象引用,变了重 build。
 *
 *   review P2-a (2026-05-11 顶部 issue-comment 第二条 🟡 — fingerprint 漏 same-
 *     name report in-place content rewrite 的 invalidate 信号):pre-fix 时
 *     fingerprint 的 dir 段只 hash 目录本身的 mtime 跟 report 文件数两个量,
 *     Unix 目录的 mtime 只随**目录项**(filename 级别的 add / rm / rename)
 *     操作变,**同名 file 内容被外部 process 原地覆写**时目录 mtime 不动文件数
 *     也不动,fingerprint 字符串不变 cache 命中老 SkillIndex,Studio 端拿到
 *     stale 数据。fix 是把 fingerprint 升级为 content-aware 形态——dir 段含
 *     该 dir 下每个 .report.json 文件的 "filename:mtimeMs:size" 三元组(filename 排
 *     序),仿 src/server/report-store.ts:80-92 的 computeListFingerprint 那一
 *     侧的 pattern,这样"目录内某文件 mtime / size 变" 这种"内容被覆写"信号
 *     也会让 fingerprint 字符串变,cache miss 触发重新 build。
 *
 * 测试矩阵(7 个 case,前 3 个是 P2-4 cache-init 既有契约,后 4 个 case 4-7 是
 * P2-a fix 的新契约和 cross-dir 反向 case):
 *   case 1:reports 不变 + dirs 不变 → cache 命中,两次 build 是同一对象引用
 *   case 2:reports 数组变化(新 ReportDocument 加入) → fingerprint 变 invalidate
 *          (既有的 reportIds 拼接段)
 *   case 3:`_resetSkillIndexCache()` 显式 reset → 下一次 build 强制重算
 *   case 4 (P2-a 核心):analysesDir 里 same-name analysis JSON 内容被 in-place
 *          `writeFileSync` 覆写之后(显式 `utimesSync` 让 file mtime 推进一秒
 *          以避开 wall-clock granularity 导致 mtime 撞同毫秒的偶发,加上写入
 *          内容字节长度变让 size 也变作为 hedge),没动 dirent 没增减文件名,
 *          按 pre-fix 的"目录 mtime + 文件数"fingerprint 会撞回旧 hash, cache
 *          命中错串(reviewer 本地复现"toolFailureRate 0 → 0.9 二次 build 返
 *          回 same object reference, 仍是 stale 旧值")。fix 之后 fingerprint
 *          含 per-file mtimeMs+size 三元组,文件 mtime+size 变,字符串不一样,
 *          cache miss 重新 build, idx2 跟 idx1 不是同一引用。这条 case 是
 *          fix-the-cause-not-the-symptom 的核心 invariant 锁定。
 *   case 5 (P2-a 对称):doctorsDir 一侧同样的"same-name doctor report JSON 内
 *          容被原地覆写,fingerprint 必须 invalidate" 对称契约,确保 fix 的
 *          new helper safeDirJsonContentFingerprint 对 doctors 跟 analyses
 *          两个 dir 都成立而不是只对 observability 一侧打补丁。
 *   case 6 (P2-a 反向):analysesDir 跟 doctorsDir 是两个不同目录路径时,即便
 *          reports 完全相同,fingerprint 不应该 collide cache 命中错串。原来
 *          的 fingerprint key 把"哪个 dir 路径"信息隐藏在 dir mtime 跟 file
 *          count 里(两个不同 tmp dir 的 mtime 是创建时的 wall clock 通常
 *          各异,文件数都是 0 这点撞,但 dir-mtime 各异 OK),新 fingerprint
 *          继承这一点(两个空 dir 的 dir mtime 不同, fingerprint 段不同),
 *          这条 case 显式 lock-in"cross-dir non-collision"避免未来 fingerprint
 *          重构时把"哪个 dir"维度丢失而出现"两套 reports/dirs combinations
 *          fingerprint 字符串撞 hash 互相 cache hit"那种 regression。
 *   case 7 (P2-a 文件**移除**):existing 文件被 unlink 之后,sorted filename
 *          list 会少一项, 字符串变, fingerprint 变, cache invalidate。这条
 *          是 case 2 的文件系统侧 mirror —— case 2 测的是 reports 数组维度
 *          的变化,case 7 测的是 dir-contents 维度上的"删除"变化(case 4/5
 *          覆盖了"内容覆写"变化,case 7 覆盖"删除"变化,case 2 之前的旧
 *          fingerprint 也 cover 了"加新文件" 因为 fileCount 字段变 — 那个旧
 *          信号在 fix 后通过新 fingerprint 的"sorted filename list 多一项"
 *          自然覆盖,不必单测)。
 *
 * 实现引用:reviewer 在 5/11 comment 末尾的"补两类单测"列了 (a) 同 reports
 * 不同 dirs 不串 fingerprint (本 case 6) 跟 (b) 同名 JSON 内容更新后
 * fingerprint 不同 invalidate 旧 cache (本 case 4 跟 case 5 doctors-analyses
 * 两侧对称)。case 7 是 file-removal 信号的对称完整性补充, 是 fix-author
 * 主动覆盖完整 dir-content-fingerprint-invariant-matrix 的额外 invariant,
 * 不在 reviewer 字面要求里但保持 cache 失效契约的 closure 干净。
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillIndex, _resetSkillIndexCache } from '../../src/server/skill-index.js';
import { reportFileName } from '../../src/eval-core/artifact-file-names.js';
import type { EvaluationReport } from '../../src/types/index.js';

function mkReport(id: string, ts: string, variant: string): EvaluationReport {
  return {
    kind: 'evaluation',
    id,
    meta: {
      variants: ['baseline', variant],
      model: 'sonnet',
      executor: 'claude',
      sampleCount: 1,
      taskCount: 1,
      totalCostUSD: 0,
      timestamp: ts,
      cliVersion: '0.0.0-test',
      nodeVersion: process.version,
      artifactHashes: {},
      judgeModels: [],
    },
    summary: { [variant]: { totalSamples: 1, successCount: 1, errorCount: 0, avgCompositeScore: 4.0 } },
    results: [{ sample_id: 's001', variants: { [variant]: { ok: true } } }],
  } as unknown as EvaluationReport;
}

/**
 * 写一份 SkillHealthReport-shape 的 analysis JSON 到 path,然后显式 utimes 把
 * 文件 mtime 设到 `mtimeIso` 那一刻(确定性,避开两次连续 writeFileSync 之间的
 * wall-clock granularity 偶尔撞同 ms 让测试 flaky)。 内容字段是"reviewer 复现
 * 描述里 toolFailureRate 0 → 0.9 那种"observability-side gap-rate 风格的
 * minimal JSON shape,只保证是合法 JSON 即可;skill-index 解析这种 file 时如
 * 果 schema-mismatch 会按 missing observe snapshot 处理,不影响 fingerprint
 * cache 失效契约本身的测试逻辑(fingerprint 只看 file 的 mtime+size 不看内容
 * schema,跟下游 parser 是不是认这个 schema 是 orthogonal 的两件事)。
 */
function writeAnalysisJson(path: string, gapRate: number, healthBand: string, mtimeIso: string): void {
  const payload = {
    schemaVersion: 1,
    generatedAt: mtimeIso,
    bySkill: {
      'test-skill': {
        healthBand,
        failureRate: gapRate,
        segmentCount: 1,
        weightedGapRate: gapRate,
      },
    },
  };
  writeFileSync(path, JSON.stringify(payload), 'utf-8');
  const t = new Date(mtimeIso);
  utimesSync(path, t, t);
}

/** doctor-side mirror — write 一份 DoctorReport-shape JSON 加显式 utimes。同
 *  样,fingerprint 只看 file mtime+size 不看 schema,即使写的不是完整 DoctorReport
 *  也不影响 fingerprint invalidate 契约的验证。*/
function writeDoctorJson(path: string, runId: string, skillsCount: number, mtimeIso: string): void {
  const payload = {
    schemaVersion: '1.0.0',
    runId,
    startedAt: mtimeIso,
    finishedAt: mtimeIso,
    skills: Array.from({ length: skillsCount }, (_, i) => ({
      skillName: `skill-${i}`,
      status: 'pass',
      passCount: 1,
      warnCount: 0,
      failCount: 0,
    })),
    rules: [],
    summary: { totalSkills: skillsCount, passCount: skillsCount, warnCount: 0, failCount: 0 },
  };
  writeFileSync(path, JSON.stringify(payload), 'utf-8');
  const t = new Date(mtimeIso);
  utimesSync(path, t, t);
}

describe('buildSkillIndex 模块级缓存', () => {
  const cleanupDirs: string[] = [];
  let analysesDir: string;
  let doctorsDir: string;

  let origIndexEnv: string | undefined;

  beforeEach(() => {
    _resetSkillIndexCache();
    analysesDir = mkdtempSync(join(tmpdir(), 'omk-analyses-'));
    doctorsDir = mkdtempSync(join(tmpdir(), 'omk-doctors-'));
    // buildSkillIndex 现在会合并机器级 doctor/observe 卡片(listDoctorCards/listObserveCards);把卡片索引
    // 指到本测独占的空临时目录,隔离别的测试(persistDoctor/Observe)写进套件级索引的卡片,保证 entries 计数纯净。
    origIndexEnv = process.env.OMK_ARTIFACT_INDEX_DIR;
    const idxDir = mkdtempSync(join(tmpdir(), 'omk-skidx-cards-'));
    process.env.OMK_ARTIFACT_INDEX_DIR = idxDir;
    cleanupDirs.push(analysesDir, doctorsDir, idxDir);
  });

  afterEach(() => {
    if (origIndexEnv === undefined) delete process.env.OMK_ARTIFACT_INDEX_DIR;
    else process.env.OMK_ARTIFACT_INDEX_DIR = origIndexEnv;
    for (const d of cleanupDirs.splice(0)) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
    }
  });

  it('case 1 (既有 P2-4 contract):reports 不变 + 两个 dir 内容均不变 → cache hit 返回同一 SkillIndex 对象引用', () => {
    const reports = [mkReport('r1', '2026-05-11T00:00:00Z', 'foo')];
    const idx1 = buildSkillIndex(reports, analysesDir, doctorsDir);
    const idx2 = buildSkillIndex(reports, analysesDir, doctorsDir);
    assert.equal(idx2, idx1, 'unchanged input → same object reference (cache hit)');
  });

  it('case 2 (既有 P2-4 contract):reports 数组增加一条 → fingerprint 的 reportIds 段变 → cache miss 重 build 新对象引用', () => {
    const r1 = mkReport('r1', '2026-05-11T00:00:00Z', 'foo');
    const r2 = mkReport('r2', '2026-05-11T01:00:00Z', 'bar');
    const idx1 = buildSkillIndex([r1], analysesDir, doctorsDir);
    const idx2 = buildSkillIndex([r1, r2], analysesDir, doctorsDir);
    assert.notEqual(idx2, idx1, 'new report added → fingerprint differs → cache miss');
    assert.equal(idx2.entries.length, 2, 'rebuilt index sees both skills foo+bar');
  });

  it('case 3 (既有 P2-4 contract):`_resetSkillIndexCache()` 调用之后下一次 buildSkillIndex 强制重算', () => {
    const reports = [mkReport('r1', '2026-05-11T00:00:00Z', 'foo')];
    const idx1 = buildSkillIndex(reports, analysesDir, doctorsDir);
    _resetSkillIndexCache();
    const idx2 = buildSkillIndex(reports, analysesDir, doctorsDir);
    assert.notEqual(idx2, idx1, 'explicit reset bypasses fingerprint-eq check');
  });

  it('case 4 (P2-a 核心 — analysesDir 里 same-name JSON 内容原地 in-place 覆写之后 fingerprint 必须 invalidate cache):reviewer 5/11 描述的"同份 analysis JSON 把 toolFailureRate 从 0 改成 0.9, server 进程内二次 buildSkillIndex 返回 same object reference 仍是旧值"那条 ship-blocker 锁定', () => {
    const reports = [mkReport('r1', '2026-05-11T00:00:00Z', 'foo')];
    const analysisJsonPath = join(analysesDir, reportFileName('health-2026-05-11'));

    // 第一次写一份 "healthBand: green, failureRate: 0.0" baseline 然后建第一份
    // SkillIndex。`writeAnalysisJson` 内部用 `utimesSync` 显式设 mtime 到给定
    // ISO timestamp 确定性避开两次 write 撞同 wall-clock-ms 的 race。
    writeAnalysisJson(analysisJsonPath, 0.0, 'green', '2026-05-11T00:00:01Z');
    _resetSkillIndexCache();
    const idx1 = buildSkillIndex(reports, analysesDir, doctorsDir);

    // 原地覆写同 filename 的 analysis JSON,内容变成 "healthBand: red,
    // failureRate: 0.95",显式把 mtime 推进一小时让 stat.mtimeMs 跟 stat.size
    // 都跟 baseline 那次的值不同。这一步**不**调 _resetSkillIndexCache —— 测的
    // 是 fingerprint key 本身有没有靠 per-file mtime+size 信号自然 invalidate
    // cache,而不是显式 reset 路径(那是 case 3 测的)。
    writeAnalysisJson(analysisJsonPath, 0.95, 'red', '2026-05-11T01:00:00Z');
    const idx2 = buildSkillIndex(reports, analysesDir, doctorsDir);

    assert.notEqual(idx2, idx1,
      'P2-a: 同名 analysis JSON 内容原地覆写后,fingerprint 必须不一样,'
      + 'cache miss 触发 SkillIndex 重建,不能返回 stale cache 那份旧引用');
  });

  it('case 5 (P2-a 对称 — doctorsDir 一侧的 same-name doctor JSON 原地覆写也必须 invalidate cache,验证新 fingerprint helper 对 doctors 跟 analyses 两个 dir 都生效不是只对一侧打补丁)', () => {
    const reports = [mkReport('r1', '2026-05-11T00:00:00Z', 'foo')];
    const doctorJsonPath = join(doctorsDir, reportFileName('doctor-2026-05-11'));

    writeDoctorJson(doctorJsonPath, 'run-baseline', 1, '2026-05-11T00:00:01Z');
    _resetSkillIndexCache();
    const idx1 = buildSkillIndex(reports, analysesDir, doctorsDir);

    // 原地覆写 doctor report 内容,skills 数组从 1 个 entry 变成 3 个让 byte
    // size 变化,显式 utimes 把 mtime 推进。
    writeDoctorJson(doctorJsonPath, 'run-rewritten', 3, '2026-05-11T02:00:00Z');
    const idx2 = buildSkillIndex(reports, analysesDir, doctorsDir);

    assert.notEqual(idx2, idx1,
      'P2-a 对称:doctor JSON 内容原地覆写 fingerprint 也必须 invalidate cache,'
      + '跟 analyses 一侧用同一个 safeDirJsonContentFingerprint helper 一致行为');
  });

  it('case 6 (P2-a 反向 — cross-dir non-collision:两套不同的 analysesDir / doctorsDir 路径下,即便 reports 数组完全相同 fingerprint key 也得显式区分,不能跨 dir-pair 互相 cache hit 把另一对 dir 的 SkillIndex 错串过来)', () => {
    const reports = [mkReport('r1', '2026-05-11T00:00:00Z', 'foo')];

    // 第一次跑 (analysesDir, doctorsDir) 这一对 dir。两个 dir 内是空的,
    // 但 dir 自己的 mtime 是 mkdtempSync 落地时的 wall-clock 通常是 unique
    // 的,fingerprint 里 dir-mtime 那一段反映这点。
    const idx1 = buildSkillIndex(reports, analysesDir, doctorsDir);

    // 第二次切换到另一对 tmp dir (analysesDir2, doctorsDir2) — mkdtemp 随机
    // suffix 文件名跟 mtime 都各异,fingerprint 里的 d:、o: 两段后缀字符串
    // 都跟第一次不同,cache miss。
    const analysesDir2 = mkdtempSync(join(tmpdir(), 'omk-analyses-other-'));
    const doctorsDir2 = mkdtempSync(join(tmpdir(), 'omk-doctors-other-'));
    cleanupDirs.push(analysesDir2, doctorsDir2);
    const idx2 = buildSkillIndex(reports, analysesDir2, doctorsDir2);

    assert.notEqual(idx2, idx1,
      'reviewer 5/11 字面要求 (a):同 reports 但不同 dirs 路径 fingerprint key '
      + '不应该撞 cache, idx2 必须是一份新构造的 SkillIndex 不是 idx1 的 cache 引用');

    // sanity check — idx1 跟 idx2 内容上的 entries 列表都来自同一份 reports,
    // 跟 dir-state 无关(两个 dir-pair 的 doctors/analyses 都是空,所以 SkillIndex
    // 的 entries 字段差异只在内部 cache 失效之后 buildSkillIndex 内重新算的
    // computed properties 上是不是一致 — 但只锁"对象引用不串"这一条就够 P2-a 的
    // cross-dir invariant,这里不验内容字段)。
    assert.equal(idx1.entries.length, idx2.entries.length, 'same reports → same skill count in both runs');
  });

  it('case 7 (P2-a 完整性补 — file removal 信号:dir 里既有一份 report 文件然后 unlink 之后, sorted filename list 少一项 fingerprint 字符串变 cache invalidate。这是 case 2 的文件系统侧 mirror 对应 dir-contents 维度的"删除"信号,case 4/5 已 cover"覆写"信号,合起来形成完整的 fingerprint-invariant matrix 不漏 file-system-level 任何变化类型)', () => {
    const reports = [mkReport('r1', '2026-05-11T00:00:00Z', 'foo')];
    const ephemeral = join(analysesDir, reportFileName('ephemeral-analysis'));
    writeAnalysisJson(ephemeral, 0.5, 'yellow', '2026-05-11T00:00:01Z');

    _resetSkillIndexCache();
    const idx1 = buildSkillIndex(reports, analysesDir, doctorsDir);

    // 删掉那个 ephemeral 文件 — dir 的 mtime 因为 dirent 表项被 unlink 自动
    // 推进(unlink 是一个目录级的 metadata 修改),sorted filename list 少一项,
    // fingerprint 字符串里 dir-mtime 跟 file-parts 两段都变。
    unlinkSync(ephemeral);

    const idx2 = buildSkillIndex(reports, analysesDir, doctorsDir);

    assert.notEqual(idx2, idx1,
      'file removal in analysesDir → dir mtime updates (dirent change) and sorted '
      + 'filename list shortens → fingerprint string differs → cache must invalidate');
  });
});
