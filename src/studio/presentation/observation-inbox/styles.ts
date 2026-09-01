export const OBSERVATION_INBOX_STYLES = `
        *,
        *::before,
        *::after {
          box-sizing: border-box;
        }
        html,
        body {
          width: 100vw !important;
          max-width: 100vw !important;
          margin: 0 !important;
          padding: 0 !important;
        }
        main {
          width: min(1440px, calc(100vw - 24px)) !important;
          max-width: 100% !important;
          margin: 0 auto !important;
          padding: 16px 12px 12px !important;
        }
        .inbox-shell {
          margin-top: 12px;
          background: transparent;
          border: 0;
          border-radius: 0;
          overflow: visible;
        }
        .inbox-topbar {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          justify-content: space-between;
          gap: 10px 14px;
          padding: 10px 14px;
          background: var(--bg-surface);
          border: 1px solid var(--border);
          border-radius: 10px;
          margin-bottom: 12px;
        }
        .inbox-topbar-meta {
          display: flex;
          flex-wrap: wrap;
          gap: 6px 14px;
          color: var(--text-muted);
          font-size: 12px;
          line-height: 1.5;
        }
        .inbox-chip-bar {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }
        .inbox-chip {
          padding: 4px 10px;
          border: 1px solid var(--border);
          background: var(--bg-surface);
          color: var(--text-secondary);
          font-size: 12px;
          border-radius: 999px;
          cursor: pointer;
          line-height: 1.5;
        }
        .inbox-chip:hover { color: var(--text-primary); border-color: var(--border-hover, var(--border)); }
        .inbox-chip.is-active {
          background: var(--accent);
          color: #fff;
          border-color: var(--accent);
        }
        .inbox-search-bar {
          display: grid;
          grid-template-columns: minmax(180px, 1fr) minmax(220px, 1.2fr) auto auto;
          align-items: end;
          gap: 8px;
          width: 100%;
        }
        .inbox-search-field {
          display: flex;
          flex-direction: column;
          gap: 4px;
          min-width: 0;
          color: var(--text-muted);
          font-size: 11px;
          line-height: 1.3;
        }
        .inbox-search-field input {
          width: 100%;
          min-width: 0;
          padding: 7px 9px;
          border: 1px solid var(--border);
          border-radius: 7px;
          background: var(--bg);
          color: var(--text-primary);
          font-size: 12px;
          outline: none;
        }
        .inbox-search-field input:focus {
          border-color: var(--accent);
          box-shadow: 0 0 0 2px rgba(37,99,235,.12);
        }
        .inbox-search-clear {
          padding: 7px 10px;
          border: 1px solid var(--border);
          border-radius: 7px;
          background: var(--bg-surface);
          color: var(--text-secondary);
          font-size: 12px;
          cursor: pointer;
        }
        .inbox-search-clear:hover { color: var(--text-primary); border-color: var(--border-hover, var(--border)); }
        .inbox-search-count {
          color: var(--text-muted);
          font-size: 12px;
          white-space: nowrap;
          padding-bottom: 8px;
        }
        .inbox-split {
          display: grid;
          grid-template-columns: minmax(240px, 280px) minmax(0, 1fr);
          gap: 12px;
          align-items: start;
        }
        .inbox-left {
          background: var(--bg-surface);
          border: 1px solid var(--border);
          border-radius: 10px;
          position: sticky;
          top: 12px;
          max-height: calc(100vh - 24px);
          overflow: auto;
        }
        .inbox-card-list {
          list-style: none;
          margin: 0;
          padding: 0;
        }
        .inbox-card {
          padding: 12px 14px;
          border-bottom: 1px solid var(--border);
          cursor: pointer;
          display: flex;
          flex-direction: column;
          gap: 6px;
          position: relative;
        }
        .inbox-card:hover { background: var(--bg-muted, rgba(0,0,0,.04)); }
        .inbox-card.is-active {
          background: var(--info-bg, rgba(79,70,229,.08));
        }
        .inbox-card.is-active::before {
          content: '';
          position: absolute;
          left: 0; top: 0; bottom: 0;
          width: 3px;
          background: var(--accent);
        }
        .inbox-card-empty {
          padding: 24px 16px;
          color: var(--text-muted);
          font-size: 12px;
          text-align: center;
        }
        .inbox-no-results {
          padding: 24px 16px;
          border: 1px solid var(--border);
          border-radius: 10px;
          background: var(--bg-surface);
          color: var(--text-muted);
          text-align: center;
          font-size: 13px;
        }
        .inbox-card-row { display: flex; align-items: center; gap: 8px; }
        .inbox-card-row-title { font-size: 13px; color: var(--text-primary); }
        .inbox-card-priority {
          width: 8px; height: 8px; border-radius: 50%;
          flex-shrink: 0;
          background: var(--text-faint);
        }
        .inbox-card.is-priority-high .inbox-card-priority { background: var(--red); }
        .inbox-card.is-priority-medium .inbox-card-priority { background: var(--yellow); }
        .inbox-card.is-priority-low .inbox-card-priority { background: var(--green); }
        .inbox-card-title {
          flex: 1;
          font-weight: 600;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .inbox-card-goal {
          padding-left: 16px;
          color: var(--text-primary);
          font-size: 12px;
          line-height: 1.45;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .inbox-card-story {
          padding-left: 16px;
          color: var(--text-secondary);
          font-size: 11px;
          line-height: 1.45;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .inbox-card-state {
          font-size: 11px;
          padding: 2px 6px;
          border-radius: 999px;
          flex-shrink: 0;
        }
        .inbox-card-state.is-agree { background: var(--green-bg); color: var(--green); }
        .inbox-card-state.is-reject { background: var(--red-bg); color: var(--red); }
        .inbox-card-state.is-note { background: var(--yellow-bg); color: var(--yellow); }
        .inbox-card-state.is-reviewed { background: var(--info-bg); color: var(--accent); }
        .inbox-card-dots {
          display: flex;
          gap: 4px;
        }
        .inbox-card-dot {
          width: 10px; height: 10px;
          border-radius: 50%;
          background: var(--border);
          display: inline-block;
        }
        .inbox-card-dot.is-ok { background: var(--green); }
        .inbox-card-dot.is-attention { background: var(--red); }
        .inbox-card-dot.is-unknown { background: var(--yellow); }
        .inbox-card-chips {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
        }
        .inbox-card-chip {
          font-size: 11px;
          padding: 2px 6px;
          border-radius: 4px;
          background: var(--bg-soft, rgba(0,0,0,.04));
          color: var(--text-secondary);
          line-height: 1.4;
        }
        .inbox-card-chip.is-attention { background: var(--red-bg); color: var(--red); }
        .inbox-card-meta {
          font-size: 11px;
          color: var(--text-muted);
          gap: 12px;
          flex-wrap: wrap;
        }
        .inbox-right {
          padding: 0;
          background: transparent;
          overflow: visible;
        }
        @media (max-width: 820px) {
          .inbox-search-bar {
            grid-template-columns: 1fr;
            align-items: stretch;
          }
          .inbox-search-count {
            padding-bottom: 0;
          }
        }
        .inbox-detail-pane { display: none; }
        .inbox-detail-pane.is-active { display: block; }
        .inbox-detail-empty-pane {
          padding: 24px;
          color: var(--text-muted);
          font-size: 13px;
          text-align: center;
        }
        .inbox-detail-actions {
          position: sticky;
          top: 0;
          z-index: 5;
          background: var(--bg-surface);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 10px 12px;
          margin-bottom: 12px;
          box-shadow: var(--shadow-sm, 0 1px 3px rgba(0,0,0,.06));
        }
        .inbox-detail-actions-row {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          gap: 10px;
          margin-bottom: 8px;
        }
        .inbox-detail-actions-title { font-size: 13px; color: var(--text-primary); }
        .inbox-detail-actions-meta { font-size: 11px; color: var(--text-muted); }
        .inbox-detail-actions-buttons { display: flex; gap: 6px; flex-wrap: wrap; }
        .inbox-action-button {
          padding: 4px 12px;
          border: 1px solid var(--border);
          background: var(--bg-surface);
          color: var(--text-secondary);
          font-size: 12px;
          border-radius: 4px;
          cursor: pointer;
        }
        .inbox-action-button:hover { color: var(--text-primary); border-color: var(--border-hover, var(--border)); }
        .inbox-action-button.is-active[data-inbox-verdict="real_issue"] { background: var(--green-bg); color: var(--green); border-color: var(--green); }
        .inbox-action-button.is-active[data-inbox-verdict="not_issue"] { background: var(--red-bg); color: var(--red); border-color: var(--red); }
        .inbox-action-button.is-active[data-inbox-verdict="needs_more_context"] { background: var(--yellow-bg); color: var(--yellow); border-color: var(--yellow); }
        .inbox-note-editor {
          margin-top: 8px;
          display: none;
        }
        .inbox-note-textarea {
          width: 100%;
          font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
          font-size: 12px;
          padding: 8px;
          border: 1px solid var(--border);
          border-radius: 4px;
          background: var(--bg-surface);
          color: var(--text-primary);
          resize: vertical;
          box-sizing: border-box;
        }
        .inbox-note-editor-buttons {
          margin-top: 6px;
          display: flex;
          gap: 6px;
          justify-content: flex-end;
        }
        .inbox-note-save,
        .inbox-note-cancel {
          padding: 4px 10px;
          font-size: 12px;
          border: 1px solid var(--border);
          background: var(--bg-surface);
          color: var(--text-secondary);
          border-radius: 4px;
          cursor: pointer;
        }
        .inbox-note-save { background: var(--accent); color: #fff; border-color: var(--accent); }
        .inbox-detail-empty {
          color: var(--text-muted);
          font-size: 12px;
          padding: 12px;
        }
        .timeline-row.is-flash,
        [data-message-uuid].is-flash {
          animation: inboxEvidenceFlash 1.6s ease-out;
        }
        @keyframes inboxEvidenceFlash {
          0% { background: var(--yellow-bg); }
          70% { background: var(--yellow-bg); }
          100% { background: transparent; }
        }
        .context-chain-nav {
          position: sticky;
          top: 0;
          z-index: 3;
          display: flex;
          gap: 6px;
          padding: 8px 10px;
          background: var(--bg-surface);
          border: 1px solid var(--border);
          border-radius: 8px;
          margin-bottom: 8px;
          font-size: 12px;
          align-items: center;
          flex-wrap: wrap;
        }
        .context-chain-nav a {
          padding: 4px 10px;
          color: var(--text-secondary);
          text-decoration: none;
          border-radius: 999px;
          border: 1px solid var(--border);
          background: var(--bg-surface);
          flex-shrink: 0;
        }
        .context-chain-nav a:hover { color: var(--accent); border-color: var(--accent); }
        .context-chain-nav-hint {
          margin-left: auto;
          color: var(--text-muted);
          font-size: 11px;
        }
        .runtime-step-list {
          list-style: none;
          padding: 0;
          margin: 0;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .runtime-step {
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--bg-surface);
        }
        .runtime-step.runtime-passed { border-left: 3px solid var(--green); }
        .runtime-step.runtime-attention { border-left: 3px solid var(--red); }
        .runtime-step.runtime-manual_review { border-left: 3px solid var(--yellow); }
        .runtime-step.is-depth-1,
        .runtime-rule-node.is-depth-1 {
          margin-left: 18px;
        }
        .runtime-step.is-depth-2,
        .runtime-rule-node.is-depth-2 {
          margin-left: 34px;
        }
        .runtime-step.is-depth-3,
        .runtime-rule-node.is-depth-3 {
          margin-left: 50px;
        }
        .runtime-step.is-depth-1 .runtime-step-index,
        .runtime-rule-node.is-depth-1 .runtime-rule-node-head span {
          opacity: .78;
        }
        .runtime-step-head {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 10px;
          font-size: 12px;
        }
        .runtime-step-index {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 38px;
          height: 20px;
          padding: 0 6px;
          background: var(--bg-muted, rgba(0,0,0,.04));
          color: var(--text-secondary);
          font-size: 11px;
          border-radius: 4px;
          flex-shrink: 0;
        }
        .runtime-step-name { flex: 1; color: var(--text-primary); min-width: 0; }
        .runtime-step-state { font-size: 14px; flex-shrink: 0; }
        .runtime-step-detail { border-top: 1px solid var(--border); padding: 0 10px 8px; }
        .runtime-step-detail > summary {
          padding: 6px 0;
          cursor: pointer;
          font-size: 11px;
          color: var(--text-muted);
          list-style: revert;
        }
        .runtime-step-detail > summary:hover { color: var(--text-primary); }
        .runtime-step-detail-body { font-size: 12px; color: var(--text-secondary); line-height: 1.5; }
        .runtime-step-detail-body code { font-size: 11px; padding: 1px 4px; background: var(--bg-muted, rgba(0,0,0,.04)); border-radius: 3px; }
        .runtime-step-detail-body p { margin: 4px 0 0; }
        .runtime-step-detail-body ul { margin: 4px 0 0; padding-left: 18px; }
        .runtime-rule-lite {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .runtime-rule-three-col {
          display: grid;
          grid-template-columns: minmax(220px, 1fr) minmax(220px, 1fr) minmax(220px, 1fr);
          gap: 10px;
          align-items: stretch;
        }
        .runtime-rule-column {
          min-width: 0;
          height: 420px;
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--bg-surface);
          padding: 9px;
          overflow: auto;
        }
        .runtime-rule-column h5 {
          margin: 0 0 8px;
          font-size: 12px;
          color: var(--text-primary);
        }
        .runtime-rule-column h6 {
          margin: 0 0 6px;
          font-size: 11px;
          color: var(--text-secondary);
        }
        .runtime-rule-column-hint {
          margin: -2px 0 8px;
          color: var(--text-muted);
          font-size: 10px;
          line-height: 1.4;
        }
        .runtime-rule-column-group + .runtime-rule-column-group {
          margin-top: 12px;
          padding-top: 10px;
          border-top: 1px solid var(--border);
        }
        .runtime-rule-flow-block {
          display: grid;
          gap: 7px;
        }
        .runtime-rule-flow-block + .runtime-rule-flow-block {
          margin-top: 10px;
        }
        .runtime-rule-flow-title {
          display: grid;
          gap: 2px;
          color: var(--text-primary);
          font-size: 11px;
          font-weight: 650;
        }
        .runtime-rule-flow-title span {
          color: var(--text-muted);
          font-size: 10px;
          font-weight: 500;
        }
        .runtime-rule-node-list {
          list-style: none;
          margin: 0;
          padding: 0;
          display: grid;
          gap: 7px;
        }
        .runtime-rule-node {
          position: relative;
          display: grid;
          gap: 4px;
          padding: 7px 8px 7px 20px;
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--bg-muted, rgba(0,0,0,.03));
        }
        .runtime-rule-node::before {
          content: '';
          position: absolute;
          left: 8px;
          top: 12px;
          bottom: -9px;
          width: 1px;
          background: var(--border);
        }
        .runtime-rule-node::after {
          content: '';
          position: absolute;
          left: 5px;
          top: 12px;
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: var(--text-muted);
        }
        .runtime-rule-node.is-hit {
          border-color: var(--accent);
          background: var(--bg-surface);
        }
        .runtime-rule-node.is-hit::after {
          background: var(--accent);
        }
        .runtime-rule-node.is-attention {
          border-color: rgba(185, 28, 28, .35);
          background: rgba(185, 28, 28, .04);
        }
        .runtime-rule-node.is-attention::after {
          background: #b91c1c;
        }
        .runtime-rule-node-head {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr) auto;
          gap: 6px;
          align-items: start;
        }
        .runtime-rule-node-head span,
        .runtime-rule-node-head em {
          color: var(--text-muted);
          font-size: 10px;
          font-style: normal;
          white-space: nowrap;
        }
        .runtime-rule-node-head strong {
          color: var(--text-primary);
          font-size: 11px;
          line-height: 1.35;
          font-weight: 650;
        }
        .runtime-rule-node p {
          margin: 0;
          color: var(--text-muted);
          font-size: 10px;
          line-height: 1.4;
        }
        .runtime-rule-node-evidence {
          color: var(--text-muted);
          font-size: 10px;
        }
        .runtime-rule-node-evidence summary {
          cursor: pointer;
          color: var(--text-secondary);
          font-size: 10px;
        }
        .runtime-rule-node-evidence ul {
          margin: 4px 0 0;
          padding-left: 16px;
        }
        .runtime-rule-source-hints {
          display: grid;
          gap: 3px;
          color: var(--text-muted);
          font-size: 10px;
        }
        .runtime-rule-source-hints span {
          color: var(--text-secondary);
          font-weight: 650;
        }
        .runtime-rule-source-hints ul,
        .runtime-rule-node-model ul {
          margin: 0;
          padding-left: 15px;
        }
        .runtime-rule-match-spec {
          color: var(--text-secondary) !important;
        }
        .runtime-rule-execution-list {
          margin-top: 6px;
        }
        .runtime-rule-execution-item.is-hit {
          border-left: 3px solid var(--green);
        }
        .runtime-rule-execution-item.is-attention {
          border-left: 3px solid var(--red);
        }
        .runtime-rule-node-model {
          margin-top: 6px;
          padding: 6px 7px;
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--bg-surface);
        }
        .runtime-rule-node-model strong {
          display: block;
          color: var(--text-primary);
          font-size: 10px;
          margin-bottom: 3px;
        }
        .runtime-rule-node-model.is-muted {
          color: var(--text-muted);
        }
        .runtime-rule-node-model-detail {
          margin-top: 3px;
          color: var(--text-muted);
          font-size: 10px;
        }
        .runtime-rule-node-model-detail summary {
          cursor: pointer;
          color: var(--text-secondary);
          list-style: none;
        }
        .runtime-rule-node-model-detail summary::-webkit-details-marker {
          display: none;
        }
        .runtime-rule-node-model-detail div {
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
          margin-top: 3px;
        }
        .runtime-rule-node-model-detail[open] div {
          display: block;
          overflow: visible;
        }
        .runtime-rule-node-model-detail p {
          margin: 0 0 3px;
        }
        .runtime-node-model-failed,
        .runtime-node-model-degraded {
          border-color: rgba(185, 28, 28, .25);
          background: rgba(185, 28, 28, .04);
        }
        .runtime-node-model-passed {
          border-color: rgba(37, 99, 235, .25);
          background: rgba(37, 99, 235, .04);
        }
        .runtime-rule-source-path {
          font-size: 11px;
          color: var(--text-muted);
          margin-bottom: 6px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .runtime-rule-source {
          max-height: 360px;
          overflow: auto;
          margin: 0;
          padding: 8px;
          border: 1px solid var(--border);
          border-radius: 5px;
          background: var(--bg-muted, rgba(0,0,0,.04));
          color: var(--text-secondary);
          font-size: 11px;
          line-height: 1.45;
          white-space: pre-wrap;
        }
        .runtime-rule-breakdown-item {
          position: relative;
          border: 1px solid var(--border);
          border-radius: 5px;
          padding: 6px 7px 6px 20px;
          background: var(--bg-muted, rgba(0,0,0,.03));
        }
        .runtime-rule-breakdown-item::before {
          content: '';
          position: absolute;
          left: 8px;
          top: 10px;
          bottom: -8px;
          width: 1px;
          background: var(--border);
        }
        .runtime-rule-breakdown-item::after {
          content: '';
          position: absolute;
          left: 5px;
          top: 11px;
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: var(--text-muted);
        }
        .runtime-rule-breakdown-item.is-model::after {
          background: var(--accent);
        }
        .runtime-rule-breakdown-item + .runtime-rule-breakdown-item {
          margin-top: 6px;
        }
        .runtime-rule-breakdown-item strong {
          display: block;
          font-size: 11px;
          margin-bottom: 3px;
        }
        .runtime-rule-breakdown-item p {
          margin: 0 0 4px;
          font-size: 10px;
          color: var(--text-muted);
        }
        .runtime-rule-breakdown-item ol {
          margin: 0;
          padding: 0;
          list-style: none;
          display: flex;
          flex-direction: column;
          gap: 3px;
        }
        .runtime-rule-breakdown-item li {
          display: flex;
          gap: 5px;
          font-size: 10px;
          color: var(--text-secondary);
          line-height: 1.35;
        }
        .runtime-rule-breakdown-item li span {
          flex-shrink: 0;
          width: 16px;
          height: 16px;
          border: 1px solid var(--border);
          border-radius: 50%;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 9px;
          color: var(--text-muted);
          background: var(--bg-surface);
        }
        .runtime-rule-breakdown-list {
          margin: 0;
          padding: 0;
          list-style: none;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .runtime-rule-breakdown-list li {
          border: 1px solid var(--border);
          border-radius: 5px;
          padding: 7px;
          background: var(--bg-muted, rgba(0,0,0,.03));
        }
        .runtime-rule-breakdown-list strong,
        .runtime-rule-breakdown-list span {
          display: block;
          font-size: 10px;
          line-height: 1.35;
        }
        .runtime-rule-model-list {
          display: grid;
          gap: 6px;
          margin-top: 6px;
        }
        .runtime-rule-model-list > em {
          color: var(--text-muted);
          font-style: normal;
          font-size: 10px;
        }
        .runtime-rule-breakdown-list span {
          margin-top: 3px;
          color: var(--text-muted);
        }
        @media (max-width: 1100px) {
          .runtime-rule-three-col {
            grid-template-columns: 1fr;
          }
        }
        .runtime-rule-lite-notice {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          font-size: 12px;
          color: var(--text-secondary);
        }
        .runtime-rule-lite-notice span {
          border: 1px solid var(--border);
          border-radius: 5px;
          background: var(--bg-muted, rgba(0,0,0,.04));
          padding: 4px 7px;
        }
        .runtime-rule-lite-section h5 {
          margin: 0 0 6px;
          font-size: 12px;
          font-weight: 650;
          color: var(--text-primary);
        }
        .inbox-rule-flow-overview .runtime-step {
          border-left: 1px solid var(--border);
          box-shadow: none;
        }
        .inbox-rule-flow-overview .runtime-step.runtime-passed,
        .inbox-rule-flow-overview .runtime-step.runtime-attention,
        .inbox-rule-flow-overview .runtime-step.runtime-manual_review {
          border-left-color: var(--border);
        }
        .inbox-rule-flow-overview .runtime-step-state {
          width: 18px;
          height: 18px;
          border: 1px solid var(--border);
          border-radius: 50%;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 11px;
          color: var(--text-secondary);
          background: var(--bg-surface);
        }
        .inbox-detail-header {
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
        .experience-layer-scroll {
          max-height: 80vh;
          overflow: auto !important;
          overscroll-behavior: contain;
        }
        .experience-top-insight {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin: 0 0 12px;
          padding: 10px 12px;
          border: 1px solid rgba(202,138,4,.40);
          border-radius: 8px;
          background: rgba(202,138,4,.10);
          color: var(--text-secondary);
          font-size: 12px;
          line-height: 1.5;
        }
        .experience-top-insight strong {
          margin-right: 8px;
          color: #a16207;
          font-weight: 750;
        }
        .experience-insight-cta,
        .review-inline-cta {
          border: 1px solid rgba(37,99,235,.30);
          border-radius: 999px;
          background: var(--accent);
          color: #fff;
          cursor: pointer;
          font-weight: 750;
          white-space: nowrap;
        }
        .experience-insight-cta {
          padding: 5px 10px;
          font-size: 12px;
        }
        .review-inline-cta {
          margin-top: 4px;
          padding: 2px 6px;
          font-size: 10px !important;
          line-height: 1.25;
        }
        .experience-insight-cta:hover,
        .review-inline-cta:hover {
          filter: brightness(.96);
        }
        .observe-fit-table,
        #observe-tab-review table,
        #observe-tab-raw table {
          width: 100% !important;
          table-layout: fixed;
        }
        .review-bucket-table { min-width: 980px !important; }
        .experience-skill-table { min-width: 1760px !important; }
        .experience-session-table { min-width: 1680px !important; }
        .skill-health-table { min-width: 1360px !important; }
        .action-table { min-width: 820px !important; }
        .raw-observation-table { min-width: 1040px !important; }
        .scoring-guide-table { min-width: 720px !important; }
        .observe-fit-table col,
        #observe-tab-review col,
        #observe-tab-raw col {
          width: auto !important;
        }
        .experience-skill-table col:nth-child(1) { width: 11% !important; }
        .experience-skill-table col:nth-child(2) { width: 4% !important; }
        .experience-skill-table col:nth-child(3) { width: 4% !important; }
        .experience-skill-table col:nth-child(4) { width: 4% !important; }
        .experience-skill-table col:nth-child(5) { width: 25% !important; }
        .experience-skill-table col:nth-child(6) { width: 34% !important; }
        .experience-skill-table col:nth-child(7) { width: 13% !important; }
        .experience-skill-table col:nth-child(8) { width: 5% !important; }
        .experience-session-table col:nth-child(1) { width: 12% !important; }
        .experience-session-table col:nth-child(2) { width: 12% !important; }
        .experience-session-table col:nth-child(3) { width: 10% !important; }
        .experience-session-table col:nth-child(4) { width: 16% !important; }
        .experience-session-table col:nth-child(5) { width: 14% !important; }
        .experience-session-table col:nth-child(6) { width: 10% !important; }
        .experience-session-table col:nth-child(7) { width: 20% !important; }
        .experience-session-table col:nth-child(8) { width: 6% !important; }
        .session-time-cell {
          min-width: 300px;
          line-height: 1.45;
        }
        .session-time-cell div:first-child {
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
          color: var(--text-secondary);
          word-break: keep-all;
          overflow-wrap: normal;
        }
        .observe-fit-table th,
        .observe-fit-table td,
        #observe-tab-review table th,
        #observe-tab-review table td,
        #observe-tab-raw table th,
        #observe-tab-raw table td {
          overflow-wrap: anywhere;
          word-break: break-word;
          min-width: 0;
          white-space: normal;
        }
	        #signal-global-tooltip {
	          position: fixed;
	          z-index: 9999;
          display: none;
          width: min(360px, calc(100vw - 32px));
          padding: 10px 12px;
          background: var(--bg-surface);
          border: 1px solid var(--border);
          border-radius: 6px;
          box-shadow: 0 8px 24px rgba(0,0,0,.18);
          color: var(--text-primary);
          font-size: 12px;
          line-height: 1.5;
          white-space: normal;
	          pointer-events: none;
	          font-family: system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;
	        }
	        #timeline-fulltext-tooltip {
	          position: fixed;
	          z-index: 2147483000;
	          display: none;
	          inset: 0;
	          align-items: center;
	          justify-content: center;
	          padding: 24px;
	          background: rgba(15,23,42,.32);
	          color: var(--text-primary);
	        }
	        #timeline-fulltext-tooltip.is-open {
	          display: flex;
        }
	        #timeline-fulltext-tooltip .timeline-fulltext-dialog {
	          width: min(860px, calc(100vw - 48px));
	          max-height: min(82vh, 760px);
	          background: var(--bg-surface);
	          border: 1px solid var(--border);
	          border-radius: 10px;
	          box-shadow: 0 24px 72px rgba(15,23,42,.45);
	          display: flex;
	          flex-direction: column;
	          overflow: hidden;
	          opacity: 1;
	          isolation: isolate;
        }
	        #timeline-fulltext-tooltip .timeline-fulltext-header {
	          display: flex;
	          align-items: center;
	          justify-content: space-between;
	          gap: 12px;
	          padding: 12px 14px;
	          border-bottom: 1px solid var(--border);
	          font-family: system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;
	          background: var(--bg-muted);
	        }
	        #timeline-fulltext-tooltip strong {
	          display: block;
	          margin: 0;
	          color: var(--text-primary);
	          font-family: system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;
	          font-size: 12px;
	        }
	        #timeline-fulltext-tooltip .timeline-fulltext-close {
	          flex: 0 0 auto;
	          border: 1px solid var(--border);
	          border-radius: 6px;
	          background: var(--bg);
	          color: var(--text-secondary);
	          padding: 4px 9px;
	          cursor: pointer;
	          font-size: 12px;
	        }
	        #timeline-fulltext-tooltip .timeline-fulltext-body {
	          flex: 1 1 auto;
	          min-height: 0;
	          overflow: auto;
	          padding: 14px 16px;
	          white-space: pre-wrap;
	          word-break: break-word;
	          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	          font-size: 11px;
	          line-height: 1.58;
        }
        #experience-detail-modal {
          position: fixed;
          z-index: 2147482000;
          display: none;
          inset: 0;
          align-items: center;
          justify-content: center;
          padding: 24px;
          background: rgba(15,23,42,.32);
        }
        #experience-detail-modal.is-open {
          display: flex;
        }
        #experience-detail-modal .experience-detail-dialog {
          width: min(1180px, calc(100vw - 48px));
          height: min(86vh, 900px);
          display: flex;
          flex-direction: column;
          background: var(--bg-surface);
          border: 1px solid var(--border);
          border-radius: 10px;
          box-shadow: 0 24px 72px rgba(15,23,42,.45);
          overflow: hidden;
        }
        #experience-detail-modal .experience-detail-modal-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 12px 14px;
          border-bottom: 1px solid var(--border);
          background: var(--bg-muted);
        }
        #experience-detail-modal .experience-detail-modal-title {
          min-width: 0;
          font-size: 13px;
          font-weight: 650;
          color: var(--text-primary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        #experience-detail-modal .experience-detail-modal-close {
          flex: 0 0 auto;
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--bg);
          color: var(--text-secondary);
          padding: 4px 9px;
          cursor: pointer;
          font-size: 12px;
        }
        #experience-detail-modal .experience-detail-modal-body {
          flex: 1 1 auto;
          min-height: 0;
          overflow: hidden;
          padding: 0;
        }
        #experience-detail-modal .experience-detail-shell {
          height: 100%;
          max-height: 100%;
          min-height: 0;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .context-chain-button {
          display: inline-flex;
          flex-direction: column;
          align-items: center;
          gap: 2px;
          border: 1px solid rgba(37,99,235,.28);
          background: rgba(37,99,235,.09);
          color: var(--accent);
          border-radius: 7px;
          padding: 5px 7px;
          font-size: 11px;
          font-weight: 700;
          cursor: pointer;
          white-space: nowrap;
          max-width: 100%;
        }
        .context-chain-button > span {
          max-width: 100%;
        }
        .context-chain-button:hover {
          background: rgba(37,99,235,.14);
        }
        .context-chain-button.has-advisory {
          border-color: rgba(202,138,4,.40);
          background: rgba(202,138,4,.10);
          color: #a16207;
        }
        .context-chain-button.has-advisory:hover {
          background: rgba(202,138,4,.18);
        }
        .context-chain-button-icon {
          font-size: 12px;
          line-height: 1;
        }
        .context-chain-button-main {
          display: inline-flex;
          align-items: center;
          gap: 3px;
        }
        .context-chain-button-ok {
          display: block;
          max-width: 100%;
          overflow: hidden;
          text-overflow: ellipsis;
          color: var(--text-muted);
          font-size: 10px;
          font-weight: 650;
          line-height: 1.2;
        }
        .context-chain-button-advisory-list {
          display: flex;
          flex-direction: column;
          gap: 1px;
          max-width: 100%;
          min-width: 0;
        }
        .context-chain-button-advisory {
          display: block;
          max-width: 100%;
          overflow: hidden;
          text-overflow: ellipsis;
          font-size: 10px;
          font-weight: 650;
          line-height: 1.2;
          color: #a16207;
        }
        .context-chain-button-ok {
          color: var(--green);
        }
        .context-chain-grid {
          height: 100%;
          min-height: 0;
          display: grid;
          grid-template-columns: minmax(280px,1.1fr) minmax(260px,.95fr) minmax(240px,.85fr) minmax(260px,.95fr);
          gap: 12px;
          overflow: auto;
        }
        .context-chain-panel {
          min-width: 0;
          min-height: 0;
          overflow: auto;
          border: 1px solid var(--border);
          border-radius: 9px;
          background: var(--bg-surface);
          padding: 12px;
          color: var(--text-secondary);
        }
        .context-chain-panel h3 {
          margin: 0 0 9px;
          color: var(--text-primary);
          font-size: 13px;
        }
        .context-chain-panel h4 {
          margin: 12px 0 6px;
          color: var(--text-primary);
          font-size: 12px;
        }
        .context-chain-panel pre {
          margin: 6px 0 0;
          padding: 10px;
          max-height: 420px;
          overflow: auto;
          white-space: pre-wrap;
          word-break: break-word;
          border: 1px solid var(--border);
          border-radius: 7px;
          background: var(--bg-muted);
          color: var(--text-primary);
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 11px;
          line-height: 1.55;
        }
        .skill-md-source {
          position: relative;
        }
        .skill-md-highlight {
          border-radius: 3px;
          padding: 0 2px;
          box-decoration-break: clone;
          -webkit-box-decoration-break: clone;
          text-decoration: underline;
          text-decoration-thickness: 2px;
          text-underline-offset: 3px;
        }
        .skill-md-highlight-rule {
          background: rgba(245, 158, 11, .16);
          text-decoration-color: rgba(217, 119, 6, .75);
        }
        .skill-md-highlight-workflow {
          background: rgba(14, 165, 233, .14);
          text-decoration-color: rgba(2, 132, 199, .75);
        }
        .skill-md-annotation {
          display: grid;
          grid-template-columns: 22px minmax(0,1fr);
          gap: 7px;
          align-items: start;
          margin: 4px 0 7px;
          padding: 6px 8px;
          border: 1px solid rgba(107,114,128,.45);
          border-left: 3px solid var(--accent);
          border-radius: 7px;
          background: var(--bg-surface);
          color: var(--text-secondary);
          font-family: system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;
          font-size: 11px;
          line-height: 1.45;
          white-space: normal;
        }
        .skill-md-annotation.is-confirmed {
          border-color: rgba(34, 197, 94, .45);
          border-left-color: var(--green);
          background: rgba(34, 197, 94, .08);
        }
        .skill-md-annotation.is-rejected {
          opacity: .62;
          border-color: rgba(239, 68, 68, .35);
          border-left-color: var(--red);
          background: rgba(239, 68, 68, .06);
        }
        .soft-standard-modal-item.is-confirmed {
          border-color: rgba(34, 197, 94, .45);
          border-left: 3px solid var(--green);
          background: rgba(34, 197, 94, .08);
        }
        .soft-standard-modal-item.is-rejected {
          opacity: .62;
          border-color: rgba(239, 68, 68, .35);
          border-left: 3px solid var(--red);
          background: rgba(239, 68, 68, .06);
        }
        .skill-md-annotation-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 20px;
          min-height: 20px;
          font-size: 16px;
          line-height: 1;
        }
        .skill-md-annotation-content {
          min-width: 0;
          display: block;
        }
        .skill-md-annotation-actions {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 5px;
          margin-top: 5px;
        }
        .skill-md-annotation-actions span {
          color: var(--text-muted);
          font-size: 10px;
        }
        .skill-md-annotation-actions button,
        .soft-standard-actions button {
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--bg);
          color: var(--text-secondary);
          padding: 3px 7px;
          font-size: 11px;
          cursor: pointer;
        }
        .skill-md-annotation-actions button:hover,
        .soft-standard-actions button:hover {
          border-color: var(--accent);
          color: var(--text-primary);
        }
        .skill-md-unlocated {
          margin-top: 8px;
          border: 1px solid var(--border);
          border-radius: 7px;
          background: var(--bg-muted);
          padding: 8px 10px;
        }
        .skill-md-unlocated summary {
          cursor: pointer;
          color: var(--text-secondary);
          font-size: 12px;
          font-weight: 650;
        }
        .standard-checklist,
        .workflow-line-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .standard-check-item {
          display: grid;
          grid-template-columns: 24px minmax(0,1fr);
          gap: 8px;
          padding: 9px;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--bg-muted);
        }
        .standard-check-marker {
          width: 20px;
          height: 20px;
          border-radius: 6px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: rgba(34, 197, 94, .12);
          color: var(--green);
          font-size: 12px;
          font-weight: 800;
        }
        .standard-check-body {
          min-width: 0;
        }
        .standard-check-title {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .standard-check-title strong {
          color: var(--text-primary);
          font-size: 12px;
          line-height: 1.4;
        }
        .standard-check-expectation {
          margin-top: 5px;
          color: var(--text-muted);
          font-size: 11px;
          line-height: 1.45;
        }
        .workflow-line {
          padding: 9px;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--bg-muted);
        }
        .workflow-line-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .workflow-line-head strong {
          color: var(--text-primary);
          font-size: 12px;
        }
        .workflow-line-head span,
        .workflow-line-desc {
          color: var(--text-muted);
          font-size: 11px;
        }
        .workflow-line-desc {
          margin-top: 4px;
          line-height: 1.45;
        }
        .workflow-node-line {
          position: relative;
          display: flex;
          flex-direction: column;
          gap: 7px;
          margin-top: 8px;
          padding-left: 12px;
        }
        .workflow-node-line::before {
          content: "";
          position: absolute;
          left: 21px;
          top: 12px;
          bottom: 12px;
          width: 1px;
          background: var(--border);
        }
        .workflow-node {
          position: relative;
          display: grid;
          grid-template-columns: 22px minmax(0,1fr);
          gap: 8px;
          align-items: start;
        }
        .workflow-node-index {
          z-index: 1;
          width: 20px;
          height: 20px;
          border-radius: 999px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: var(--accent);
          color: white;
          font-size: 10px;
          font-weight: 800;
        }
        .workflow-node-card {
          display: flex;
          flex-direction: column;
          gap: 3px;
          padding: 6px 7px;
          border: 1px solid rgba(107,114,128,.35);
          border-radius: 7px;
          background: var(--bg-surface);
        }
        .workflow-node-card strong {
          color: var(--text-primary);
          font-size: 12px;
          line-height: 1.35;
        }
        .workflow-node-card span {
          color: var(--text-secondary);
          font-size: 11px;
          line-height: 1.45;
        }
        .probe-anomaly {
          padding: 9px 10px;
          border: 1px solid rgba(202, 138, 4, .35);
          border-radius: 8px;
          background: rgba(202, 138, 4, .08);
        }
        .probe-anomaly strong,
        .probe-anomaly span {
          display: block;
        }
        .probe-anomaly strong {
          color: #a16207;
          font-size: 12px;
        }
        .probe-anomaly span {
          margin-top: 4px;
          color: var(--text-secondary);
          font-size: 11px;
          line-height: 1.45;
        }
        .probe-log {
          margin-top: 12px;
          border-top: 1px solid var(--border);
          padding-top: 9px;
        }
        .probe-log summary {
          cursor: pointer;
          color: var(--text-primary);
          font-size: 12px;
          font-weight: 700;
        }
        .review-log-meta {
          display: grid;
          gap: 5px;
          padding: 8px 9px;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--bg-muted);
          color: var(--text-muted);
          font-size: 11px;
          line-height: 1.4;
        }
        .review-log-group {
          margin-top: 10px;
        }
        .review-log-group h4 {
          margin-bottom: 5px;
        }
        .review-log-group ul {
          margin-left: 0;
          list-style: none;
        }
        .review-log-group li {
          padding: 6px 7px;
          border: 1px solid var(--border);
          border-radius: 7px;
          background: var(--bg-muted);
        }
        .review-log-group li span {
          display: block;
          color: var(--text-muted);
          font-size: 10px;
          margin-bottom: 2px;
        }
        .review-log-group li strong {
          display: block;
          color: var(--text-primary);
          font-size: 11px;
          line-height: 1.4;
        }
        .context-chain-panel ol,
        .context-chain-panel ul {
          margin: 6px 0 0 18px;
          padding: 0;
        }
        .context-chain-panel li {
          margin: 0 0 8px;
          font-size: 12px;
          line-height: 1.5;
        }
        .skill-chain-advisory {
          margin: 6px 0 0;
          padding: 10px 12px;
          border: 1px solid rgba(202, 138, 4, .35);
          border-radius: 8px;
          background: rgba(202, 138, 4, .08);
          color: var(--text-secondary);
          font-size: 12px;
          line-height: 1.55;
        }
        .skill-chain-advisory-message {
          color: var(--text-primary);
          font-weight: 600;
        }
        .skill-chain-advisory-example {
          margin-top: 6px;
        }
        .skill-chain-advisory-example > summary {
          cursor: pointer;
          color: var(--accent);
          font-size: 11px;
          font-weight: 600;
          list-style: none;
          user-select: none;
        }
        .skill-chain-advisory-example > summary::marker { content: ''; }
        .skill-chain-advisory-example > summary::-webkit-details-marker { display: none; }
        .skill-chain-advisory-example > summary::before {
          content: '▸ ';
          display: inline-block;
          margin-right: 2px;
        }
        .skill-chain-advisory-example[open] > summary::before { content: '▾ '; }
        .skill-chain-advisory-example pre {
          margin: 6px 0 0;
          padding: 10px;
          max-height: 280px;
          overflow: auto;
          white-space: pre;
          word-break: keep-all;
	          border: 1px solid var(--border);
	          border-radius: 7px;
	          background: var(--bg-muted);
	          color: var(--text-primary);
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 11px;
          line-height: 1.55;
        }
        .skill-chain-advisory-cmd-wrap {
          margin-top: 8px;
        }
        .skill-chain-advisory-cmd-label {
          font-size: 11px;
          color: var(--text-muted);
          margin-bottom: 4px;
        }
        .skill-chain-advisory-cmd-row {
          display: flex;
          align-items: stretch;
          gap: 6px;
        }
        .skill-chain-advisory-cmd {
          flex: 1;
          padding: 6px 8px;
          border-radius: 6px;
	          border: 1px solid var(--border);
	          background: var(--bg-muted);
	          color: var(--text-primary);
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 11px;
          line-height: 1.4;
          overflow-x: auto;
          white-space: nowrap;
        }
        .skill-chain-advisory-copy-btn {
          padding: 4px 10px;
          border-radius: 6px;
          border: 1px solid var(--border);
          background: var(--bg-surface);
          color: var(--text-primary);
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
        }
        .skill-chain-advisory-copy-btn:hover {
          background: rgba(37,99,235,.10);
          border-color: rgba(37,99,235,.30);
          color: var(--accent);
        }
        .skill-chain-advisory-copy-btn.is-copied {
          background: rgba(34,197,94,.10);
          border-color: rgba(34,197,94,.32);
          color: var(--green);
        }
        .assistive-advisory-row {
          margin-top: 5px;
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
        }
        .assistive-advisory-chip {
          display: inline-flex;
          align-items: center;
          padding: 1px 6px;
          border-radius: 5px;
          background: rgba(202,138,4,.10);
          border: 1px solid rgba(202,138,4,.28);
          color: #a16207;
          font-size: 10px;
          line-height: 1.5;
          white-space: nowrap;
        }
        .context-chain-panel small,
        .context-muted,
        .context-meta {
          color: var(--text-muted);
          font-size: 12px;
          line-height: 1.5;
        }
        .context-chain-panel table {
          width: 100%;
          border-collapse: collapse;
          font-size: 12px;
        }
        .context-chain-panel th,
        .context-chain-panel td {
          padding: 8px 7px;
	          border-bottom: 1px solid var(--border);
          text-align: left;
          vertical-align: top;
        }
        .context-chain-panel th {
          color: var(--text-primary);
          white-space: nowrap;
        }
        .context-runtime-placeholder {
          margin-top: 10px;
          padding: 12px;
	          border: 1px dashed var(--border);
          border-radius: 8px;
          color: var(--text-muted);
          text-align: center;
        }
        .runtime-check {
	          border-left: 3px solid var(--border);
          padding-left: 8px;
        }
        .runtime-passed { border-left-color: #16a34a; }
        .runtime-attention { border-left-color: #dc2626; }
        .runtime-manual_review { border-left-color: #2563eb; }
        .runtime-check-status {
          display: inline-flex;
          margin-left: 6px;
          padding: 1px 6px;
          border-radius: 999px;
          background: rgba(107,114,128,.14);
          color: var(--text-muted);
          font-size: 10px;
          font-weight: 700;
        }
        .openclaw-source-meta {
          margin-top: 4px;
          padding-top: 4px;
          border-top: 1px dashed var(--border);
          color: var(--text-muted);
        }
        .timeline-scope-notice {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 10px;
          margin: 0 0 8px;
          padding: 9px 10px;
          border: 1px solid rgba(202,138,4,.32);
          border-radius: 8px;
          background: rgba(202,138,4,.08);
          color: var(--text-secondary);
          font-size: 11px;
          line-height: 1.45;
        }
        .timeline-scope-notice strong {
          display: block;
          color: var(--yellow);
          font-size: 12px;
          margin-bottom: 2px;
        }
        .timeline-scope-notice span {
          display: block;
        }
        .timeline-scope-notice button {
          flex: 0 0 auto;
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--bg);
          color: var(--text-secondary);
          padding: 5px 9px;
          cursor: pointer;
          font-size: 12px;
          white-space: nowrap;
        }
        .timeline-filter-toolbar {
          display: flex;
          align-items: center;
          gap: 8px;
          margin: 0 0 8px;
          padding: 8px 10px;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--bg-muted);
          color: var(--text-secondary);
          font-size: 11px;
        }
        .timeline-filter-toolbar label {
          flex: 0 0 auto;
          color: var(--text-muted);
          font-weight: 700;
        }
        .timeline-filter-toolbar select {
          min-width: 190px;
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--bg);
          color: var(--text-primary);
          padding: 5px 8px;
          font-size: 12px;
        }
        .timeline-filter-toolbar span {
          min-width: 0;
          color: var(--text-muted);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .experience-detail-right [data-timeline-view] {
          flex: 1 1 auto;
          min-height: 0;
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }
	        .timeline-snippet[data-timeline-fulltext].is-overflowing {
	          cursor: pointer;
	        }
	        .timeline-snippet.is-detail-open {
	          outline: 1px solid rgba(37,99,235,.55);
	          outline-offset: -1px;
	        }
        #observe-tab-review table td,
        #observe-tab-review table th,
        #observe-tab-raw table td,
        #observe-tab-raw table th {
          vertical-align: top;
        }
        #observe-tab-review table td,
        #observe-tab-raw table td {
          text-align: left;
        }
        #observe-tab-review table td.num,
        #observe-tab-raw table td.num {
          text-align: right;
        }
        .experience-timeline {
          position: relative;
          display: flex;
          flex-direction: column;
          gap: 10px;
          padding: 4px 2px 4px 0;
        }
        .experience-detail-left,
        .experience-detail-right {
          min-width: 0;
        }
        .experience-detail-shell {
          height: 100%;
          max-height: 100%;
          min-height: 0;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .experience-detail-tabs {
          display: flex;
          gap: 8px;
          flex: 0 0 auto;
          overflow-x: auto;
          padding: 10px 14px 0;
          background: var(--bg-surface);
        }
        .experience-detail-tab-button {
          flex: 0 0 auto;
          border: 1px solid var(--border);
          border-radius: 8px 8px 0 0;
          background: var(--bg);
          color: var(--text-secondary);
          padding: 7px 12px;
          font-size: 12px;
          font-weight: 650;
          cursor: pointer;
          white-space: nowrap;
        }
        .experience-detail-tab-button.is-active {
          border-color: rgba(37,99,235,.36);
          border-bottom-color: var(--bg-surface);
          background: var(--bg-surface);
          color: var(--accent);
        }
        .experience-detail-tab-panel {
          display: none;
          flex: 1 1 auto;
          min-height: 0;
          overflow: auto;
          padding: 14px;
          border-top: 1px solid var(--border);
        }
        .experience-detail-tab-panel.is-active {
          display: block;
        }
        .experience-detail-evidence-panel.is-active {
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .session-story {
          margin: 0 0 12px;
          padding: 10px;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--bg-surface);
        }
        .session-story-head {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          align-items: flex-start;
          margin-bottom: 10px;
        }
        .session-story-head h4 {
          margin: 0 0 4px;
          color: var(--text-primary);
          font-size: 13px;
        }
        .session-story-head p,
        .session-story-answer p,
        .session-story-node-body p {
          margin: 0;
          color: var(--text-secondary);
          font-size: 11px;
          line-height: 1.45;
        }
        .session-story-meta {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
          justify-content: flex-end;
        }
        .session-story-meta span {
          padding: 2px 6px;
          border: 1px solid var(--border);
          border-radius: 999px;
          color: var(--text-muted);
          font-size: 10px;
          white-space: nowrap;
        }
        .session-story-answers {
          display: grid;
          grid-template-columns: repeat(3,minmax(0,1fr));
          gap: 8px;
          margin-bottom: 12px;
        }
        .session-story-graph {
          margin: 0 0 12px;
          padding: 8px;
          border: 1px solid var(--border);
          border-radius: 7px;
          background: var(--bg);
        }
        .session-story-graph-main {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          align-items: center;
        }
        .session-story-graph-main i {
          color: var(--text-muted);
          font-style: normal;
          font-size: 13px;
        }
        .session-story-graph-node {
          display: inline-grid;
          gap: 2px;
          min-width: 82px;
          max-width: 150px;
          padding: 6px 8px;
          border: 1px solid var(--border);
          border-top: 3px solid var(--text-muted);
          border-radius: 6px;
          background: var(--bg-surface);
          color: var(--text-primary);
          cursor: pointer;
          text-align: left;
        }
        .session-story-graph-node.is-ok {
          border-top-color: var(--green);
        }
        .session-story-graph-node.is-attention {
          border-top-color: var(--red);
        }
        .session-story-graph-node.is-unknown {
          border-top-color: var(--yellow);
        }
        .session-story-graph-node span {
          color: var(--text-muted);
          font-size: 10px;
        }
        .session-story-graph-node strong {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 12px;
        }
        .session-story-skill-lanes,
        .session-story-slices,
        .session-story-dispatches,
        .session-story-episodes {
          display: grid;
          grid-template-columns: repeat(auto-fit,minmax(160px,1fr));
          gap: 6px;
          margin: 8px 0 0;
        }
        .session-story-skill-lane,
        .session-story-slice,
        .session-story-dispatch {
          min-width: 0;
          padding: 7px 8px;
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--bg);
        }
        .session-story-skill-lane span,
        .session-story-slice span,
        .session-story-dispatch span {
          display: inline-block;
          color: var(--text-muted);
          font-size: 10px;
          margin-right: 5px;
        }
        .session-story-skill-lane strong,
        .session-story-slice strong,
        .session-story-dispatch strong {
          color: var(--text-primary);
          font-size: 12px;
        }
        .session-story-skill-lane em,
        .session-story-graph-edges em {
          color: var(--text-muted);
          font-style: normal;
          font-size: 10px;
        }
        .session-story-slice p {
          margin: 5px 0 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: var(--text-secondary);
          font-size: 11px;
        }
        .session-story-episodes {
          grid-template-columns: 1fr;
          margin-bottom: 12px;
        }
        .session-story-episode {
          display: grid;
          gap: 8px;
          padding: 9px;
          border: 1px solid var(--border);
          border-radius: 7px;
          background: var(--bg);
        }
        .session-story-episode-head {
          display: flex;
          justify-content: space-between;
          gap: 10px;
          align-items: flex-start;
        }
        .session-story-episode-head strong {
          color: var(--text-primary);
          font-size: 12px;
        }
        .session-story-episode-head p,
        .session-story-episode-acceptance {
          margin: 3px 0 0;
          color: var(--text-secondary);
          font-size: 11px;
          line-height: 1.45;
        }
        .session-story-episode-badges {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
          justify-content: flex-end;
        }
        .session-story-episode-badges span {
          padding: 2px 6px;
          border: 1px solid var(--border);
          border-radius: 999px;
          color: var(--text-muted);
          font-size: 10px;
          white-space: nowrap;
        }
        .session-story-episode-skills,
        .session-story-episode-edges,
        .session-story-episode-feedback,
        .session-story-episode-artifacts {
          display: grid;
          grid-template-columns: repeat(auto-fit,minmax(180px,1fr));
          gap: 6px;
        }
        .session-story-episode-skill,
        .session-story-episode-edges div,
        .session-story-episode-feedback div,
        .session-story-episode-artifacts div {
          min-width: 0;
          padding: 7px 8px;
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--bg-surface);
        }
        .session-story-episode-skill span,
        .session-story-episode-edges span,
        .session-story-episode-feedback span,
        .session-story-episode-artifacts span {
          display: inline-block;
          color: var(--text-muted);
          font-size: 10px;
          margin-right: 5px;
        }
        .session-story-episode-skill strong,
        .session-story-episode-edges strong,
        .session-story-episode-feedback strong,
        .session-story-episode-artifacts strong {
          display: block;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: var(--text-primary);
          font-size: 12px;
        }
        .session-story-episode-skill em,
        .session-story-episode-edges em,
        .session-story-episode-feedback em {
          display: block;
          margin-top: 3px;
          color: var(--text-muted);
          font-style: normal;
          font-size: 10px;
        }
        .session-story-graph-edges {
          margin-top: 8px;
          color: var(--text-secondary);
          font-size: 11px;
        }
        .session-story-graph-edges summary {
          cursor: pointer;
          color: var(--text-muted);
        }
        .session-story-answer,
        .session-story-node {
          border: 1px solid var(--border);
          border-left: 3px solid var(--text-muted);
          border-radius: 7px;
          background: var(--bg);
        }
        .session-story-answer {
          padding: 8px;
        }
        .session-story-answer.is-ok,
        .session-story-node.is-ok {
          border-left-color: var(--green);
        }
        .session-story-answer.is-attention,
        .session-story-node.is-attention {
          border-left-color: var(--red);
          background: rgba(220,38,38,.06);
        }
        .session-story-answer.is-unknown,
        .session-story-node.is-unknown {
          border-left-color: var(--yellow);
        }
        .session-story-answer > div,
        .session-story-node-title {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 4px;
        }
        .session-story-answer strong,
        .session-story-node-title strong {
          color: var(--text-primary);
          font-size: 12px;
          line-height: 1.35;
        }
        .session-story-answer span,
        .session-story-node-title span {
          flex: 0 0 auto;
          color: var(--text-muted);
          font-size: 10px;
          font-family: ui-monospace, monospace;
        }
        .session-story-line {
          position: relative;
          display: flex;
          flex-direction: column;
          gap: 8px;
          padding-left: 12px;
        }
        .session-story-line::before {
          content: "";
          position: absolute;
          left: 22px;
          top: 12px;
          bottom: 12px;
          width: 1px;
          background: var(--border);
        }
        .session-story-node {
          position: relative;
          display: grid;
          grid-template-columns: 22px minmax(0,1fr);
          gap: 8px;
          padding: 8px;
        }
        .session-story-node-index {
          z-index: 1;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 20px;
          height: 20px;
          border-radius: 999px;
          background: var(--accent);
          color: #fff;
          font-size: 10px;
          font-weight: 800;
        }
        .session-story-evidence {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
          margin-top: 6px;
        }
        @media(max-width:900px) {
          .session-story-answers {
            grid-template-columns: 1fr;
          }
          .session-story-head {
            flex-direction: column;
          }
          .session-story-meta {
            justify-content: flex-start;
          }
        }
        .reviewer-trace-link {
          display: inline-block;
          max-width: 100%;
          padding: 3px 6px;
          border: 1px solid var(--border);
          border-radius: 999px;
          background: var(--bg-surface);
          color: var(--text-muted);
          font-family: ui-monospace, monospace;
          font-size: 10px;
          line-height: 1.35;
          word-break: break-all;
          cursor: pointer;
        }
        .reviewer-trace-link:hover {
          border-color: rgba(37,99,235,.35);
          color: var(--accent);
        }
        .reviewer-judgment-review {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 5px;
          margin-top: 7px;
          padding-top: 7px;
          border-top: 1px solid rgba(107,114,128,.20);
          color: var(--text-muted);
          font-size: 11px;
        }
        .reviewer-judgment-review > span {
          font-weight: 700;
          color: var(--text-secondary);
        }
        .reviewer-judgment-review button {
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--bg-surface);
          color: var(--text-secondary);
          padding: 3px 7px;
          font-size: 11px;
          cursor: pointer;
        }
        .reviewer-judgment-review button.is-active {
          border-color: rgba(37,99,235,.36);
          background: var(--accent);
          color: #fff;
        }
        .reviewer-judgment-review small {
          flex-basis: 100%;
          color: var(--text-muted);
          line-height: 1.4;
        }
        .soft-standard-status {
          flex: 0 0 auto;
          padding: 2px 6px;
          border-radius: 999px;
          background: var(--bg-muted);
          color: var(--text-secondary);
          font-size: 11px;
          font-weight: 700;
        }
        .soft-standard-status[data-soft-standard-status="author_confirmed"] {
          background: rgba(31,157,99,.14);
          color: var(--green);
        }
        .soft-standard-status[data-soft-standard-status="rejected"] {
          background: rgba(220,38,38,.12);
          color: var(--red);
        }
        .soft-standard-status[data-soft-standard-status="stale"] {
          background: rgba(217,119,6,.16);
          color: var(--yellow);
        }
        .soft-standard-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-top: 8px;
        }
        .soft-standard-actions button {
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--bg);
          color: var(--text-secondary);
          padding: 4px 8px;
          font-size: 11px;
          cursor: pointer;
        }
        .soft-standard-actions button:hover {
          border-color: rgba(37,99,235,.35);
          color: var(--accent);
        }
        .skill-chain-cell-summary {
          margin-top: 7px;
          color: var(--text-secondary);
          font-size: 11px;
          line-height: 1.45;
          text-align: left;
        }
        .skill-chain-compact-candidates {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
          margin-top: 5px;
        }
        .skill-chain-compact-candidates span {
          max-width: 100%;
          padding: 2px 6px;
          border: 1px solid var(--border);
          border-radius: 999px;
          background: var(--bg-muted);
          color: var(--text-muted);
          font-size: 10px;
          line-height: 1.3;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .standard-active-list {
          display: flex;
          flex-direction: column;
          gap: 4px;
          margin-top: 7px;
        }
        .standard-active-list span,
        .soft-standard-pending-title {
          color: var(--text-primary);
          font-size: 11px;
          font-weight: 700;
          line-height: 1.35;
        }
        .soft-standard-pending-list {
          display: flex;
          flex-direction: column;
          gap: 6px;
          margin-top: 8px;
          padding-top: 8px;
          border-top: 1px solid rgba(107,114,128,.20);
        }
        .soft-standard-pending-item {
          padding: 6px 7px;
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--bg-surface);
        }
        .soft-standard-pending-item strong {
          display: block;
          color: var(--text-primary);
          font-size: 11px;
          line-height: 1.35;
        }
        .soft-standard-pending-item span {
          display: block;
          margin-top: 2px;
          color: var(--text-muted);
          font-size: 10px;
          line-height: 1.35;
        }
        .soft-standard-pending-item .soft-standard-actions {
          margin-top: 6px;
        }
        .soft-standard-pending-item .soft-standard-actions button {
          padding: 3px 7px;
        }
        .soft-standard-modal-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin: 0 0 12px;
          padding-left: 18px;
        }
        .soft-standard-modal-item {
          padding: 8px 9px;
          border: 1px solid var(--border);
          border-radius: 7px;
          background: var(--bg-surface);
        }
        .soft-standard-modal-head {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .soft-standard-modal-head strong {
          flex: 1 1 auto;
          min-width: 0;
          color: var(--text-primary);
          font-size: 12px;
          line-height: 1.35;
        }
        .soft-standard-modal-head span {
          flex: 0 0 auto;
          color: var(--text-muted);
          font-size: 11px;
        }
        .soft-standard-modal-body,
        .soft-standard-modal-evidence {
          margin-top: 5px;
          color: var(--text-secondary);
          font-size: 12px;
          line-height: 1.45;
        }
        .soft-standard-modal-evidence {
          color: var(--text-muted);
          font-size: 11px;
        }
        .experience-detail-grid {
          flex: 1 1 auto;
          min-height: 0;
          height: 100%;
          max-height: 100%;
          overflow: hidden;
        }
        .experience-detail-left {
          height: 100%;
          overflow: auto;
          padding-right: 4px;
        }
        .experience-detail-right {
          display: flex;
          flex-direction: column;
          min-height: 0;
          height: 100%;
          overflow: hidden;
        }
        .session-timeline-tree {
          display: flex;
          flex-direction: column;
          gap: 12px;
          flex: 1 1 auto;
          min-height: 0;
          overflow: auto;
          padding-right: 4px;
        }
        .timeline-main-chain,
        .timeline-branch-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
          min-height: 0;
        }
        .timeline-chain-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 8px 10px;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--bg-muted);
          color: var(--text-secondary);
          font-size: 12px;
        }
        .timeline-chain-header strong {
          color: var(--text-primary);
        }
        .timeline-branch {
          border: 1px solid var(--border);
          border-radius: 10px;
          background: var(--bg);
          overflow: hidden;
        }
        .timeline-branch summary {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          cursor: pointer;
          padding: 9px 10px;
          background: rgba(37,99,235,.05);
          color: var(--text-primary);
          font-size: 12px;
          font-weight: 650;
        }
        .timeline-branch summary small {
          min-width: 0;
          color: var(--text-muted);
          font-weight: 500;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .timeline-branch .timeline-goal-tabs {
          border: 0;
          border-top: 1px solid var(--border);
          border-radius: 0;
          min-height: 360px;
        }
        .session-timeline-tree .timeline-goal-tabs {
          flex: 0 0 auto;
          height: auto;
          overflow: visible;
        }
        .session-timeline-tree .timeline-tab-panels,
        .session-timeline-tree .timeline-tab-panel.is-active {
          overflow: visible;
          height: auto;
        }
        .timeline-goal-tabs {
          display: flex;
          flex-direction: column;
          flex: 1 1 auto;
          min-height: 0;
          height: 100%;
          overflow: hidden;
          border: 1px solid rgba(37,99,235,.18);
          border-radius: 10px;
          background: var(--bg);
        }
        .timeline-tab-list {
          display: flex;
          gap: 6px;
          flex: 0 0 auto;
          overflow-x: auto;
          padding: 8px 9px;
          border-bottom: 1px solid var(--border);
          background: rgba(37,99,235,.05);
        }
        .timeline-tab-button {
          flex: 0 0 auto;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--bg);
          color: var(--text-secondary);
          padding: 5px 9px;
          font-size: 11px;
          font-weight: 650;
          cursor: pointer;
          white-space: nowrap;
        }
        .timeline-tab-button.is-active {
          border-color: rgba(37,99,235,.36);
          background: var(--accent);
          color: #fff;
        }
        .timeline-tab-panels {
          flex: 1 1 auto;
          min-height: 0;
          overflow: hidden;
        }
        .timeline-tab-panel {
          display: none;
          height: 100%;
          min-height: 0;
          overflow: auto;
          padding: 0 10px 10px;
        }
        .timeline-tab-panel.is-active {
          display: block;
        }
        .timeline-goal-card-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 8px 10px;
          border-bottom: 1px solid var(--border);
          background: var(--bg);
          position: sticky;
          top: 0;
          z-index: 2;
        }
        .timeline-goal-card-header strong {
          color: var(--text-primary);
          font-size: 12px;
        }
        .timeline-goal-card-header span {
          color: var(--text-muted);
          font-size: 11px;
        }
        .timeline-goal-summary {
          margin: 8px 0;
          padding: 7px 9px;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--bg-muted);
          color: var(--text-muted);
          font-size: 11px;
          line-height: 1.45;
        }
        .timeline-row {
          display: grid;
          grid-template-columns: 46px minmax(0, 1fr);
          gap: 10px;
          position: relative;
        }
        .timeline-row::before {
          content: "";
          position: absolute;
          left: 22px;
          top: 34px;
          bottom: -12px;
          width: 1px;
          background: var(--border);
        }
        .timeline-row:last-child::before {
          display: none;
        }
        .timeline-row.is-filter-hidden {
          display: none;
        }
        .timeline-row.is-filter-match .timeline-card {
          border-color: rgba(37,99,235,.55);
          box-shadow: 0 0 0 1px rgba(37,99,235,.18);
        }
        .timeline-row.is-real-user-reply .timeline-card {
          width: min(680px, 78%);
          border-color: rgba(37,99,235,.30);
          background: rgba(37,99,235,.045);
          box-shadow: 0 1px 0 rgba(37,99,235,.06);
        }
        .timeline-row.is-real-user-reply .timeline-card-header {
          padding: 7px 9px;
          background: rgba(37,99,235,.08);
          border-bottom-color: rgba(37,99,235,.16);
        }
        .timeline-row.is-real-user-reply .timeline-title {
          color: var(--accent);
        }
        .timeline-row.is-real-user-reply .timeline-snippet {
          background: rgba(255,255,255,.58);
          font-family: var(--font-sans, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
          font-size: 12px;
          line-height: 1.55;
        }
        .timeline-row.is-runtime-event .timeline-card {
          width: 100%;
        }
        .timeline-row[data-current-skill-window="0"] {
          opacity: .55;
        }
        .timeline-row[data-current-skill-window="0"] .timeline-card {
          background: rgba(107,114,128,.04);
          border-color: rgba(107,114,128,.18);
        }
        .timeline-row[data-current-skill-window="0"] .timeline-snippet {
          color: var(--text-muted);
        }
        .timeline-row[data-current-skill-window="0"]::before {
          background: rgba(107,114,128,.25);
        }
        .timeline-window-marker {
          display: flex;
          align-items: center;
          gap: 8px;
          margin: 4px 0;
          color: var(--accent);
          font-size: 11px;
          font-weight: 800;
        }
        .timeline-window-marker::before,
        .timeline-window-marker::after {
          content: "";
          height: 1px;
          flex: 1 1 auto;
          background: rgba(37,99,235,.35);
        }
        .timeline-window-marker span {
          flex: 0 0 auto;
          padding: 3px 8px;
          border: 1px solid rgba(37,99,235,.30);
          border-radius: 999px;
          background: rgba(37,99,235,.10);
        }
        .timeline-window-end {
          color: var(--yellow);
        }
        .timeline-window-end::before,
        .timeline-window-end::after {
          background: rgba(202,138,4,.38);
        }
        .timeline-window-end span {
          border-color: rgba(202,138,4,.34);
          background: rgba(202,138,4,.12);
        }
        .timeline-marker {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
          padding-top: 2px;
          color: var(--text-muted);
          font-family: ui-monospace, monospace;
          font-size: 10px;
          z-index: 1;
        }
        .timeline-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          border-radius: 999px;
          border: 1px solid var(--border);
          background: var(--bg-surface);
          font-size: 10px;
          font-weight: 800;
          letter-spacing: 0;
        }
        .timeline-user .timeline-icon { color: var(--accent); background: rgba(37,99,235,.08); border-color: rgba(37,99,235,.25); }
        .timeline-assistant .timeline-icon { color: var(--green); background: rgba(22,163,74,.08); border-color: rgba(22,163,74,.25); }
        .timeline-tool-use .timeline-icon { color: var(--yellow); background: rgba(202,138,4,.10); border-color: rgba(202,138,4,.28); }
        .timeline-tool-result .timeline-icon { color: var(--text-secondary); background: var(--bg-muted); }
        .timeline-tool-error .timeline-icon { color: var(--red); background: rgba(220,38,38,.08); border-color: rgba(220,38,38,.28); }
        .timeline-skill .timeline-icon { color: var(--text-muted); background: var(--bg-muted); border-style: dashed; }
        .timeline-card {
          min-width: 0;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--bg-surface);
          overflow: hidden;
        }
        .timeline-card-header {
          position: relative;
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 10px;
          padding: 9px 10px;
          border-bottom: 1px solid var(--border);
          background: var(--bg-muted);
        }
        .timeline-title {
          font-size: 12px;
          font-weight: 700;
          color: var(--text-primary);
        }
        .timeline-kind,
        .timeline-subtitle,
        .timeline-index {
          color: var(--text-muted);
        }
        .timeline-subtitle {
          margin-top: 3px;
          font-size: 11px;
          word-break: break-all;
        }
        .timeline-badges {
          display: flex;
          justify-content: flex-end;
          flex-wrap: wrap;
          gap: 4px;
          max-width: 42%;
        }
        .timeline-badge {
          display: inline-flex;
          padding: 2px 6px;
          border-radius: 999px;
          font-size: 11px;
          line-height: 1.35;
          border: 1px solid rgba(107,114,128,.16);
          background: rgba(107,114,128,.08);
          color: var(--text-secondary);
          white-space: nowrap;
          flex-shrink: 0;
        }
        .goal-slice-correction-button {
          flex: 0 0 auto;
          border: 1px solid rgba(255,255,255,.80);
          background: var(--accent);
          color: #fff;
          border-radius: 6px;
          padding: 3px 6px;
          font-size: 10px;
          line-height: 1.25;
          font-weight: 700;
          box-shadow: 0 2px 8px rgba(37,99,235,.18);
          cursor: pointer;
          white-space: nowrap;
        }
        .goal-slice-correction-button:hover {
          filter: brightness(.96);
        }
        .goal-slice-correction-button.is-marked {
          border-color: rgba(255,255,255,.80);
          background: var(--green);
          color: #fff;
          box-shadow: 0 2px 8px rgba(22,163,74,.18);
        }
        .timeline-manual-mark-button {
          flex: 0 0 auto;
          border: 1px solid rgba(37,99,235,.26);
          background: rgba(37,99,235,.08);
          color: var(--accent);
          border-radius: 6px;
          padding: 3px 6px;
          font-size: 10px;
          line-height: 1.25;
          font-weight: 800;
          cursor: pointer;
          white-space: nowrap;
        }
        .timeline-manual-mark-button:hover,
        .timeline-manual-mark-button.is-editing {
          border-color: rgba(37,99,235,.55);
          background: rgba(37,99,235,.14);
        }
        .timeline-manual-mark-button.is-window-only {
          border-color: rgba(107,114,128,.28);
          background: var(--bg-muted);
          color: var(--text-secondary);
        }
        .timeline-manual-mark-button.is-window-only:hover,
        .timeline-manual-mark-button.is-window-only.is-editing {
          border-color: rgba(37,99,235,.38);
          color: var(--accent);
        }
        .timeline-manual-mark-button.is-marked {
          border-color: rgba(22,163,74,.38);
          background: rgba(22,163,74,.11);
          color: var(--green);
        }
        .goal-slice-popover {
          position: fixed;
          z-index: 2147483600;
          width: min(320px, calc(100vw - 32px));
          border: 1px solid rgba(37,99,235,.26);
          border-radius: 9px;
          background: var(--bg-surface);
          color: var(--text-primary);
          box-shadow: 0 18px 48px rgba(15,23,42,.22);
          padding: 10px;
          opacity: 1;
        }
        .goal-slice-popover-title {
          font-size: 12px;
          font-weight: 800;
          color: var(--text-primary);
          margin-bottom: 4px;
        }
        .goal-slice-popover-hint {
          color: var(--text-muted);
          font-size: 11px;
          line-height: 1.45;
          margin-bottom: 9px;
        }
        .goal-slice-popover-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }
        .goal-slice-popover-actions button {
          text-align: center;
          border: 1px solid var(--border);
          border-radius: 999px;
          background: var(--bg);
          color: var(--text-secondary);
          padding: 4px 8px;
          font-size: 11px;
          font-weight: 700;
          cursor: pointer;
          white-space: nowrap;
        }
        .goal-slice-popover-actions button:hover {
          border-color: rgba(37,99,235,.35);
          color: var(--accent);
          background: rgba(37,99,235,.08);
        }
        .timeline-manual-popover {
          position: fixed;
          z-index: 2147483600;
          width: min(380px, calc(100vw - 32px));
          max-height: calc(100vh - 24px);
          max-height: calc(100dvh - 24px);
          border: 1px solid rgba(37,99,235,.26);
          border-radius: 9px;
          background: var(--bg-surface);
          color: var(--text-primary);
          box-shadow: 0 18px 48px rgba(15,23,42,.22);
          padding: 10px;
          opacity: 1;
          overflow-y: auto;
          overscroll-behavior: contain;
          display: flex;
          flex-direction: column;
        }
        .timeline-manual-actions {
          display: flex;
          flex-direction: column;
          flex: 1 1 auto;
          gap: 7px;
          min-height: 0;
          overflow-y: auto;
          overscroll-behavior: contain;
          padding-right: 2px;
        }
        .timeline-manual-actions > button,
        .timeline-manual-metric-row button {
          border: 1px solid var(--border);
          border-radius: 999px;
          background: var(--bg);
          color: var(--text-secondary);
          padding: 4px 8px;
          font-size: 11px;
          font-weight: 700;
          cursor: pointer;
          white-space: nowrap;
        }
        .timeline-manual-actions > button:hover,
        .timeline-manual-metric-row button:hover {
          border-color: rgba(37,99,235,.35);
          color: var(--accent);
          background: rgba(37,99,235,.08);
        }
        .timeline-manual-metric-row button.is-active {
          border-color: rgba(22,163,74,.36);
          color: var(--green);
          background: rgba(22,163,74,.10);
        }
        .timeline-manual-metric-row {
          display: grid;
          grid-template-columns: minmax(120px, 1fr) auto auto auto;
          align-items: center;
          gap: 6px;
          border-top: 1px solid var(--border);
          padding-top: 7px;
        }
        .timeline-manual-metric-row span {
          min-width: 0;
          color: var(--text-secondary);
          font-size: 11px;
          font-weight: 700;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .timeline-snippet {
          position: relative;
          margin: 0;
          padding: 10px;
          background: var(--bg);
          white-space: pre-wrap;
          word-break: break-word;
          font-family: ui-monospace, monospace;
          font-size: 11px;
          line-height: 1.55;
          color: var(--text-primary);
          max-height: 210px;
          overflow: hidden;
        }
        .timeline-snippet.is-overflowing::after {
          content: "... 点击查看详情";
          position: sticky;
          display: block;
          bottom: 0;
          margin: -22px 0 0 auto;
          width: 108px;
          padding: 2px 6px 3px;
          text-align: right;
          color: var(--text-secondary);
          font-weight: 700;
          background: linear-gradient(90deg, rgba(255,255,255,0), var(--bg) 45%);
          pointer-events: none;
        }
        .timeline-snippet.is-tool-error {
          border-left: 3px solid var(--red);
          background: rgba(220,38,38,.04);
        }
        .metric-calibration-row {
          display: flex;
          align-items: flex-start;
          gap: 6px;
          padding: 5px 8px;
          border-top: 1px solid var(--border);
          background: var(--bg-muted);
        }
        .metric-calibration-title {
          flex: 0 0 auto;
          color: var(--text-muted);
          font-size: 10px;
          line-height: 18px;
        }
        .metric-calibration-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
        }
        .metric-calibration-button {
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--bg);
          color: var(--text-muted);
          padding: 2px 5px;
          font-size: 9.5px;
          line-height: 1.25;
          font-weight: 650;
          cursor: pointer;
        }
        .metric-calibration-button.is-rule-hit {
          border-color: rgba(37,99,235,.25);
          color: var(--accent);
          background: rgba(37,99,235,.06);
        }
        .metric-calibration-button.is-confirmed {
          border-color: rgba(22,163,74,.30);
          color: var(--green);
          background: rgba(22,163,74,.10);
        }
        .metric-calibration-button.is-rejected {
          border-color: rgba(220,38,38,.30);
          color: var(--red);
          background: rgba(220,38,38,.08);
          text-decoration: line-through;
        }
        .metric-calibration-button.is-editing-reason {
          outline: 2px solid rgba(37,99,235,.22);
          outline-offset: 1px;
        }
        .metric-reason-popover {
          flex: 1 0 100%;
          margin-top: 3px;
          max-width: min(560px, 100%);
        }
        .metric-reason-panel {
          border: 1px solid rgba(37,99,235,.22);
          border-radius: 8px;
          background: var(--bg-surface);
          box-shadow: 0 12px 28px rgba(15,23,42,.12);
          padding: 10px;
        }
        .metric-reason-title {
          color: var(--text-primary);
          font-size: 12px;
          font-weight: 700;
          margin-bottom: 4px;
        }
	        .metric-reason-hint {
	          color: var(--text-muted);
	          font-size: 11px;
	          line-height: 1.45;
	          margin-bottom: 8px;
	        }
	        .metric-reason-choice-row {
	          display: flex;
	          align-items: center;
	          gap: 6px;
	          margin-bottom: 8px;
	        }
	        .metric-reason-choice-label {
	          color: var(--text-muted);
	          font-size: 11px;
	          margin-right: 2px;
	        }
	        .metric-reason-choice {
	          border: 1px solid var(--border);
	          border-radius: 999px;
	          background: var(--bg);
	          color: var(--text-secondary);
	          padding: 3px 9px;
	          font-size: 11px;
	          font-weight: 700;
	          cursor: pointer;
	        }
	        .metric-reason-choice.is-confirmed {
	          border-color: rgba(22,163,74,.35);
	          background: rgba(22,163,74,.12);
	          color: var(--green);
	        }
	        .metric-reason-choice.is-rejected {
	          border-color: rgba(220,38,38,.35);
	          background: rgba(220,38,38,.10);
	          color: var(--red);
	        }
	        .metric-reason-input {
	          width: 100%;
          min-height: 58px;
          resize: vertical;
          box-sizing: border-box;
          border: 1px solid var(--border);
          border-radius: 7px;
          background: var(--bg);
          color: var(--text-primary);
          font: inherit;
          font-size: 12px;
          line-height: 1.45;
          padding: 7px 8px;
        }
        .metric-reason-actions {
          display: flex;
          justify-content: flex-end;
          gap: 6px;
          margin-top: 8px;
        }
        .metric-reason-action {
          border: 1px solid var(--border);
          border-radius: 7px;
          background: var(--bg);
          color: var(--text-secondary);
          padding: 4px 9px;
          font-size: 11px;
          font-weight: 650;
          cursor: pointer;
        }
        .metric-reason-action.is-primary {
          border-color: rgba(37,99,235,.32);
          background: var(--accent);
          color: #fff;
        }
        .timeline-mark {
          padding: 1px 3px;
          border-radius: 4px;
          color: inherit;
        }
        .metric-item {
          display: inline-flex;
          align-items: baseline;
          gap: 2px;
          margin: 0;
          padding: 0 2px;
          border: 0;
          border-radius: 4px;
          background: transparent;
          color: inherit;
          font: inherit;
          white-space: normal;
          cursor: pointer;
          text-align: left;
        }
        .metric-item:hover { background: var(--bg-muted); color: var(--accent); }
        .metric-item strong {
          color: var(--text-primary);
          font-weight: 700;
        }
        .experience-evidence-cell {
          text-align: left !important;
        }
        .experience-evidence-cell .metric-item {
          justify-content: center;
        }
        .skill-evidence-summary {
          display: flex;
          flex-direction: column;
          gap: 4px;
          text-align: left;
          color: var(--text-secondary);
        }
        .skill-evidence-summary .summary-row {
          display: flex;
          align-items: baseline;
          flex-wrap: wrap;
          gap: 3px 8px;
        }
        .skill-evidence-summary .summary-title {
          min-width: 58px;
          color: var(--text-muted);
          font-weight: 650;
        }
        .skill-evidence-summary .summary-name {
          color: var(--text-muted);
          margin-right: 2px;
        }
        .skill-evidence-summary .summary-count {
          color: var(--text-secondary);
          font-weight: 650;
          font-variant-numeric: tabular-nums;
        }
        .skill-evidence-summary .summary-pct {
          color: var(--text-muted);
          font-size: 10px;
          margin-left: 2px;
          font-variant-numeric: tabular-nums;
        }
        .skill-evidence-summary .summary-unit-text,
        .skill-evidence-summary .summary-muted,
        .skill-evidence-summary .summary-sep {
          color: var(--text-muted);
        }
        .skill-evidence-summary .summary-detail {
          display: inline;
          margin: 0;
          color: var(--text-secondary);
          font-size: inherit;
        }
        .skill-evidence-summary .summary-metric {
          display: inline-flex;
          align-items: baseline;
          white-space: nowrap;
        }
        .problem-pattern-list {
          display: inline-flex;
          flex-wrap: wrap;
          gap: 4px;
          min-width: 0;
        }
        .problem-pattern-chip {
          display: inline-flex;
          align-items: baseline;
          gap: 4px;
          max-width: 100%;
          border: 1px solid rgba(37,99,235,.18);
          border-radius: 999px;
          background: rgba(37,99,235,.05);
          color: var(--text-secondary);
          padding: 2px 7px;
          font-size: 10.5px !important;
          line-height: 1.35;
          cursor: pointer;
          white-space: nowrap;
        }
        .problem-pattern-chip:hover {
          border-color: rgba(37,99,235,.34);
          color: var(--accent);
          background: rgba(37,99,235,.09);
        }
        .problem-pattern-chip .pattern-bucket {
          color: var(--text-primary);
          font-weight: 700;
        }
        .problem-pattern-chip .pattern-key {
          color: var(--text-muted);
        }
        .problem-pattern-chip .pattern-count {
          color: var(--accent);
          font-weight: 700;
          font-variant-numeric: tabular-nums;
        }
        .skill-evidence-summary .summary-impact {
          padding: 1px 5px;
          border-radius: 6px;
          border: 1px solid transparent;
        }
        .skill-evidence-summary .summary-impact-priority {
          background: rgba(220,38,38,.08);
          border-color: rgba(220,38,38,.20);
        }
        .skill-evidence-summary .summary-impact-priority .summary-name,
        .skill-evidence-summary .summary-impact-priority .summary-count {
          color: var(--red);
        }
        .skill-evidence-summary .summary-impact-sample {
          background: rgba(107,114,128,.08);
          border-color: rgba(107,114,128,.16);
        }
        .skill-evidence-summary .summary-impact-sample .summary-name,
        .skill-evidence-summary .summary-impact-sample .summary-count {
          color: var(--text-secondary);
        }
        .skill-evidence-summary .summary-impact-soft {
          background: rgba(79,70,229,.08);
          border-color: rgba(79,70,229,.18);
        }
        .skill-evidence-summary .summary-impact-soft .summary-name,
        .skill-evidence-summary .summary-impact-soft .summary-count {
          color: var(--text-secondary);
        }
        .skill-evidence-summary .summary-metric-empty .summary-name,
        .skill-evidence-summary .summary-metric-empty .summary-count {
          color: var(--text-muted);
          opacity: .55;
        }
        .invocation-summary {
          display: block;
          max-width: 100%;
          font-size: 11px;
          line-height: 1.5;
          color: var(--text-muted);
          text-align: center;
        }
        .invocation-total {
          color: var(--text-primary);
          font-weight: 650;
          margin-bottom: 2px;
        }
        .invocation-breakdown {
          display: flex;
          flex-wrap: wrap;
          justify-content: center;
          gap: 3px 8px;
        }
        .invocation-breakdown span {
          display: inline;
          white-space: normal;
        }
        .invocation-footnote {
          margin-top: 2px;
          color: var(--text-muted);
        }
	        .experience-session-groups {
	          border: 1px solid var(--border);
	          border-radius: 8px;
	          background: var(--bg-surface);
	          max-height: 150vh;
	          overflow: auto;
	        }
        .experience-session-group {
          border-bottom: 1px solid var(--border);
          background: var(--bg-surface);
        }
        .experience-session-group:last-child {
          border-bottom: 0;
        }
        .experience-session-group > summary {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 11px 13px;
          cursor: pointer;
          list-style: none;
          background: var(--bg-muted);
        }
        .experience-session-group > summary::-webkit-details-marker {
          display: none;
        }
        .experience-session-skill {
          font-family: ui-monospace, monospace;
          font-size: 13px;
          font-weight: 700;
          color: var(--text-primary);
          word-break: break-all;
        }
        .experience-session-meta {
          margin-left: 8px;
          color: var(--text-muted);
          font-size: 12px;
        }
        .experience-session-tags {
          display: flex;
          flex-wrap: wrap;
          justify-content: flex-end;
          gap: 6px;
          font-size: 12px;
          font-weight: 650;
        }
        .evidence-chain {
          display: flex;
          flex-direction: column;
          gap: 6px;
          margin-bottom: 10px;
        }
        .evidence-chain-row,
        .evidence-anchor-row {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }
        .evidence-chain-item,
        .evidence-anchor {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 3px 7px;
          border: 1px solid var(--border);
          border-radius: 999px;
          background: var(--bg);
          color: var(--text-muted);
          font-size: 11px;
          line-height: 1.35;
        }
        .evidence-chain-item strong {
          color: var(--text-secondary);
          font-weight: 700;
        }
        .evidence-anchor {
          background: var(--bg-muted);
          color: var(--text-secondary);
          border-radius: 6px;
          font-family: inherit;
          cursor: pointer;
        }
        .evidence-anchor:hover {
          border-color: rgba(37,99,235,.35);
          color: var(--accent);
        }
        .rule-finding-list {
          display: flex;
          flex-wrap: wrap;
          gap: 5px;
          margin-bottom: 8px;
        }
        .rule-finding-list.compact {
          margin-bottom: 0;
        }
        .rule-finding {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          max-width: 100%;
          padding: 3px 7px;
          border: 1px solid var(--border);
          border-radius: 999px;
          background: var(--bg);
          color: var(--text-secondary);
          font-size: 11px;
          line-height: 1.35;
          white-space: normal;
        }
        .rule-finding strong {
          color: inherit;
          font-weight: 700;
        }
        .rule-level {
          color: var(--text-muted);
          font-size: 10px;
        }
        .rule-anchor {
          color: var(--text-muted);
        }
        .rule-attention {
          background: rgba(220,38,38,.08);
          border-color: rgba(220,38,38,.22);
          color: var(--red);
        }
        .rule-sample {
          background: rgba(202,138,4,.08);
          border-color: rgba(202,138,4,.22);
          color: var(--yellow);
        }
        .rule-normal {
          background: var(--bg-muted);
          border-color: var(--border);
          color: var(--text-secondary);
        }
        .assistive-box {
          display: flex;
          flex-direction: column;
          gap: 4px;
          padding: 8px 9px;
          border: 1px solid var(--border);
          border-radius: 7px;
          background: var(--bg);
          text-align: left;
          font-size: 11px;
          line-height: 1.45;
        }
        .assistive-box.compact {
          padding: 4px 7px;
          gap: 0;
        }
        .assistive-box.compact .assistive-main {
          align-items: center;
          gap: 6px;
        }
        .assistive-box.compact .assistive-main span {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .assistive-box.compact .assistive-help {
          flex: 0 0 auto;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 15px;
          height: 15px;
          border: 1px solid var(--border);
          border-radius: 50%;
          background: var(--bg-surface);
          color: var(--text-muted);
          font-size: 10px;
          line-height: 15px;
          cursor: help;
        }
        .assistive-main {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          color: var(--text-primary);
          font-weight: 650;
        }
        .assistive-main strong {
          color: var(--text-muted);
          font-size: 10px;
          white-space: nowrap;
        }
        .assistive-desc,
        .assistive-sub {
          color: var(--text-muted);
        }
        .assistive-attention {
          border-color: rgba(220,38,38,.24);
          background: rgba(220,38,38,.06);
        }
        .assistive-sample {
          border-color: rgba(202,138,4,.24);
          background: rgba(202,138,4,.07);
        }
        .assistive-positive {
          border-color: rgba(22,163,74,.24);
          background: rgba(22,163,74,.06);
        }
        .assistive-normal,
        .assistive-unknown {
          background: var(--bg-muted);
        }
        .review-state-control {
          display: flex;
          flex-direction: column;
          gap: 5px;
          align-items: flex-start;
        }
        .review-state-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
        }
        .review-state-button {
          padding: 4px 7px !important;
          border: 1px solid var(--border);
          border-radius: 7px;
          background: var(--bg);
          color: var(--text-secondary);
          cursor: pointer;
          font-size: 10.5px !important;
          line-height: 1.3;
          font-weight: 650;
        }
        .review-state-button:hover {
          color: var(--accent);
          border-color: rgba(37,99,235,.35);
          background: rgba(37,99,235,.06);
        }
        .review-state-button.is-active {
          color: #fff;
          border-color: rgba(255,255,255,.75);
          box-shadow: 0 3px 10px rgba(0,0,0,.12);
        }
        .review-state-button.review-real-issue { background: var(--red); }
        .review-state-button.review-not-issue { background: var(--green); }
        .review-state-button.review-needs-context { background: var(--yellow); color: #1f2937; }
        .review-state-button.review-reviewed { background: var(--accent); }
        .invocation-summary strong {
          color: var(--text-primary);
          font-weight: 700;
        }
        .goal-list { display: flex; flex-direction: column; gap: 6px; }
        .goal-item span {
          display: inline-flex;
          margin-bottom: 2px;
          padding: 1px 5px;
          border-radius: 999px;
          background: var(--bg-muted);
          color: var(--text-muted);
          font-size: 11px;
        }
        .goal-item div { font-size: 12px; line-height: 1.45; word-break: break-word; }
        .reviewer-overview-cell {
          display: flex;
          flex-direction: column;
          gap: 6px;
          min-width: 180px;
          max-width: 280px;
        }
        .reviewer-overview-title {
          color: var(--text-primary);
          font-size: 12px;
          font-weight: 700;
          line-height: 1.35;
        }
        .reviewer-overview-findings {
          display: flex;
          flex-direction: column;
          gap: 3px;
          color: var(--text-secondary);
          font-size: 11px;
          line-height: 1.35;
        }
        .reviewer-overview-findings span {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .reviewer-overview-cell button {
          align-self: flex-start;
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--bg);
          color: var(--text-secondary);
          padding: 4px 8px;
          font-size: 11px;
          cursor: pointer;
        }
        .reviewer-overview-cell button:hover {
          border-color: rgba(37,99,235,.35);
          color: var(--accent);
        }
        #metric-guide-toolbar {
          position: fixed !important;
          right: 18px;
          top: 50vh;
          transform: translateY(-50%);
          z-index: 2147483646;
          display: flex;
          flex-direction: column;
          gap: 8px;
          pointer-events: auto;
        }
        #metric-guide-toolbar button,
        #metric-guide-panel button {
          font-family: system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;
        }
        #metric-guide-toolbar button {
          letter-spacing: 0;
          width: 42px;
          height: 42px;
          padding: 0;
          border: 2px solid rgba(255,255,255,.86);
          border-radius: 999px;
          background: var(--accent);
          color: #fff;
          box-shadow: 0 10px 28px rgba(0,0,0,.32);
          cursor: pointer;
          font-size: 18px;
          font-weight: 800;
          white-space: nowrap;
        }
        #metric-guide-panel {
          position: fixed !important;
          right: 18px;
          top: 50vh;
          transform: translateY(-50%);
          z-index: 2147483647;
          display: none;
          width: min(400px, calc(100vw - 24px));
          max-height: 76vh;
          overflow: auto;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--bg-surface);
          box-shadow: 0 12px 32px rgba(0,0,0,.22);
        }
        .metric-guide-header {
          position: sticky;
          top: 0;
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 10px;
          padding: 12px 13px;
          border-bottom: 1px solid var(--border);
          background: var(--bg-surface);
        }
        .metric-guide-header h2 { margin: 0; font-size: 14px; color: var(--text-primary); }
        .metric-guide-header p { margin: 3px 0 0; font-size: 12px; color: var(--text-muted); line-height: 1.45; }
        .metric-guide-header button {
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--bg);
          color: var(--text-secondary);
          cursor: pointer;
          padding: 3px 7px;
        }
        .metric-guide-body { padding: 10px 12px 12px; }
        .metric-guide-section { margin-top: 10px; }
        .metric-guide-section:first-child { margin-top: 0; }
        .metric-guide-section h3 {
          margin: 0 0 6px;
          font-size: 12px;
          color: var(--text-muted);
        }
        .metric-guide-item {
          display: block;
          width: 100%;
          margin: 0 0 6px;
          padding: 8px 9px;
          border: 1px solid var(--border);
          border-radius: 7px;
          background: var(--bg);
          color: var(--text-secondary);
          text-align: left;
          cursor: pointer;
        }
        .metric-guide-item strong {
          display: block;
          color: var(--text-primary);
          font-size: 12px;
          margin-bottom: 3px;
        }
        .metric-guide-item span {
          display: block;
          font-size: 12px;
          line-height: 1.45;
        }
        .metric-guide-item.is-active {
          border-color: rgba(37,99,235,.35);
          background: rgba(37,99,235,.08);
        }
        .report-version-divider {
          display: grid;
          grid-template-columns: minmax(0,1fr) minmax(0,auto) minmax(0,1fr);
          align-items: center;
          gap: 12px;
          margin: 20px 0 4px;
          color: var(--text-muted);
          font-size: 12px;
        }
        .report-version-divider div {
          height: 1px;
          background: var(--border);
        }
        .report-version-divider span {
          padding: 4px 10px;
          border: 1px solid var(--border);
          border-radius: 999px;
          background: var(--bg-surface);
          text-align: center;
          max-width: min(680px, calc(100vw - 48px));
          white-space: normal;
        }
        @media (max-width: 860px) {
          .observe-summary-grid,
          .experience-stat-grid,
          .observe-action-funnel-grid {
            grid-template-columns: 1fr !important;
          }
          #metric-guide-toolbar {
            right: 12px;
          }
          #metric-guide-panel {
            right: 12px;
            width: calc(100vw - 24px);
          }
        }
        .timeline-followup-source {
          display: block;
          margin: -2px;
          padding: 2px;
          border-radius: 5px;
          background: rgba(202,138,4,.06);
          box-shadow: inset 3px 0 0 rgba(202,138,4,.45);
        }
        .metric-followup { background: rgba(202,138,4,.10); color: var(--yellow); border-color: rgba(202,138,4,.25); }
        .metric-user-message { background: rgba(37,99,235,.08); color: var(--accent); border-color: rgba(37,99,235,.20); }
        .metric-correction { background: rgba(37,99,235,.12); color: var(--accent); border-color: rgba(37,99,235,.25); }
        .metric-goal-shift { background: rgba(14,165,233,.12); color: #0284c7; border-color: rgba(14,165,233,.25); }
        .metric-interruption { background: rgba(236,72,153,.12); color: #be185d; border-color: rgba(236,72,153,.25); }
        .metric-negative { background: rgba(220,38,38,.12); color: var(--red); border-color: rgba(220,38,38,.25); }
	        .metric-positive { background: rgba(22,163,74,.12); color: var(--green); border-color: rgba(22,163,74,.25); }
	        .metric-completion { background: rgba(22,163,74,.10); color: var(--green); border-color: rgba(22,163,74,.22); }
        .metric-hard-rule { background: rgba(126,34,206,.12); color: #7e22ce; border-color: rgba(126,34,206,.25); }
        .metric-repeated-execution { background: rgba(217,119,6,.13); color: #b45309; border-color: rgba(217,119,6,.28); }
        .metric-hedging { background: rgba(14,165,233,.12); color: #0284c7; border-color: rgba(14,165,233,.25); }
        .metric-explicit { background: rgba(220,38,38,.12); color: var(--red); border-color: rgba(220,38,38,.25); }
        .metric-tool-use { background: rgba(202,138,4,.10); color: var(--yellow); border-color: rgba(202,138,4,.25); }
        .metric-tool-success { background: rgba(22,163,74,.10); color: var(--green); border-color: rgba(22,163,74,.24); }
        .metric-tool-bash { background: rgba(202,138,4,.12); color: var(--yellow); border-color: rgba(202,138,4,.28); }
        .metric-tool-read { background: rgba(14,165,233,.12); color: #0284c7; border-color: rgba(14,165,233,.25); }
        .metric-tool-grep { background: rgba(22,163,74,.12); color: var(--green); border-color: rgba(22,163,74,.25); }
        .metric-tool-glob { background: rgba(22,163,74,.08); color: var(--green); border-color: rgba(22,163,74,.18); }
        .metric-tool-edit,
        .metric-tool-write { background: rgba(126,34,206,.10); color: #a855f7; border-color: rgba(126,34,206,.25); }
        .metric-tool-failure { background: rgba(220,38,38,.14); color: var(--red); border-color: rgba(220,38,38,.28); }
        .metric-skill-context { background: var(--bg-muted); color: var(--text-muted); border-color: var(--border); }
        .metric-neutral { background: var(--bg-muted); color: var(--text-muted); border-color: var(--border); }
        .timeline-badge.metric-followup,
        .timeline-badge.metric-user-message,
        .timeline-badge.metric-correction,
        .timeline-badge.metric-goal-shift,
        .timeline-badge.metric-interruption,
        .timeline-badge.metric-negative,
        .timeline-badge.metric-positive,
        .timeline-badge.metric-completion,
        .timeline-badge.metric-hard-rule,
        .timeline-badge.metric-repeated-execution,
        .timeline-badge.metric-hedging,
        .timeline-badge.metric-explicit,
        .timeline-badge.metric-tool-use,
        .timeline-badge.metric-tool-success,
        .timeline-badge.metric-tool-bash,
        .timeline-badge.metric-tool-read,
        .timeline-badge.metric-tool-grep,
        .timeline-badge.metric-tool-glob,
        .timeline-badge.metric-tool-edit,
        .timeline-badge.metric-tool-write,
        .timeline-badge.metric-tool-failure,
        .timeline-badge.metric-skill-context,
        .timeline-badge.metric-neutral {
          background: rgba(107,114,128,.08);
          color: var(--text-secondary);
          border-color: rgba(107,114,128,.16);
        }
        .timeline-row.is-cta-focus .timeline-card {
          border-color: rgba(37,99,235,.62);
          box-shadow: 0 0 0 2px rgba(37,99,235,.18);
        }
      `;
