export const OBSERVATION_INBOX_REVIEW_STYLES = `        .inbox-detail-header {
          padding: 12px 14px;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--bg-surface);
          margin-bottom: 12px;
        }
        .inbox-detail-header-title { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: baseline; }
        .inbox-detail-header-title strong { font-size: 13px; color: var(--text-primary); }
        .inbox-detail-header-title span { font-size: 12px; color: var(--text-secondary); }
        .inbox-detail-header-meta { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 12px; font-size: 12px; color: var(--text-muted); }
        .inbox-section {
          margin-bottom: 14px;
          padding: 12px 14px;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--bg-surface);
          display: flex;
          flex-direction: column;
          min-height: 0;
          box-sizing: border-box;
          width: 100%;
          scroll-margin-top: 96px;
        }
        .inbox-detail-main { width: 100%; box-sizing: border-box; }
        .inbox-detail-pane.is-active { display: block; }
        .inbox-detail-pane { display: none; box-sizing: border-box; }
        .inbox-session-tabs {
          display: flex;
          gap: 6px;
          flex-wrap: nowrap;
          overflow-x: auto;
          overflow-y: hidden;
          white-space: nowrap;
          -webkit-overflow-scrolling: touch;
          margin-bottom: 12px;
          padding: 8px 10px;
          background: var(--bg-surface);
          border: 1px solid var(--border);
          border-radius: 8px;
        }
        .inbox-session-tab-item {
          flex: 0 0 auto;
          display: inline-flex;
          align-items: stretch;
          max-width: 360px;
          position: relative;
          padding-top: 8px;
        }
        .inbox-session-tab {
          flex: 1 1 auto;
          min-width: 0;
          padding: 4px 9px;
          border: 1px solid var(--border);
          background: var(--bg-surface);
          color: var(--text-secondary);
          font-size: 11px;
          border-radius: 999px;
          cursor: pointer;
          line-height: 1.5;
          font-family: ui-monospace, monospace;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .inbox-session-flow-chip {
          flex: 0 0 auto;
          margin-left: -1px;
          padding: 4px 7px;
          border: 1px solid var(--border);
          background: var(--info-bg, rgba(79,70,229,.08));
          color: var(--accent);
          font-size: 11px;
          border-radius: 0 999px 999px 0;
          cursor: pointer;
          line-height: 1.5;
        }
        .inbox-session-tab-item .inbox-session-tab {
          border-radius: 999px 0 0 999px;
        }
        .inbox-session-flow-chip:hover {
          border-color: var(--accent);
          background: rgba(79,70,229,.14);
        }
        .inbox-session-tab:hover { color: var(--text-primary); border-color: var(--border-hover, var(--border)); }
        .inbox-session-tab.is-active { background: var(--accent); color: #fff; border-color: var(--accent); }
        .inbox-session-tab.is-priority-high:not(.is-active) { border-left: 3px solid var(--red); }
        .inbox-session-tab.is-priority-medium:not(.is-active) { border-left: 3px solid var(--yellow); }
        .inbox-session-tab.is-priority-low:not(.is-active) { border-left: 3px solid var(--green); }
        .inbox-session-tab-alerts {
          position: absolute;
          top: 0;
          right: 4px;
          display: inline-flex;
          gap: 4px;
          max-width: calc(100% - 12px);
          pointer-events: none;
          z-index: 2;
        }
        .inbox-session-tab-alerts span {
          display: inline-block;
          max-width: 92px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          padding: 1px 5px;
          border: 1px solid var(--red);
          border-radius: 999px;
          background: var(--red-bg);
          color: var(--red);
          font-size: 9px;
          line-height: 1.25;
          font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          box-shadow: var(--shadow-sm, 0 1px 3px rgba(0,0,0,.08));
        }
        .inbox-session-panes { width: 100%; }
        .inbox-session-pane { display: none; width: 100%; box-sizing: border-box; }
        .inbox-session-pane.is-active { display: block; }
        .inbox-session-pane:not(.is-active) .inbox-detail-nav { display: none; }
        .inbox-session-meta {
          display: flex;
          flex-wrap: wrap;
          gap: 10px 14px;
          padding: 8px 12px;
          background: var(--bg-soft, rgba(0,0,0,.03));
          border: 1px solid var(--border);
          border-radius: 6px;
          margin-bottom: 12px;
          font-size: 12px;
          color: var(--text-secondary);
        }
        .inbox-session-meta code { font-size: 11px; padding: 1px 5px; background: var(--bg-surface); border: 1px solid var(--border); border-radius: 4px; }
        .inbox-section-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
        .inbox-section-head-clickable { cursor: pointer; user-select: none; margin: -4px -6px 8px; padding: 4px 6px; border-radius: 6px; }
        .inbox-section-head-clickable:hover { background: var(--bg-soft, rgba(0,0,0,.04)); }
        .inbox-section.is-collapsed .inbox-section-head-clickable { margin-bottom: 0; }
        .inbox-section-head h3 { font-size: 13px; margin: 0; color: var(--text-primary); flex-shrink: 0; }
        .inbox-section-summary {
          font-size: 11px;
          padding: 2px 8px;
          border-radius: 999px;
          border: 1px solid var(--border);
          background: var(--bg-surface);
          color: var(--text-secondary);
          flex-shrink: 0;
        }
        .inbox-section-summary.is-attention { background: var(--red-bg); border-color: var(--red); color: var(--red); }
        .inbox-section-summary.is-ok { background: var(--green-bg); border-color: var(--green); color: var(--green); }
        .inbox-section-summary.is-neutral { background: var(--info-bg, rgba(79,70,229,.08)); border-color: var(--accent); color: var(--accent); }
        .inbox-section-hint { font-size: 11px; color: var(--text-muted); flex: 1 1 auto; min-width: 0; }
        .inbox-section-review {
          position: relative;
          margin-left: auto;
          flex: 0 0 auto;
        }
        .inbox-section-review + .inbox-section-toggle { margin-left: 0; }
        .inbox-section-review-button {
          list-style: none;
          cursor: pointer;
          padding: 4px 10px;
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--bg-surface);
          color: var(--text-secondary);
          font-size: 12px;
          line-height: 1.2;
        }
        .inbox-section-review-button::-webkit-details-marker { display: none; }
        .inbox-section-review[open] .inbox-section-review-button,
        .inbox-section-review-button:hover {
          border-color: var(--accent);
          color: var(--accent);
          background: var(--info-bg, rgba(79,70,229,.08));
        }
        .inbox-section-review-panel {
          position: absolute;
          top: calc(100% + 6px);
          right: 0;
          z-index: 35;
          width: min(420px, calc(100vw - 32px));
          max-height: min(70vh, 620px);
          overflow-y: auto;
          padding: 10px 12px;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--bg-surface);
          box-shadow: var(--shadow-lg, 0 12px 30px rgba(0,0,0,.16));
        }
        .inbox-manual-review-groups {
          margin-top: 10px;
          padding-top: 10px;
          border-top: 1px solid var(--border);
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .inbox-manual-review-group {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .inbox-manual-review-group > strong {
          font-size: 12px;
          color: var(--text-primary);
        }
        .inbox-section-toggle {
          margin-left: auto;
          font-size: 11px;
          padding: 2px 8px;
          border: 1px solid var(--border);
          background: var(--bg-surface);
          color: var(--text-secondary);
          border-radius: 4px;
          cursor: pointer;
          flex-shrink: 0;
        }
        .inbox-section-toggle:hover { color: var(--text-primary); }
        .inbox-section-body { /* no internal scroll; let the page handle it */ }
        .inbox-section.is-collapsed .inbox-section-body { display: none; }
        .inbox-section.is-collapsed { padding-bottom: 8px; }
        .inbox-detail-body-grid { display: block; position: relative; }
        .inbox-detail-main { min-width: 0; }
        .inbox-detail-nav {
          position: fixed;
          top: 120px;
          right: 16px;
          width: 132px;
          display: flex;
          flex-direction: column;
          gap: 5px;
          padding: 0;
          border: 0;
          border-radius: 0;
          background: transparent;
          box-shadow: none;
          font-size: 12px;
          z-index: 80;
        }
        .inbox-detail-pane:not(.is-active) .inbox-detail-nav { display: none; }
        .inbox-detail-nav a {
          padding: 6px 10px;
          color: var(--text-primary);
          text-decoration: none;
          border-radius: 6px;
          background: rgba(255, 255, 255, 0.92);
          border: 1px solid var(--border);
          box-shadow: var(--shadow-sm, 0 1px 3px rgba(0,0,0,.08));
          backdrop-filter: blur(6px);
          -webkit-backdrop-filter: blur(6px);
          line-height: 1.4;
          font-weight: 500;
        }
        .inbox-detail-nav a.is-sub {
          margin-left: 10px;
          padding-top: 4px;
          padding-bottom: 4px;
          color: var(--text-muted);
          font-size: 10px;
        }
        .inbox-detail-nav a:hover {
          background: var(--info-bg, rgba(79,70,229,.12));
          color: var(--accent);
          border-color: var(--accent);
        }
        .inbox-detail-nav a.is-active {
          background: var(--accent);
          color: #fff;
          border-color: var(--accent);
          font-weight: 600;
        }
        @media (max-width: 1080px) {
          .inbox-detail-nav { display: none !important; }
        }
        .inbox-flow-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0; }
        .inbox-flow-timeline {
          position: relative;
        }
        .inbox-flow-item {
          display: grid;
          grid-template-columns: 58px 28px minmax(0, 1fr);
          gap: 8px;
          align-items: stretch;
          position: relative;
          min-width: 0;
        }
        .inbox-flow-item::before {
          content: '';
          position: absolute;
          left: 71px;
          top: 0;
          bottom: 0;
          width: 2px;
          background: var(--border);
        }
        .inbox-flow-item:first-child::before { top: 14px; }
        .inbox-flow-item:last-child::before { bottom: calc(100% - 14px); }
        .inbox-flow-time {
          padding-top: 6px;
          color: var(--text-muted);
          font-size: 11px;
          line-height: 1.3;
          text-align: right;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          white-space: nowrap;
        }
        .inbox-flow-rail {
          position: relative;
          display: flex;
          justify-content: center;
          padding-top: 2px;
          z-index: 1;
        }
        .inbox-flow-anchor {
          display: flex;
          align-items: stretch;
          padding: 0 0 10px;
          text-decoration: none;
          color: var(--text-primary);
          min-width: 0;
        }
        .inbox-flow-anchor .inbox-flow-body {
          width: 100%;
          border: 1px solid var(--border);
          border-radius: 7px;
          background: var(--bg-surface);
          padding: 8px 10px;
          box-sizing: border-box;
          min-width: 0;
        }
        .inbox-flow-item.is-priority-high .inbox-flow-body { border-left: 3px solid var(--red); }
        .inbox-flow-item.is-priority-medium .inbox-flow-body { border-left: 3px solid var(--yellow); }
        .inbox-flow-item.is-priority-low .inbox-flow-body { border-left: 3px solid var(--green); }
        .inbox-flow-item.is-current .inbox-flow-body {
          background: var(--info-bg, rgba(37,99,235,.08));
          border-color: rgba(37,99,235,.28);
        }
        .inbox-flow-anchor:hover .inbox-flow-body { background: var(--bg-muted, rgba(0,0,0,.04)); }
        .inbox-flow-item.is-current .inbox-flow-anchor:hover .inbox-flow-body { background: var(--info-bg, rgba(37,99,235,.08)); }
        .inbox-flow-index {
          width: 22px; height: 22px;
          border-radius: 50%;
          background: var(--accent);
          color: #fff;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 12px;
          font-weight: 600;
          flex-shrink: 0;
          box-shadow: 0 0 0 3px var(--bg-surface);
        }
        .inbox-flow-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .inbox-flow-title strong { font-size: 13px; }
        .inbox-flow-title em { font-style: normal; font-size: 11px; padding: 1px 6px; background: var(--info-bg); color: var(--accent); border-radius: 999px; }
        .inbox-flow-priority { font-size: 11px; color: var(--text-muted); }
        .inbox-flow-meta {
          display: flex;
          flex-wrap: wrap;
          gap: 6px 10px;
          font-size: 11px;
          color: var(--text-muted);
          margin-top: 4px;
        }
        .inbox-flow-range {
          margin-top: 3px;
          color: var(--text-secondary);
          font-size: 11px;
          line-height: 1.4;
          word-break: break-word;
        }
        .inbox-flow-slices,
        .inbox-flow-dispatches,
        .inbox-flow-episodes { margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--border); }
        .inbox-flow-slices h4,
        .inbox-flow-dispatches h4,
        .inbox-flow-episodes h4 { font-size: 12px; margin: 0 0 6px; color: var(--text-secondary); }
        .inbox-flow-slice,
        .inbox-flow-dispatch {
          padding: 6px 8px;
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--bg-soft, rgba(0,0,0,.03));
          margin-bottom: 6px;
          font-size: 12px;
        }
        .inbox-flow-slice strong,
        .inbox-flow-dispatch strong { font-size: 12px; color: var(--text-primary); display: block; }
        .inbox-flow-slice span,
        .inbox-flow-dispatch span { font-size: 11px; color: var(--text-muted); }
        .inbox-flow-slice p { margin: 4px 0 0; color: var(--text-secondary); line-height: 1.5; font-size: 12px; }
        .inbox-flow-episode {
          display: grid;
          gap: 8px;
          margin-bottom: 8px;
          padding: 8px;
          border: 1px solid var(--border);
          border-radius: 7px;
          background: var(--bg);
        }
        .inbox-flow-episode-head {
          display: grid;
          grid-template-columns: 64px minmax(0,1fr);
          gap: 8px;
          align-items: baseline;
        }
        .inbox-flow-episode-head strong { font-size: 12px; color: var(--text-primary); }
        .inbox-flow-episode-head span {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: var(--text-secondary);
          font-size: 12px;
        }
        .inbox-flow-episode-track {
          display: flex;
          gap: 6px;
          overflow-x: auto;
          padding-bottom: 2px;
        }
        .inbox-flow-episode-segment {
          flex: 0 0 145px;
          display: grid;
          gap: 2px;
          padding: 7px 8px;
          border: 1px solid var(--border);
          border-top: 3px solid var(--text-muted);
          border-radius: 6px;
          background: var(--bg-surface);
        }
        .inbox-flow-episode-segment.is-current {
          border-top-color: var(--accent);
          background: var(--info-bg);
        }
        .inbox-flow-episode-segment em {
          font-style: normal;
          color: var(--text-muted);
          font-size: 10px;
        }
        .inbox-flow-episode-segment strong {
          color: var(--text-primary);
          font-size: 12px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .inbox-flow-episode-segment span,
        .inbox-flow-episode-feedback span,
        .inbox-flow-episode-feedback em {
          color: var(--text-muted);
          font-size: 11px;
          font-style: normal;
        }
        .inbox-flow-episode-feedback {
          display: grid;
          gap: 5px;
        }
        .inbox-flow-episode-feedback div {
          display: grid;
          grid-template-columns: 54px minmax(0,1fr);
          gap: 6px;
          align-items: start;
          padding: 5px 6px;
          border: 1px dashed var(--border);
          border-radius: 6px;
          background: var(--bg-surface);
        }
        .inbox-flow-episode-feedback strong {
          color: var(--text-secondary);
          font-size: 12px;
          line-height: 1.45;
        }
        .inbox-flow-episode-feedback em {
          grid-column: 2;
        }
        .inbox-execution-overview {
          margin: 10px 0;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--bg-surface);
        }
        .inbox-execution-overview > summary {
          cursor: pointer;
          padding: 8px 10px;
          color: var(--text-primary);
          font-size: 12px;
          font-weight: 700;
        }
        .inbox-execution-overview[open] > summary { border-bottom: 1px solid var(--border); }
        .inbox-execution-overview-body {
          display: grid;
          gap: 8px;
          padding: 8px;
        }
        .inbox-execution-overview-note {
          margin: 0;
          color: var(--text-muted);
          font-size: 10px;
          line-height: 1.45;
        }
        .inbox-execution-episode {
          display: grid;
          gap: 8px;
          min-width: 0;
          border: 1px solid var(--border);
          border-radius: 7px;
          background: var(--bg);
          padding: 0;
        }
        .inbox-execution-episode-head {
          display: grid;
          grid-template-columns: 104px minmax(0,1fr) auto;
          gap: 8px;
          align-items: baseline;
          padding: 7px 8px;
          cursor: pointer;
          list-style: none;
        }
        .inbox-execution-episode-head::-webkit-details-marker { display: none; }
        .inbox-execution-episode-head::after {
          content: "展开";
          justify-self: end;
          color: var(--text-muted);
          font-size: 10px;
        }
        .inbox-execution-episode[open] > .inbox-execution-episode-head {
          border-bottom: 1px solid var(--border);
        }
        .inbox-execution-episode[open] > .inbox-execution-episode-head::after { content: "收起"; }
        .inbox-execution-episode-head strong {
          color: var(--text-primary);
          font-size: 11px;
        }
        .inbox-execution-episode-head span {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: var(--text-secondary);
          font-size: 11px;
        }
        .inbox-execution-episode-body {
          display: grid;
          gap: 8px;
          padding: 8px;
        }
        .inbox-execution-timeline {
          position: relative;
          display: grid;
          gap: 8px;
          margin: 0;
          padding: 0 0 0 16px;
          list-style: none;
        }
        .inbox-execution-skill-children {
          position: relative;
          display: grid;
          gap: 6px;
          margin: 6px 0 0 24px;
          padding: 0 0 0 16px;
          list-style: none;
        }
        .inbox-execution-timeline::before,
        .inbox-execution-skill-children::before {
          content: "";
          position: absolute;
          left: 6px;
          top: 9px;
          bottom: 9px;
          width: 1px;
          background: var(--border);
        }
        .inbox-execution-node {
          position: relative;
          display: grid;
          gap: 5px;
          min-width: 0;
        }
        .inbox-execution-node::before {
          content: "";
          position: absolute;
          left: -13px;
          top: 8px;
          width: 7px;
          height: 7px;
          border-radius: 999px;
          background: var(--text-muted);
          box-shadow: 0 0 0 3px var(--bg-surface);
        }
        .inbox-execution-node.is-current::before { background: var(--accent); }
        .inbox-execution-node.is-child::before {
          background: var(--bg-surface);
          border: 1px solid var(--border);
        }
        .inbox-execution-node-main {
          display: grid;
          grid-template-columns: 28px minmax(0,1fr);
          gap: 6px;
          align-items: start;
          padding: 5px 7px;
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--bg);
        }
        .inbox-execution-node.is-current .inbox-execution-node-main {
          border-color: var(--accent);
          background: var(--info-bg, rgba(79,70,229,.08));
        }
        .inbox-execution-node-index {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 16px;
          width: auto;
          height: 16px;
          padding: 0 4px;
          border-radius: 999px;
          background: var(--bg-surface);
          border: 1px solid var(--border);
          color: var(--text-muted);
          font-size: 10px;
        }
        .inbox-execution-node-main em,
        .inbox-execution-links span,
        .inbox-execution-feedback-item span,
        .inbox-execution-feedback-item em {
          color: var(--text-muted);
          font-size: 10px;
          font-style: normal;
        }
        .inbox-execution-node-main strong {
          display: block;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: var(--text-primary);
          font-size: 11px;
        }
        .inbox-execution-node-main em {
          display: block;
          margin-top: 1px;
        }
        .inbox-execution-links {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }
        .inbox-execution-links span {
          padding: 2px 6px;
          border: 1px solid var(--border);
          border-radius: 999px;
          background: var(--bg);
        }
        .inbox-execution-node-children {
          display: grid;
          gap: 4px;
          margin-left: 24px;
        }
        .inbox-execution-feedback-item {
          display: grid;
          grid-template-columns: 54px minmax(0,1fr);
          gap: 6px;
          padding: 4px 6px;
          border: 1px dashed var(--border);
          border-radius: 6px;
          background: var(--bg);
        }
        .inbox-execution-feedback-item p {
          margin: 0;
          color: var(--text-secondary);
          font-size: 11px;
          line-height: 1.45;
        }
        .inbox-execution-feedback-item em { grid-column: 2; }
        .inbox-rule-flow-overview .inbox-skill-chain {
          margin: 0;
          padding: 10px;
        }
        .inbox-skill-block {
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--bg-soft, rgba(0,0,0,.02));
          padding: 10px 12px;
          margin-bottom: 10px;
          scroll-margin-top: 12px;
        }
        .inbox-skill-block:last-child { margin-bottom: 0; }
        .inbox-skill-head { display: flex; flex-wrap: wrap; gap: 6px 12px; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
        .inbox-skill-head h4 { font-size: 13px; margin: 0; color: var(--text-primary); }
        .inbox-skill-title-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
        .inbox-skill-type {
          display: inline-flex;
          align-items: center;
          min-height: 20px;
          padding: 1px 7px;
          border: 1px solid var(--border);
          border-radius: 999px;
          background: var(--bg-surface);
          color: var(--text-secondary);
          font-size: 11px;
          line-height: 1.4;
          font-weight: 650;
        }
        .inbox-skill-subtitle { font-size: 12px; color: var(--text-secondary); }
        .inbox-skill-summary { margin: 4px 0 0; font-size: 12px; color: var(--text-secondary); line-height: 1.5; }
        .inbox-skill-empty { color: var(--text-muted); font-size: 12px; margin: 4px 0; }
        .inbox-trust-layer {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 6px;
          margin: 8px 0;
          padding: 8px;
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--bg-surface);
        }
        .inbox-data-health,
        .inbox-trust-fact {
          display: inline-flex;
          align-items: center;
          min-height: 22px;
          padding: 2px 8px;
          border-radius: 999px;
          font-size: 11px;
          line-height: 1.4;
          border: 1px solid var(--border);
          background: var(--bg-soft, rgba(0,0,0,.03));
          color: var(--text-secondary);
        }
        .inbox-data-health { font-weight: 700; }
        .inbox-data-health.is-ok { border-color: var(--green); background: var(--green-bg); color: var(--green); }
        .inbox-data-health.is-attention { border-color: var(--red); background: var(--red-bg); color: var(--red); }
        .inbox-data-health.is-unknown { border-color: var(--yellow); background: var(--yellow-bg); color: var(--yellow); }
        .inbox-data-health.is-degraded { border-color: var(--red); background: var(--red-bg); color: var(--red); }
        .inbox-review-layer { margin-top: 10px; }
        .inbox-type-summary { margin: 0 0 6px; color: var(--text-secondary); font-size: 12px; line-height: 1.5; }
        .inbox-review-layer-title {
          font-size: 11px;
          font-weight: 700;
          color: var(--text-muted);
          margin-bottom: 6px;
        }
        .inbox-parent-status-row {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          gap: 8px;
        }
        .inbox-parent-status {
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--bg-surface);
          padding: 7px 8px;
          display: grid;
          gap: 4px;
          min-width: 0;
        }
        .inbox-parent-status.is-ok { border-color: var(--green); }
        .inbox-parent-status.is-attention,
        .inbox-parent-status.is-degraded { border-color: var(--red); }
        .inbox-parent-status.is-unknown { border-color: var(--yellow); }
        .inbox-parent-status.is-not-applicable { opacity: .78; }
        .inbox-parent-status span { font-size: 12px; font-weight: 700; color: var(--text-primary); }
        .inbox-parent-status em { font-style: normal; font-size: 11px; color: var(--text-muted); }
        .inbox-review-suggestions {
          margin-top: 10px;
          border-top: 1px dashed var(--border);
          padding-top: 8px;
        }
        .inbox-review-suggestions .inbox-action-suggestion-list { margin-top: 6px; }
        .inbox-answer-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; }
        .inbox-answer {
          padding: 8px 10px;
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--bg-surface);
        }
        .inbox-answer.is-attention { border-color: var(--red); }
        .inbox-answer.is-unknown { border-color: var(--yellow); }
        .inbox-answer.is-ok { border-color: var(--green); }
        .inbox-answer.is-degraded { border-color: var(--red); background: var(--red-bg); }
        .inbox-answer.is-not-applicable { border-color: var(--border); opacity: .82; }
        .inbox-answer-head { display: flex; gap: 8px; justify-content: space-between; align-items: baseline; margin-bottom: 4px; }
        .inbox-answer-head strong { font-size: 12px; color: var(--text-primary); }
        .inbox-answer p { margin: 0; font-size: 12px; color: var(--text-secondary); line-height: 1.5; }
        .inbox-answer-context {
          margin-top: 6px;
          padding: 6px 8px;
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--bg-soft, rgba(0,0,0,.03));
          display: grid;
          gap: 6px;
        }
        .inbox-answer-context div {
          display: grid;
          grid-template-columns: 68px minmax(0,1fr);
          gap: 8px;
          align-items: start;
        }
        .inbox-answer-context span {
          font-size: 11px;
          font-weight: 700;
          color: var(--text-muted);
          line-height: 1.45;
        }
        .inbox-answer-context strong {
          font-size: 12px;
          line-height: 1.45;
          color: var(--text-primary);
          font-weight: 600;
          word-break: break-word;
        }
        .inbox-answer-checklist {
          display: flex;
          flex-wrap: wrap;
          gap: 5px;
          margin-top: 6px;
        }
        .inbox-answer-checklist.is-grouped {
          display: grid;
          gap: 7px;
        }
        .inbox-answer-check-group {
          display: grid;
          gap: 4px;
        }
        .inbox-answer-check-group > strong {
          color: var(--text-muted);
          font-size: 11px;
          font-weight: 650;
        }
        .inbox-answer-check-group > div {
          display: flex;
          flex-wrap: wrap;
          gap: 5px;
        }
        .inbox-answer-check {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          max-width: 100%;
          padding: 3px 7px;
          border: 1px solid var(--border);
          border-radius: 999px;
          background: var(--bg-soft, rgba(0,0,0,.03));
          color: var(--text-secondary);
          font-size: 11px;
          line-height: 1.45;
        }
        .inbox-answer-check em {
          color: var(--text-muted);
          font-style: normal;
          font-size: 10px;
          border-left: 1px solid var(--border);
          padding-left: 5px;
        }
        .inbox-answer-check.is-detected {
          border-color: var(--accent);
          background: var(--bg-surface);
          color: var(--text-primary);
        }
        .inbox-answer-check.is-detected .inbox-answer-check-icon {
          color: var(--accent);
        }
        .inbox-answer-check.is-absent {
          color: var(--text-muted);
          background: transparent;
          border-color: var(--border);
        }
        .inbox-answer-check.is-absent .inbox-answer-check-icon {
          color: var(--text-muted);
        }
        .inbox-answer-check-icon {
          flex: 0 0 auto;
          font-size: 9px;
          line-height: 1;
        }
        .manual-correction-panel {
          margin-top: 8px;
          padding-top: 8px;
          border-top: 1px dashed var(--border);
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .manual-correction-panel.is-in-review-popover {
          margin-top: 0;
          padding-top: 0;
          border-top: 0;
        }
        .manual-correction-title {
          font-size: 11px;
          color: var(--text-muted);
          font-weight: 650;
        }
        .manual-correction-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 5px;
        }
        .manual-correction-button {
          border: 1px solid var(--border);
          background: var(--bg-surface);
          color: var(--text-secondary);
          border-radius: 999px;
          padding: 3px 8px;
          font-size: 11px;
          line-height: 1.45;
          cursor: pointer;
          max-width: 100%;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .manual-correction-button:hover {
          color: var(--text-primary);
          border-color: var(--accent);
        }
        .manual-correction-button.is-marked {
          background: var(--info-bg);
          color: var(--accent);
          border-color: var(--accent);
          font-weight: 650;
        }
        .manual-correction-popover {
          position: fixed;
          z-index: 10000;
          background: var(--bg-surface);
          color: var(--text-primary);
          border: 1px solid var(--border);
          box-shadow: var(--shadow-lg);
          border-radius: 8px;
          padding: 10px;
          width: min(320px, calc(100vw - 24px));
        }
        .manual-correction-popover-title {
          font-size: 12px;
          font-weight: 700;
          margin-bottom: 4px;
        }
        .manual-correction-popover-hint {
          font-size: 11px;
          color: var(--text-muted);
          line-height: 1.45;
          margin-bottom: 8px;
        }
        .manual-correction-popover-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }
        .manual-correction-popover-actions button {
          border: 1px solid var(--border);
          background: var(--bg);
          color: var(--text-secondary);
          border-radius: 6px;
          padding: 5px 8px;
          font-size: 12px;
          cursor: pointer;
        }
        .manual-correction-popover-actions button:hover {
          color: var(--text-primary);
          border-color: var(--accent);
        }
        .inbox-answer-meta {
          margin-top: 8px;
          padding: 7px 9px;
          border: 1px dashed var(--border);
          border-radius: 6px;
          background: var(--bg-soft, rgba(0,0,0,.03));
          font-size: 11px;
        }
        .inbox-answer-meta-row { display: flex; gap: 6px; margin-bottom: 4px; line-height: 1.5; }
        .inbox-answer-meta-row:last-child { margin-bottom: 0; }
        .inbox-answer-meta-row span { color: var(--text-muted); flex-shrink: 0; }
        .inbox-answer-meta-row strong { color: var(--text-primary); font-weight: 600; word-break: break-all; }
        .inbox-answer-meta-row em { color: var(--text-muted); font-style: normal; }
        .inbox-answer-jump {
          margin-top: 6px;
        }
        .inbox-answer-jump button {
          font-size: 11px;
          padding: 3px 8px;
          border: 1px solid var(--accent);
          background: var(--bg-surface);
          color: var(--accent);
          border-radius: 4px;
          cursor: pointer;
        }
        .inbox-answer-jump button:hover { background: var(--info-bg); }
        .inbox-answer-evidence {
          margin-top: 8px;
        }
        .inbox-answer-evidence-link {
          font-size: 11px;
          padding: 0;
          border: 0;
          background: transparent;
          color: var(--accent);
          text-decoration: underline;
          text-underline-offset: 2px;
          cursor: pointer;
        }
        .inbox-answer-evidence-link:hover { color: var(--text-primary); }
        .inbox-answer-status { font-size: 11px; padding: 1px 6px; border-radius: 999px; flex-shrink: 0; }
        .inbox-answer-status.is-attention { background: var(--red-bg); color: var(--red); }
        .inbox-answer-status.is-unknown { background: var(--yellow-bg); color: var(--yellow); }
        .inbox-answer-status.is-ok { background: var(--green-bg); color: var(--green); }
        .inbox-answer-status.is-degraded { background: var(--red-bg); color: var(--red); }
        .inbox-answer-status.is-not-applicable { background: var(--bg-soft); color: var(--text-muted); }
        .inbox-skill-findings { margin-top: 10px; padding-top: 8px; border-top: 1px dashed var(--border); }
        .inbox-skill-findings h5 { font-size: 12px; margin: 0 0 6px; color: var(--text-secondary); }
        .inbox-suggestion-block {
          margin-top: 10px;
          padding: 10px 12px;
          border-radius: 6px;
          background: var(--green-bg);
          border-left: 3px solid var(--green);
          font-size: 12px;
          color: var(--text-secondary);
          line-height: 1.55;
        }
        details.inbox-suggestion-block > summary {
          cursor: pointer;
          list-style: none;
        }
        details.inbox-suggestion-block > summary::-webkit-details-marker { display: none; }
        details.inbox-suggestion-block > summary::before {
          content: '▾';
          display: inline-block;
          margin-right: 6px;
          color: var(--green);
          font-size: 11px;
        }
        details.inbox-suggestion-block:not([open]) > summary::before { content: '▸'; }
        .inbox-skill-summary-suggestions {
          margin: 0 0 12px;
        }
        .inbox-skill-summary-suggestions .inbox-suggestion-block {
          margin-top: 0;
        }
        .inbox-suggestion-title {
          font-size: 12px;
          color: var(--green);
          font-weight: 600;
          margin-bottom: 5px;
        }
        .inbox-suggestion-block ul {
          margin: 0;
          padding-left: 18px;
        }
        .inbox-suggestion-block li { margin-bottom: 3px; }
        .inbox-suggestion-block li:last-child { margin-bottom: 0; }
        .inbox-action-suggestion-list {
          list-style: none;
          margin: 0;
          padding: 0;
          display: grid;
          gap: 8px;
        }
        .inbox-action-suggestion-list.is-compact {
          gap: 6px;
        }
        .inbox-action-suggestion-item {
          margin: 0;
        }
        .inbox-action-suggestion-card {
          border: 1px solid rgba(90, 122, 147, .18);
          border-radius: 7px;
          background: rgba(255, 255, 255, .48);
          overflow: hidden;
        }
        .inbox-action-suggestion-card > summary {
          list-style: none;
          cursor: pointer;
          display: grid;
          grid-template-columns: auto minmax(0, 1fr) auto;
          align-items: center;
          gap: 8px;
          padding: 8px 10px;
        }
        .inbox-action-suggestion-card > summary::-webkit-details-marker { display: none; }
        .inbox-action-suggestion-card > summary strong {
          color: var(--text-primary);
          font-weight: 600;
          line-height: 1.35;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .inbox-action-suggestion-card[open] > summary strong {
          white-space: normal;
        }
        .inbox-action-suggestion-card > summary em {
          font-style: normal;
          color: var(--accent);
          font-size: 11px;
          white-space: nowrap;
        }
        .inbox-action-suggestion-index {
          width: 18px;
          height: 18px;
          border-radius: 50%;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: var(--green-bg);
          color: var(--green);
          font-size: 11px;
          font-weight: 700;
        }
        .inbox-action-suggestion-body {
          border-top: 1px solid rgba(90, 122, 147, .14);
          padding: 8px 10px 10px 36px;
          display: grid;
          gap: 7px;
        }
        .inbox-action-suggestion-detail {
          display: flex;
          align-items: baseline;
          gap: 8px;
          color: var(--text-secondary);
        }
        .inbox-action-suggestion-detail span {
          display: inline-flex;
          flex: 0 0 auto;
          padding: 1px 6px;
          border-radius: 999px;
          background: rgba(90, 122, 147, .14);
          color: var(--accent);
          font-size: 11px;
          font-weight: 700;
        }
        .inbox-action-suggestion-detail.is-acceptance span {
          background: var(--green-bg);
          color: var(--green);
        }
        .inbox-action-suggestion-detail p {
          flex: 1 1 auto;
          margin: 0;
          line-height: 1.5;
          min-width: 0;
        }
        .inbox-flow-popover {
          position: fixed;
          z-index: 240;
          width: min(560px, calc(100vw - 32px));
          max-height: min(620px, calc(100vh - 48px));
          overflow: auto;
          padding: 12px;
          border: 1px solid var(--border);
          border-radius: 10px;
          background: var(--bg-surface);
          box-shadow: var(--shadow-md, 0 8px 24px rgba(0,0,0,.16));
        }
        .inbox-flow-popover-close {
          position: sticky;
          top: 0;
          float: right;
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--bg-surface);
          color: var(--text-secondary);
          padding: 3px 8px;
          cursor: pointer;
          font-size: 12px;
        }
        .inbox-flow-popover-head {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 8px;
          margin-bottom: 10px;
          padding-right: 48px;
        }
        .inbox-flow-popover-head strong {
          color: var(--text-primary);
          font-size: 13px;
        }
        .inbox-flow-popover-body {
          display: grid;
          gap: 10px;
        }
        .inbox-finding {
          padding: 8px 10px;
          border-radius: 6px;
          margin-bottom: 6px;
          border: 1px solid var(--border);
          background: var(--bg-surface);
        }
        .inbox-finding.is-attention { background: var(--red-bg); border-color: var(--red); border-left: 4px solid var(--red); }
        .inbox-finding.is-sample { background: var(--yellow-bg); border-color: var(--yellow); border-left: 4px solid var(--yellow); }
        .inbox-finding.is-normal { border-left: 4px solid var(--text-faint); }
        .inbox-finding.is-clickable { cursor: pointer; transition: transform .12s; }
        .inbox-finding.is-clickable:hover { transform: translateX(2px); }
        .inbox-finding-head { display: flex; gap: 8px; justify-content: space-between; align-items: baseline; margin-bottom: 4px; flex-wrap: wrap; }
        .inbox-finding-head strong { font-size: 12px; color: var(--text-primary); }
        .inbox-finding-head-right { display: flex; gap: 6px; align-items: baseline; }
        .inbox-finding-rule { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: var(--bg-surface); border: 1px solid var(--border); color: var(--text-secondary); }
        .inbox-finding-level { font-size: 11px; color: var(--text-muted); }
        .inbox-finding-action { font-size: 11px; color: var(--accent); }
        .inbox-finding p { margin: 0; font-size: 12px; color: var(--text-secondary); line-height: 1.5; }
        .inbox-metric-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
          gap: 6px;
          margin-bottom: 10px;
        }
        .inbox-metric-card {
          padding: 7px 9px;
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--bg-surface);
          text-align: left;
          cursor: pointer;
          font-family: inherit;
          color: inherit;
          transition: background-color .12s, border-color .12s;
        }
        .inbox-metric-card:hover { background: var(--info-bg, rgba(79,70,229,.06)); border-color: var(--accent); }
        .inbox-metric-card:hover .inbox-metric-card-hint { color: var(--accent); }
        .inbox-metric-card.is-anomaly { border-left: 3px solid var(--red); }
        .inbox-metric-card.is-anomaly strong { color: var(--red); }
        .inbox-metric-card > span { display: block; font-size: 11px; color: var(--text-muted); }
        .inbox-metric-card > strong { font-size: 14px; color: var(--text-primary); display: block; margin-top: 1px; }
        .inbox-metric-card-hint {
          display: block;
          margin-top: 4px;
          font-size: 10px;
          font-style: normal;
          color: var(--text-faint);
          letter-spacing: 0.04em;
        }
        .inbox-metric-grid-wrap { margin-bottom: 10px; }
        .inbox-metric-hint {
          font-size: 11px;
          color: var(--text-muted);
          margin-bottom: 6px;
          padding: 4px 8px;
          border-left: 2px solid var(--accent);
          background: var(--info-bg, rgba(79,70,229,.06));
          border-radius: 0 4px 4px 0;
        }
        #inbox-metric-popover {
          position: fixed;
          top: 50%;
          right: 40px;
          transform: translateY(-50%);
          width: 360px;
          max-height: 480px;
          background: var(--bg-surface);
          border: 1px solid var(--border);
          border-radius: 10px;
          box-shadow: var(--shadow-md, 0 2px 12px rgba(0,0,0,.12));
          z-index: 200;
          padding: 0;
          overflow: hidden;
          display: none;
          flex-direction: column;
        }
        #inbox-metric-popover.is-open { display: flex; }
        .inbox-metric-popover-head {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 10px 14px;
          border-bottom: 1px solid var(--border);
          background: var(--bg-muted, var(--bg-surface));
        }
        .inbox-metric-popover-head strong { font-size: 14px; color: var(--text-primary); }
        .inbox-metric-popover-close {
          border: 1px solid var(--border);
          background: var(--bg-surface);
          color: var(--text-secondary);
          padding: 3px 10px;
          border-radius: 4px;
          font-size: 12px;
          cursor: pointer;
        }
        .inbox-metric-popover-body {
          padding: 12px 14px;
          overflow-y: auto;
          flex: 1;
          font-size: 12px;
          color: var(--text-secondary);
          line-height: 1.55;
        }
        .inbox-metric-popover-value {
          font-size: 22px;
          font-weight: 700;
          color: var(--text-primary);
          margin-bottom: 6px;
        }
        .inbox-metric-popover-value.is-anomaly { color: var(--red); }
        .inbox-metric-popover-note { margin: 0 0 10px; }
        .inbox-metric-popover-list {
          list-style: none;
          padding: 0;
          margin: 0 0 10px;
          border: 1px solid var(--border);
          border-radius: 6px;
          overflow: hidden;
        }
        .inbox-metric-popover-list li {
          display: flex;
          justify-content: space-between;
          padding: 6px 10px;
          border-bottom: 1px solid var(--border);
          font-size: 12px;
        }
        .inbox-metric-popover-list li:last-child { border-bottom: 0; }
        .inbox-metric-popover-list li span { font-family: ui-monospace, monospace; color: var(--text-primary); }
        .inbox-metric-popover-jump {
          width: 100%;
          padding: 7px 10px;
          background: var(--red-bg);
          color: var(--red);
          border: 1px solid var(--red);
          border-radius: 6px;
          font-size: 12px;
          cursor: pointer;
        }
        @media (max-width: 720px) {
          #inbox-metric-popover {
            top: auto;
            right: 12px;
            left: 12px;
            bottom: 12px;
            width: auto;
            transform: none;
          }
        }
        .inbox-skill-chain { margin-top: 8px; }
        .inbox-evidence-block {
          margin-top: 12px;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--bg-surface);
        }
        .inbox-evidence-block > summary {
          padding: 8px 12px;
          cursor: pointer;
          font-size: 13px;
          color: var(--text-primary);
          font-weight: 600;
          list-style: revert;
        }
        .inbox-evidence-block[open] > summary { border-bottom: 1px solid var(--border); }
        .inbox-evidence-grid {
          display: grid;
          grid-template-columns: minmax(0, .55fr) minmax(0, 1.45fr);
          gap: 12px;
          padding: 12px;
        }
        .inbox-evidence-grid h4 {
          font-size: 12px;
          margin: 6px 0 6px;
          color: var(--text-primary);
        }
        .inbox-evidence-grid h4:first-child { margin-top: 0; }
        @media (max-width: 960px) {
          .inbox-split { grid-template-columns: 1fr; }
          .inbox-left { border-right: 0; border-bottom: 1px solid var(--border); max-height: 50vh; }
          .inbox-right { max-height: none; }
          .inbox-evidence-grid { grid-template-columns: 1fr; }
        }
        body > * {
          max-width: 100vw !important;
        }
        .observe-report-root {
          font-size: 12px !important;
          line-height: 1.45;
        }
        .observe-report-root h1 { font-size: 20px !important; }
        .observe-report-root h2 { font-size: 14px !important; }
        .observe-report-root h3 { font-size: 12px !important; }
        .lang-toggle {
          top: auto !important;
          right: 16px !important;
          bottom: 16px !important;
          padding: 5px 10px !important;
          font-size: 11px !important;
          opacity: .72;
          z-index: 90;
        }
        .lang-toggle:hover { opacity: 1; }
        .observe-report-root table { font-size: 12px !important; }
        .observe-report-root th {
          font-size: 10.5px !important;
          padding: 7px 8px !important;
        }
        .observe-report-root td {
          font-size: 11.5px !important;
          padding: 7px 8px !important;
        }
        .observe-report-root button,
        .observe-report-root input {
          font-size: 12px !important;
        }
        .observe-report-root,
        .observe-report-root section,
        .observe-report-root details,
        .observe-report-root summary,
        .observe-report-root div,
        .observe-report-root article {
          min-width: 0;
        }
        .observe-report-root pre,
        .observe-report-root code {
          max-width: 100%;
        }
        .observe-table-wrap {
          width: 100%;
          max-width: 100%;
          min-width: 0;
          overflow-x: auto !important;
          overflow-y: visible;
          -webkit-overflow-scrolling: touch;
          overscroll-behavior-x: contain;
        }
`;
