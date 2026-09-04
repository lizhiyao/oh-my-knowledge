export const OBSERVATION_INBOX_METRIC_STYLES = `        .timeline-mark {
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
