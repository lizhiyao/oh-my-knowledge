/**
 * 架构边界守门:用静态扫描固化「哪个 layer 可以 import 哪个 layer」。
 *
 * 历史背景:src/ 内层级关系靠 CR 记忆维护,被反向 import 拉穿过多次:
 *   - observability 反向 driving diagnosis(已修)
 *   - types 反向看 eval-core / 业务实现(已修)
 *   - renderer 直接 import observability 内部(已 facade 化)
 * 这个测试把每一条「已修的方向」锁死,新增反向 import 会在 PR 阶段挂掉。
 *
 * 规则形态:每条规则声明 from / to / 可选 whitelist + 注解。匹配 src-relative
 * 路径前缀。静态 import 与 dynamic import('xxx') 都覆盖。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, normalize, sep, dirname } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const SRC_DIR = join(REPO_ROOT, 'src');

interface ForbiddenRule {
  /** 源 layer 前缀(src-relative,以 `/` 结尾的目录或具体文件路径前缀)。 */
  from: string;
  /** 目标 layer 前缀,同上。匹配后即视为违例,除非命中 whitelist。 */
  to: string;
  /** 说明这条规则存在的原因(挂掉时给 reviewer 看)。 */
  reason: string;
  /** 例外白名单。元素格式:`<importer-src-relative>::<resolved-target-src-relative>`。
   *  importer 必须 from 前缀,target 必须 to 前缀,但这一对组合不计为违例。
   *  专用于「P2 待修但 P1.3 不阻塞」的 known-debt。 */
  whitelist?: string[];
}

const RULES: ForbiddenRule[] = [
  {
    from: 'types/',
    to: 'eval-core/',
    reason: 'types/ 是底层契约层,不应反向 import 业务实现 (eval-core)。DTO 应该下沉到 types/。',
    whitelist: [
      // 已在 PR #157 中通过抽 types/dependencies.ts 修复。该 PR 合入后此 whitelist
      // 自动被「dead whitelist」检查标红,提示删除。
      'types/doctor.ts::eval-core/dependency-checker.ts',
    ],
  },
  {
    from: 'types/',
    to: 'eval-workflows/',
    reason: 'types/ 是底层契约层,不应反向 import eval-workflows。',
  },
  {
    from: 'types/',
    to: 'cli/',
    reason: 'types/ 不应反向 import CLI 装配层。',
  },
  {
    from: 'types/',
    to: 'observability/',
    reason: 'types/ 不应反向 import observability。observability schema 应下沉到 types/(已部分完成,见 types/diagnosis.ts)。',
  },
  {
    from: 'types/',
    to: 'diagnosis/',
    reason: 'types/ 不应反向 import diagnosis(已切除,见 types/diagnosis.ts)。',
  },
  {
    from: 'types/',
    to: 'renderer/',
    reason: 'types/ 不应反向 import renderer(视图层)。',
  },
  {
    from: 'types/',
    to: 'server/',
    reason: 'types/ 不应反向 import server。',
  },
  {
    from: 'types/',
    to: 'doctor/',
    reason: 'types/ 不应反向 import doctor 实现层。',
  },
  {
    from: 'types/',
    to: 'grading/',
    reason: 'types/ 不应反向 import grading。',
  },
  {
    from: 'observability/',
    to: 'diagnosis/',
    reason: 'observability 是 diagnosis 的下游消费者,不应反向 driving diagnosis(见 commit 4d38ca6 之前的层级倒置)。如需共用类型,放 src/types/diagnosis.ts。',
  },
  {
    from: 'renderer/',
    to: 'server/',
    reason: 'renderer 是视图层,不应 import server。server 内部类型应抽到 types/ 给两边共享。',
    whitelist: [
      // P2 finding 6:skill-index / skill-insights 的稳定类型待抽到 src/types/skill-index.ts。
      // 抽出来后这 4 条 whitelist 一起删,test 仍然守这条规则。
      'renderer/skill-detail-renderer.ts::server/skill-index.ts',
      'renderer/skill-detail-renderer.ts::server/skill-insights.ts',
      'renderer/skill-list-renderer.ts::server/skill-index.ts',
      'renderer/skill-list-renderer.ts::server/skill-insights.ts',
    ],
  },
  {
    from: 'renderer/',
    to: 'observability/',
    reason: 'renderer 只能通过 facade 访问 observability,不应直接 import observability 内部实现。facade 见 observability/inbox-view-model.ts、observability/feedback-projection.ts、observability/skill-health-analyzer.ts。',
    whitelist: [
      // 三个允许的 facade(以及它们的 .ts 解析后路径)。
      'renderer/observation-inbox-renderer.ts::observability/inbox-view-model.ts',
      'renderer/observation-inbox-renderer.ts::observability/feedback-projection.ts',
      'renderer/skill-health-renderer.ts::observability/skill-health-analyzer.ts',
    ],
  },
];

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const fp = join(dir, entry);
    const st = statSync(fp);
    if (st.isDirectory()) {
      listTsFiles(fp, out);
    } else if (st.isFile() && (entry.endsWith('.ts') || entry.endsWith('.tsx')) && !entry.endsWith('.d.ts')) {
      out.push(fp);
    }
  }
  return out;
}

