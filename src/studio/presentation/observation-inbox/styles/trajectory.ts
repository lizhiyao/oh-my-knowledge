export const OBSERVATION_INBOX_TRAJECTORY_STYLES = `        .experience-timeline {
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
`;
