export const OBSERVATION_INBOX_EXPERIENCE_STYLES = `        .experience-layer-scroll {
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
`;