const IMPORT_RE = /(?:^|\s|;)import\s+(?:type\s+)?(?:[\w*{}\s,]+from\s+)?['"]([^'"]+)['"]/g;
const REEXPORT_RE = /(?:^|\s|;)export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

function extractSpecifiers(content: string): string[] {
  const specs = new Set<string>();
  for (const m of content.matchAll(IMPORT_RE)) specs.add(m[1]);
  for (const m of content.matchAll(REEXPORT_RE)) specs.add(m[1]);
  for (const m of content.matchAll(DYNAMIC_RE)) specs.add(m[1]);
  return [...specs];
}

function resolveSpecifier(importerAbs: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const target = normalize(join(dirname(importerAbs), spec));
  // 把 .js 解析回 .ts(项目用显式 .js 后缀的 ESM)
  return target.replace(/\.js$/, '.ts').replace(/\\/g, '/');
}

function toSrcRelative(absPath: string): string {
  return relative(SRC_DIR, absPath).split(sep).join('/');
}

interface Violation {
  importer: string;
  target: string;
  ruleFrom: string;
  ruleTo: string;
  reason: string;
}

function collectViolations(): Violation[] {
  const files = listTsFiles(SRC_DIR);
  const violations: Violation[] = [];
  for (const file of files) {
    const importerRel = toSrcRelative(file);
    const content = readFileSync(file, 'utf-8');
    const specs = extractSpecifiers(content);
    for (const spec of specs) {
      const resolvedAbs = resolveSpecifier(file, spec);
      if (!resolvedAbs) continue;
      const targetRel = toSrcRelative(resolvedAbs);
      for (const rule of RULES) {
        if (!importerRel.startsWith(rule.from)) continue;
        if (!targetRel.startsWith(rule.to)) continue;
        const whitelistKey = `${importerRel}::${targetRel}`;
        if (rule.whitelist?.includes(whitelistKey)) continue;
        violations.push({
          importer: importerRel,
          target: targetRel,
          ruleFrom: rule.from,
          ruleTo: rule.to,
          reason: rule.reason,
        });
      }
    }
  }
  return violations;
}

describe('架构边界守门', () => {
  it('禁止反向 / 跨层 import(规则集见本文件 RULES)', () => {
    const violations = collectViolations();
    if (violations.length > 0) {
      const lines = violations.map((v) =>
        `  ${v.importer} → ${v.target}\n    规则:${v.ruleFrom} ✗→ ${v.ruleTo}\n    原因:${v.reason}`
      );
      const msg = [
        `发现 ${violations.length} 处 import 违反架构边界:`,
        ...lines,
        '',
        '修复路径:把目标符号挪到 types/(纯类型)或抽 facade(运行时);',
        '若是 P2 known-debt 暂未修,在本测试文件 RULES.whitelist 显式登记并加 TODO。',
      ].join('\n');
      throw new Error(msg);
    }
    expect(violations).toEqual([]);
  });

  it('whitelist 不能腐烂:每条 whitelist 都对应一条真实存在的 import', () => {
    const files = listTsFiles(SRC_DIR);
    const realEdges = new Set<string>();
    for (const file of files) {
      const importerRel = toSrcRelative(file);
      const content = readFileSync(file, 'utf-8');
      for (const spec of extractSpecifiers(content)) {
        const resolvedAbs = resolveSpecifier(file, spec);
        if (!resolvedAbs) continue;
        const targetRel = toSrcRelative(resolvedAbs);
        realEdges.add(`${importerRel}::${targetRel}`);
      }
    }
    const dead: string[] = [];
    for (const rule of RULES) {
      for (const entry of rule.whitelist ?? []) {
        if (!realEdges.has(entry)) dead.push(`${rule.from} → ${rule.to}: ${entry}`);
      }
    }
    if (dead.length > 0) {
      throw new Error(`whitelist 中有 ${dead.length} 条不再对应真实 import,请清理:\n${dead.join('\n')}`);
    }
    expect(dead).toEqual([]);
  });
});
