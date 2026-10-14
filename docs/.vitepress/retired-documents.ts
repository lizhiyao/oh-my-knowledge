import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pageRoute } from './page-links.js';

// Historical prose is no longer part of the current docs or local search.
// These frozen Git links preserve provenance and provide an exit for old bookmarks.
export const retiredDocuments = [
  {
    "source": "specs/entities/history/entity-extraction-evolution.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/specs/entities/history/entity-extraction-evolution.md"
  },
  {
    "source": "specs/entities/history/entity-extraction-quality.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/specs/entities/history/entity-extraction-quality.md"
  },
  {
    "source": "specs/entities/history/entity-extraction-repeat-quality.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/specs/entities/history/entity-extraction-repeat-quality.md"
  },
  {
    "source": "specs/entities/history/entity-extraction-v10-diagnostic.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/specs/entities/history/entity-extraction-v10-diagnostic.md"
  },
  {
    "source": "specs/entities/history/entity-extraction-v11-boundary-diagnostic.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/specs/entities/history/entity-extraction-v11-boundary-diagnostic.md"
  },
  {
    "source": "specs/entities/history/entity-extraction-v11-real-regression.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/specs/entities/history/entity-extraction-v11-real-regression.md"
  },
  {
    "source": "specs/entities/history/entity-extraction-v12-followup-diagnostic.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/specs/entities/history/entity-extraction-v12-followup-diagnostic.md"
  },
  {
    "source": "specs/entities/history/entity-extraction-v12-target-regression.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/specs/entities/history/entity-extraction-v12-target-regression.md"
  },
  {
    "source": "specs/entities/history/entity-extraction-v4-repeat-quality.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/specs/entities/history/entity-extraction-v4-repeat-quality.md"
  },
  {
    "source": "specs/entities/history/entity-extraction-v6-diagnostic.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/specs/entities/history/entity-extraction-v6-diagnostic.md"
  },
  {
    "source": "specs/entities/history/entity-extraction-v6-real-pilot.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/specs/entities/history/entity-extraction-v6-real-pilot.md"
  },
  {
    "source": "specs/entities/history/entity-extraction-v7-diagnostic.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/specs/entities/history/entity-extraction-v7-diagnostic.md"
  },
  {
    "source": "specs/entities/history/entity-extraction-v8-diagnostic.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/specs/entities/history/entity-extraction-v8-diagnostic.md"
  },
  {
    "source": "specs/entities/history/entity-extraction-v8-real-pilot.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/specs/entities/history/entity-extraction-v8-real-pilot.md"
  },
  {
    "source": "specs/entities/history/entity-extraction-v8-workflow.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/specs/entities/history/entity-extraction-v8-workflow.md"
  },
  {
    "source": "specs/entities/history/entity-name-annotation-coverage.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/specs/entities/history/entity-name-annotation-coverage.md"
  },
  {
    "source": "specs/entities/history/extraction-quality-reproduction.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/specs/entities/history/extraction-quality-reproduction.md"
  },
  {
    "source": "specs/evaluation/history/eval-core-cutover.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/specs/evaluation/history/eval-core-cutover.md"
  },
  {
    "source": "specs/evaluation/history/eval-core-vnext-design.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/specs/evaluation/history/eval-core-vnext-design.md"
  },
  {
    "source": "specs/evaluation/history/general-sample-proposal.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/specs/evaluation/history/general-sample-proposal.md"
  },
  {
    "source": "specs/knowledge/history/knowledge-domain-model-design.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/specs/knowledge/history/knowledge-domain-model-design.md"
  },
  {
    "source": "specs/observe/history/knowledge-gap-signal-spec-design.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/specs/observe/history/knowledge-gap-signal-spec-design.md"
  },
  {
    "source": "specs/studio/history/studio-performance-baseline.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/specs/studio/history/studio-performance-baseline.md"
  },
  {
    "source": "zh/specs/entities/history/entity-extraction-evolution.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/zh/specs/entities/history/entity-extraction-evolution.md"
  },
  {
    "source": "zh/specs/entities/history/entity-extraction-quality.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/zh/specs/entities/history/entity-extraction-quality.md"
  },
  {
    "source": "zh/specs/entities/history/entity-extraction-repeat-quality.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/zh/specs/entities/history/entity-extraction-repeat-quality.md"
  },
  {
    "source": "zh/specs/entities/history/entity-extraction-v10-diagnostic.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/zh/specs/entities/history/entity-extraction-v10-diagnostic.md"
  },
  {
    "source": "zh/specs/entities/history/entity-extraction-v11-boundary-diagnostic.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/zh/specs/entities/history/entity-extraction-v11-boundary-diagnostic.md"
  },
  {
    "source": "zh/specs/entities/history/entity-extraction-v11-real-regression.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/zh/specs/entities/history/entity-extraction-v11-real-regression.md"
  },
  {
    "source": "zh/specs/entities/history/entity-extraction-v12-followup-diagnostic.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/zh/specs/entities/history/entity-extraction-v12-followup-diagnostic.md"
  },
  {
    "source": "zh/specs/entities/history/entity-extraction-v12-target-regression.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/zh/specs/entities/history/entity-extraction-v12-target-regression.md"
  },
  {
    "source": "zh/specs/entities/history/entity-extraction-v4-repeat-quality.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/zh/specs/entities/history/entity-extraction-v4-repeat-quality.md"
  },
  {
    "source": "zh/specs/entities/history/entity-extraction-v6-diagnostic.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/zh/specs/entities/history/entity-extraction-v6-diagnostic.md"
  },
  {
    "source": "zh/specs/entities/history/entity-extraction-v6-real-pilot.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/zh/specs/entities/history/entity-extraction-v6-real-pilot.md"
  },
  {
    "source": "zh/specs/entities/history/entity-extraction-v7-diagnostic.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/zh/specs/entities/history/entity-extraction-v7-diagnostic.md"
  },
  {
    "source": "zh/specs/entities/history/entity-extraction-v8-diagnostic.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/zh/specs/entities/history/entity-extraction-v8-diagnostic.md"
  },
  {
    "source": "zh/specs/entities/history/entity-extraction-v8-real-pilot.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/zh/specs/entities/history/entity-extraction-v8-real-pilot.md"
  },
  {
    "source": "zh/specs/entities/history/entity-extraction-v8-workflow.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/zh/specs/entities/history/entity-extraction-v8-workflow.md"
  },
  {
    "source": "zh/specs/entities/history/entity-name-annotation-coverage.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/zh/specs/entities/history/entity-name-annotation-coverage.md"
  },
  {
    "source": "zh/specs/entities/history/extraction-quality-reproduction.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/zh/specs/entities/history/extraction-quality-reproduction.md"
  },
  {
    "source": "zh/specs/evaluation/history/eval-core-cutover.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/zh/specs/evaluation/history/eval-core-cutover.md"
  },
  {
    "source": "zh/specs/evaluation/history/eval-core-vnext-design.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/zh/specs/evaluation/history/eval-core-vnext-design.md"
  },
  {
    "source": "zh/specs/evaluation/history/general-sample-proposal.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/zh/specs/evaluation/history/general-sample-proposal.md"
  },
  {
    "source": "zh/specs/knowledge/history/knowledge-domain-model-design.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/zh/specs/knowledge/history/knowledge-domain-model-design.md"
  },
  {
    "source": "zh/specs/observe/history/knowledge-gap-signal-spec-design.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/zh/specs/observe/history/knowledge-gap-signal-spec-design.md"
  },
  {
    "source": "zh/specs/studio/history/studio-performance-baseline.md",
    "archiveUrl": "https://github.com/lizhiyao/oh-my-knowledge/blob/9b480b27dbad8a0dc7041ef10ed9fb79a57e99af/docs/zh/specs/studio/history/studio-performance-baseline.md"
  }
] as const;

