export const OBSERVATION_INBOX_SHELL_STYLES = `
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
`;
