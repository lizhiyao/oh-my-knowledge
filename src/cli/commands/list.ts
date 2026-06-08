import { Flags } from '@oclif/core';
import { LANG_FLAG, bilingual } from '../oclif/i18n.js';
import { BaseCommand } from '../oclif/base-command.js';
import { tCli } from '../lib/i18n.js';
import { resolveInstallSource } from '../../inputs/source-resolver.js';
import {
  buildManagedListRows,
  globalManagedDir,
  hashArtifactSource,
  loadAllManagedRecords,
  managedDir,
  resolveManagedDir,
  type ManagedListRow,
} from '../../managed/index.js';
import type { ManagedArtifactRecord } from '../../types/index.js';
import type { CliLang } from '../lib/i18n.js';

/**
 * 算一条受管记录**当前源**的内容哈,用于 drift / 生命周期推导。
 *   - 远端 git(带 url):源身份钉的是不可变 SHA(install 时 pin),内容恒定 → 直接取 record.contentHash,
 *     不联网(list 是快读命令,不该为 drift 检查发网络请求)。
 *   - 本地 file / 本地 git:locator 就是 install 的输入串,复用 resolveInstallSource 重物化真源再哈;
 *     源已不在 / ref 已没 / 不在原仓库上下文 → 抛错 → undefined(deriveManagedState 据此判 stale)。
 */
function currentSourceHash(record: ManagedArtifactRecord): string | undefined {
  const s = record.source;
  if (s.sourceKind === 'git' && s.url) return record.contentHash;
  try {
    const resolved = resolveInstallSource(s.locator);
    try {
      return hashArtifactSource(resolved.localRoot, resolved.isDirectorySkill);
    } finally {
      resolved.cleanup();
    }
  } catch {
    return undefined;
  }
}

/** CJK 全角字符按 2 列计宽,使含中文表头的列也能对齐。 */
function dispWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return w;
}

function pad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - dispWidth(s)));
}

function truncate(s: string, max: number): string {
  return dispWidth(s) <= max ? s : `${s.slice(0, max - 1)}…`;
}

function renderTable(rows: ManagedListRow[], lang: CliLang): string {
  const headers = [
    tCli('cli.list.col_name', lang),
    tCli('cli.list.col_kind', lang),
    tCli('cli.list.col_state', lang),
    tCli('cli.list.col_verdict', lang),
    tCli('cli.list.col_evidence', lang),
    tCli('cli.list.col_source', lang),
  ];
  const cells = rows.map((r) => [
    r.name,
    r.kind,
    r.state === 'stale' ? 'stale ⚠️' : r.state,
    r.latestVerdict ?? '—',
    `${r.currentEvidenceCount}/${r.totalEvidenceCount}`,
    truncate(r.sourceLabel, 48),
  ]);
  const widths = headers.map((h, i) => Math.max(dispWidth(h), ...cells.map((c) => dispWidth(c[i]))));
  const line = (c: string[]): string => c.map((v, i) => pad(v, widths[i])).join('  ').trimEnd();
  return [line(headers), ...cells.map(line)].join('\n');
}

export default class List extends BaseCommand {
  static description = bilingual({
    zh: '列出受管 skill 及其证据状态：生命周期（installed / measurable / stale）、最新 verdict、证据数、源。',
    en: 'List managed skills with evidence status: lifecycle (installed / measurable / stale), latest verdict, evidence count, source.',
  });

  static examples = [
    { description: bilingual({ zh: '列出当前项目的受管 skill', en: 'List managed skills in the current project' }), command: '<%= config.bin %> list' },
    { description: bilingual({ zh: '列出全局受管 skill', en: 'List globally managed skills' }), command: '<%= config.bin %> list --global' },
    { description: bilingual({ zh: '机器可读 JSON 输出', en: 'Machine-readable JSON output' }), command: '<%= config.bin %> list --json' },
  ];

  static flags = {
    lang: LANG_FLAG,
    global: Flags.boolean({
      description: bilingual({ zh: '看全局受管目录（~/.oh-my-knowledge/managed）而非项目 .omk/managed', en: 'Show the global managed dir (~/.oh-my-knowledge/managed) instead of project .omk/managed' }),
    }),
    json: Flags.boolean({
      description: bilingual({ zh: '输出 JSON（含完整可比性 marker），供脚本消费', en: 'Output JSON (with full comparability markers) for scripts' }),
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(List);
    const lang = this.lang;
    await this.runWithCliExit(async () => {
      const dir = flags.global ? globalManagedDir() : resolveManagedDir(managedDir());
      const records = loadAllManagedRecords(dir);
      const rows = buildManagedListRows(records, currentSourceHash);

      if (flags.json) {
        this.log(JSON.stringify(rows, null, 2));
        return;
      }

      if (rows.length === 0) {
        process.stderr.write(tCli('cli.list.empty', lang));
        process.stderr.write(tCli('cli.list.empty_hint', lang));
        return;
      }

      const scope = dir === globalManagedDir()
        ? (lang === 'zh' ? '全局' : 'global')
        : (lang === 'zh' ? '项目' : 'project');
      process.stderr.write(tCli('cli.list.header', lang, { scope, count: rows.length }));
      this.log(renderTable(rows, lang));
      if (rows.some((r) => r.drifted)) process.stderr.write('\n' + tCli('cli.list.drift_note', lang));
      process.stderr.write(tCli('cli.list.legend', lang));
    });
  }
}