export function retiredDocumentRoutes() {
  return retiredDocuments.map(document => {
    const chinese = document.source.startsWith('zh/');
    const domain = document.source.match(/specs\/([^/]+)/)![1];
    return {
      route: pageRoute(document.source).replace(/\.md$/, ''),
      archiveUrl: document.archiveUrl,
      currentHref: '/' + (chinese ? 'zh/' : '') + 'specs/' + domain + '/',
      chinese,
    };
  });
}

export function writeRetiredDocumentNotices(outDir: string): void {
  const pages = retiredDocumentRoutes().map(page => ({ ...page, file: resolve(outDir, page.route + '.html') }));
  for (const page of pages) {
    if (existsSync(page.file)) throw new Error('Retired document route collides with a current page: ' + page.route);
  }
  for (const page of pages) {
    const title = page.chinese ? '这份历史记录已移出当前文档' : 'This historical record is outside the current documentation';
    const explanation = page.chinese
      ? '当前文档只描述最新有效规则。原始记录保留在固定 Git 快照中，不代表当前能力或质量。'
      : 'Current documentation describes the latest valid contracts. The original record remains in a frozen Git snapshot and does not establish current capabilities or quality.';
    const archive = page.chinese ? '查看冻结的原始记录' : 'Read the frozen original record';
    const current = page.chinese ? '阅读当前规范' : 'Read current specifications';
    const html = '<!DOCTYPE html><html lang="' + (page.chinese ? 'zh-Hans' : 'en') + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>' + title + ' · OMK</title><style>body{font:17px/1.65 system-ui,sans-serif;color:#192236;background:#fff;max-width:44rem;margin:10vh auto;padding:0 24px}h1{font-size:1.5rem;line-height:1.4}a{color:#5a3cdb}li{margin:12px 0}</style></head><body><main><h1>' + title + '</h1><p>' + explanation + '</p><ul><li><a id="archive" href="' + page.archiveUrl + '">' + archive + '</a></li><li><a href="' + page.currentHref + '">' + current + '</a></li></ul></main><script>const archive=document.getElementById("archive");archive.href+=location.hash;</script></body></html>';
    mkdirSync(dirname(page.file), { recursive: true });
    writeFileSync(page.file, html);
  }
}
