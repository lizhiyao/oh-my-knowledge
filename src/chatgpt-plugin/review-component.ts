import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type {
  ObservationDetail,
  ObservationFeedbackStore,
} from './feedback-store.js';
import {
  OBSERVATION_DRAFT_SCOPE,
  OBSERVATION_REVIEW_SCOPE,
  type ObservationPrincipal,
} from './principal.js';

export const OBSERVATION_REVIEW_RESOURCE_URI = 'ui://omk/observation-review/v1.html';
export const MCP_APP_HTML_MIME_TYPE = 'text/html;profile=mcp-app';

const observedEventKindSchema = z.enum([
  'tool_boundary',
  'user_feedback',
  'submitted_evidence',
]);
const unavailableEventKindSchema = z.enum([
  'full_conversation',
  'external_tool_calls',
  'hidden_reasoning',
]);
const reviewVerdictSchema = z.enum([
  'reviewed',
  'real_issue',
  'not_issue',
  'needs_more_context',
]);
const reviewComponentOutputSchema = {
  observation: z.object({
    observationId: z.string(),
    skillName: z.string(),
    artifactVersion: z.string(),
    firstSeen: z.string(),
    lastSeen: z.string(),
    occurrences: z.number().int().positive(),
    captureCoverage: z.object({
      coverageStatus: z.literal('partial'),
      capturePath: z.literal('explicit_tool_call'),
      observedEventKinds: z.array(observedEventKindSchema),
      unavailableEventKinds: z.array(unavailableEventKindSchema),
    }),
    evidence: z.array(z.object({
      captureId: z.string(),
      capturedAt: z.string(),
      userFeedback: z.string(),
      evidenceSnippet: z.string().optional(),
    })),
    review: z.object({
      verdict: reviewVerdictSchema,
      reviewedAt: z.string(),
      note: z.string().optional(),
    }).optional(),
  }),
  actions: z.object({
    canReview: z.boolean(),
    canDraft: z.boolean(),
  }),
  proposal: z.object({
    prompt: z.string(),
    rubric: z.string().optional(),
  }).optional(),
};

export interface ObservationReviewComponentOptions {
  principal: ObservationPrincipal;
  feedbackStore: ObservationFeedbackStore;
}

export function registerObservationReviewComponent(
  server: McpServer,
  options: ObservationReviewComponentOptions,
): void {
  server.registerResource('omk-observation-review', OBSERVATION_REVIEW_RESOURCE_URI, {
    title: 'OMK observation review',
    description: 'Inspect explicit evidence, record a human verdict, and draft a regression sample.',
    mimeType: MCP_APP_HTML_MIME_TYPE,
  }, async () => ({
    contents: [{
      uri: OBSERVATION_REVIEW_RESOURCE_URI,
      mimeType: MCP_APP_HTML_MIME_TYPE,
      text: observationReviewComponentHtml,
      _meta: {
        ui: {
          prefersBorder: true,
        },
      },
    }],
  }));

  server.registerTool('render_observation_review', {
    title: 'Render an OMK observation review',
    description: [
      'Render the inline review component for an observation.',
      'First call get_observation, propose a regression prompt only from its authorized evidence,',
      'then pass the observationId and optional proposal to this tool.',
    ].join(' '),
    inputSchema: {
      observationId: z.string().trim().min(1).max(128),
      candidatePrompt: z.string().trim().min(1).max(16_000).optional(),
      candidateRubric: z.string().trim().min(1).max(8_000).optional(),
    },
    outputSchema: reviewComponentOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: {
      ui: { resourceUri: OBSERVATION_REVIEW_RESOURCE_URI },
      'openai/toolInvocation/invoking': 'Preparing observation review…',
      'openai/toolInvocation/invoked': 'Observation review ready.',
    },
  }, async ({ observationId, candidatePrompt, candidateRubric }) => {
    const detail = await options.feedbackStore.get(options.principal, observationId);
    const structuredContent = {
      observation: projectObservationForComponent(detail),
      actions: {
        canReview: options.principal.scopes.includes(OBSERVATION_REVIEW_SCOPE),
        canDraft: options.principal.scopes.includes(OBSERVATION_DRAFT_SCOPE),
      },
      proposal: candidatePrompt ? {
        prompt: candidatePrompt,
        rubric: candidateRubric,
      } : undefined,
    };
    return {
      content: [{
        type: 'text' as const,
        text: `已准备 observation ${detail.observationId} 的复核卡片；覆盖范围为 partial。`,
      }],
      structuredContent,
    };
  });
}

function projectObservationForComponent(detail: ObservationDetail) {
  return {
    observationId: detail.observationId,
    skillName: detail.skillName,
    artifactVersion: detail.artifactVersion,
    firstSeen: detail.firstSeen,
    lastSeen: detail.lastSeen,
    occurrences: detail.occurrences,
    captureCoverage: detail.captureCoverage,
    evidence: detail.evidence.map((item) => ({
      captureId: item.captureId,
      capturedAt: item.capturedAt,
      userFeedback: item.userFeedback,
      evidenceSnippet: item.evidenceSnippet,
    })),
    review: detail.review ? {
      verdict: detail.review.verdict,
      reviewedAt: detail.review.reviewedAt,
      note: detail.review.note,
    } : undefined,
  };
}

export const observationReviewComponentHtml = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OMK observation review</title>
  <style>
    :root {
      color-scheme: light dark;
      --canvas: #eef4f6;
      --surface: #fbfdfe;
      --surface-raised: #ffffff;
      --ink: #17212b;
      --muted: #5e6e7c;
      --line: #ccd8de;
      --accent: #2457c5;
      --accent-strong: #173f99;
      --accent-soft: #e3ebff;
      --warning: #9a4d05;
      --warning-soft: #fff0d6;
      --success: #087668;
      --danger: #a33a32;
      --focus: #8bb3ff;
      --radius: 14px;
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      padding: 10px;
      color: var(--ink);
      background: transparent;
    }

    button, textarea, input { font: inherit; }

    button:focus-visible, textarea:focus-visible, summary:focus-visible {
      outline: 3px solid var(--focus);
      outline-offset: 2px;
    }

    .card {
      position: relative;
      overflow: hidden;
      max-width: 760px;
      margin: 0 auto;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface);
      box-shadow: 0 8px 24px rgba(24, 49, 64, 0.09);
    }

    .coverage-rail {
      display: grid;
      grid-template-columns: 8px 1fr;
      background: var(--warning-soft);
      border-bottom: 1px solid #e5c68e;
    }

    .coverage-rail::before {
      content: "";
      background: repeating-linear-gradient(
        -45deg,
        var(--warning) 0,
        var(--warning) 5px,
        #e9a94d 5px,
        #e9a94d 10px
      );
    }

    .coverage-copy { padding: 11px 14px 11px 12px; }

    .coverage-title {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0 0 3px;
      color: #683100;
      font-size: 12px;
      font-weight: 760;
      letter-spacing: 0.035em;
      text-transform: uppercase;
    }

    .coverage-copy p {
      margin: 0;
      color: #704414;
      font-size: 12px;
      line-height: 1.45;
    }

    .header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 14px;
      align-items: start;
      padding: 18px 20px 14px;
    }

    .eyebrow {
      margin: 0 0 5px;
      color: var(--accent);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    h1 {
      margin: 0;
      font-size: clamp(20px, 4vw, 28px);
      line-height: 1.08;
      letter-spacing: -0.025em;
    }

    .meta {
      margin: 7px 0 0;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      overflow-wrap: anywhere;
    }

    .count {
      min-width: 70px;
      padding: 9px 10px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--surface-raised);
      text-align: center;
    }

    .count strong { display: block; font-size: 24px; line-height: 1; }
    .count span { color: var(--muted); font-size: 10px; }

    .section {
      margin: 0 20px;
      padding: 15px 0;
      border-top: 1px solid var(--line);
    }

    .section-heading {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 12px;
      margin-bottom: 10px;
    }

    h2 { margin: 0; font-size: 13px; letter-spacing: 0.01em; }
    .section-hint { color: var(--muted); font-size: 11px; }

    .evidence-list { display: grid; gap: 9px; }

    .evidence {
      padding: 12px 13px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--surface-raised);
    }

    .evidence-time {
      margin: 0 0 7px;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 10px;
    }

    .evidence p { margin: 0; font-size: 13px; line-height: 1.55; white-space: pre-wrap; }

    .snippet {
      margin-top: 8px !important;
      padding-left: 10px;
      border-left: 3px solid var(--accent);
      color: var(--muted);
    }

    .verdict {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .button {
      min-height: 38px;
      padding: 8px 12px;
      border: 1px solid var(--line);
      border-radius: 9px;
      color: var(--ink);
      background: var(--surface-raised);
      cursor: pointer;
      transition: transform 120ms ease, border-color 120ms ease, background 120ms ease;
    }

    .button:hover:not(:disabled) { transform: translateY(-1px); border-color: var(--accent); }
    .button:disabled { cursor: not-allowed; opacity: 0.55; }
    .button.primary { color: #fff; border-color: var(--accent); background: var(--accent); }
    .button.primary:hover:not(:disabled) { background: var(--accent-strong); }
    .button[data-active="true"] { border-color: var(--success); box-shadow: inset 0 0 0 1px var(--success); }

    .field { display: grid; gap: 6px; margin-top: 11px; }
    .field label { color: var(--muted); font-size: 11px; font-weight: 700; }

    textarea {
      width: 100%;
      min-height: 72px;
      resize: vertical;
      padding: 10px 11px;
      border: 1px solid var(--line);
      border-radius: 9px;
      color: var(--ink);
      background: var(--surface-raised);
      line-height: 1.45;
    }

    .draft-panel {
      display: none;
      margin-top: 13px;
      padding: 13px;
      border: 1px solid #b9c8ef;
      border-radius: 10px;
      background: var(--accent-soft);
    }

    .draft-panel[data-visible="true"] { display: block; }
    .draft-panel h3 { margin: 0; font-size: 13px; }
    .draft-panel p { margin: 4px 0 0; color: var(--muted); font-size: 11px; line-height: 1.45; }
    .draft-actions { display: flex; align-items: center; gap: 10px; margin-top: 11px; }

    .status {
      min-height: 18px;
      margin: 10px 0 0;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.4;
    }

    .status[data-tone="error"] { color: var(--danger); }
    .status[data-tone="success"] { color: var(--success); }

    details { margin-top: 8px; color: var(--muted); font-size: 11px; }
    summary { width: fit-content; cursor: pointer; }
    .unavailable { margin: 7px 0 0; padding-left: 18px; line-height: 1.6; }

    .loading { padding: 26px 20px; color: var(--muted); font-size: 13px; }

    @media (max-width: 520px) {
      body { padding: 6px; }
      .header { grid-template-columns: 1fr; padding: 16px 15px 12px; }
      .count { display: flex; align-items: baseline; gap: 6px; width: fit-content; }
      .count strong { font-size: 18px; }
      .section { margin: 0 15px; }
      .verdict { display: grid; }
      .button { width: 100%; }
      .draft-actions { display: grid; }
    }

    @media (prefers-reduced-motion: reduce) {
      .button { transition: none; }
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --canvas: #172127;
        --surface: #172127;
        --surface-raised: #202d34;
        --ink: #edf5f7;
        --muted: #adbbc2;
        --line: #3a4a52;
        --accent: #7ca6ff;
        --accent-strong: #507fde;
        --accent-soft: #23365d;
        --warning: #e5a24b;
        --warning-soft: #3b2d1d;
        --success: #64cdbd;
        --danger: #ff9187;
        --focus: #9fbeff;
      }
      .coverage-rail { border-bottom-color: #654c2c; }
      .coverage-title, .coverage-copy p { color: #f2c17d; }
      .button.primary { color: #10203d; }
      .draft-panel { border-color: #415c93; }
    }
  </style>
</head>
<body>
  <main class="card" aria-live="polite">
    <div id="loading" class="loading">Preparing observation review…</div>
    <div id="content" hidden>
      <section class="coverage-rail" aria-labelledby="coverage-title">
        <div class="coverage-copy">
          <h2 id="coverage-title" class="coverage-title"></h2>
          <p id="coverage-description"></p>
          <details>
            <summary id="coverage-details-label"></summary>
            <ul id="unavailable-list" class="unavailable"></ul>
          </details>
        </div>
      </section>

      <header class="header">
        <div>
          <p id="eyebrow" class="eyebrow"></p>
          <h1 id="skill-name"></h1>
          <p id="observation-meta" class="meta"></p>
        </div>
        <div class="count"><strong id="occurrences"></strong><span id="occurrences-label"></span></div>
      </header>

      <section class="section" aria-labelledby="evidence-heading">
        <div class="section-heading">
          <h2 id="evidence-heading"></h2>
          <span id="evidence-count" class="section-hint"></span>
        </div>
        <div id="evidence-list" class="evidence-list"></div>
      </section>

      <section class="section" aria-labelledby="review-heading">
        <div class="section-heading">
          <h2 id="review-heading"></h2>
          <span id="current-verdict" class="section-hint"></span>
        </div>
        <div id="verdict-actions" class="verdict">
          <button class="button" type="button" data-verdict="real_issue"></button>
          <button class="button" type="button" data-verdict="not_issue"></button>
          <button class="button" type="button" data-verdict="needs_more_context"></button>
        </div>
        <div class="field">
          <label id="note-label" for="review-note"></label>
          <textarea id="review-note" maxlength="500"></textarea>
        </div>
        <p id="review-status" class="status" role="status"></p>

        <div id="draft-panel" class="draft-panel">
          <h3 id="draft-heading"></h3>
          <p id="draft-description"></p>
          <div class="field">
            <label id="prompt-label" for="candidate-prompt"></label>
            <textarea id="candidate-prompt" maxlength="16000"></textarea>
          </div>
          <div class="field">
            <label id="rubric-label" for="candidate-rubric"></label>
            <textarea id="candidate-rubric" maxlength="8000"></textarea>
          </div>
          <div class="draft-actions">
            <button id="draft-button" class="button primary" type="button"></button>
            <span id="draft-status" class="status" role="status"></span>
          </div>
        </div>
      </section>
    </div>
  </main>

  <script>
    (() => {
      const pendingRequests = new Map();
      let nextRequestId = 1;
      let state;
      let busy = false;

      const zh = (navigator.language || "").toLowerCase().startsWith("zh");
      const copy = zh ? {
        loading: "正在准备 observation 复核…",
        coverageTitle: "覆盖范围：部分",
        coverageDescription: "只包含用户明确提交到 OMK 的反馈与证据，不代表完整 ChatGPT 对话。",
        coverageDetails: "查看未观测内容",
        unavailable: {
          full_conversation: "完整 ChatGPT 对话",
          external_tool_calls: "其它工具调用",
          hidden_reasoning: "隐藏推理"
        },
        eyebrow: "显式 knowledge observation",
        occurrences: "次捕获",
        evidence: "用户授权证据",
        evidenceCount: "条",
        review: "人工复核",
        notReviewed: "尚未复核",
        verdict: {
          reviewed: "已复核",
          real_issue: "真实问题",
          not_issue: "不是问题",
          needs_more_context: "需要更多上下文"
        },
        note: "复核备注（可选）",
        notePlaceholder: "记录判断依据，最多 500 字。",
        reviewSaved: "复核结论已保存。",
        reviewFailed: "复核失败：",
        readOnly: "当前连接只有读取权限。",
        draftHeading: "回归样本草稿",
        draftDescription: "只生成候选草稿，不写入正式评测集。请先检查 prompt 与 rubric。",
        prompt: "候选 prompt",
        rubric: "成功标准 rubric（可选）",
        promptPlaceholder: "输入可复现该 knowledge gap 的问题。",
        rubricPlaceholder: "输入可审查的成功标准。",
        createDraft: "生成 sample 草稿",
        draftSaved: "sample 草稿已保存，状态仍为 draft。",
        draftFailed: "生成草稿失败：",
        draftPermission: "当前连接没有生成草稿的权限。",
        emptyEvidence: "没有可展示的授权证据。",
        unknownError: "未知错误"
      } : {
        loading: "Preparing observation review…",
        coverageTitle: "Coverage: partial",
        coverageDescription: "Includes only feedback and evidence explicitly submitted to OMK, not the complete ChatGPT conversation.",
        coverageDetails: "See what was not observed",
        unavailable: {
          full_conversation: "Complete ChatGPT conversation",
          external_tool_calls: "Other tool calls",
          hidden_reasoning: "Hidden reasoning"
        },
        eyebrow: "Explicit knowledge observation",
        occurrences: "captures",
        evidence: "User-authorized evidence",
        evidenceCount: "items",
        review: "Human review",
        notReviewed: "Not reviewed",
        verdict: {
          reviewed: "Reviewed",
          real_issue: "Real issue",
          not_issue: "Not an issue",
          needs_more_context: "Needs more context"
        },
        note: "Review note (optional)",
        notePlaceholder: "Record the reason for this decision, up to 500 characters.",
        reviewSaved: "Review saved.",
        reviewFailed: "Review failed: ",
        readOnly: "This connection has read-only access.",
        draftHeading: "Regression sample draft",
        draftDescription: "Creates a candidate draft only; it does not change the formal eval set. Review the prompt and rubric first.",
        prompt: "Candidate prompt",
        rubric: "Success rubric (optional)",
        promptPlaceholder: "Enter a prompt that reproduces this knowledge gap.",
        rubricPlaceholder: "Enter reviewable success criteria.",
        createDraft: "Create sample draft",
        draftSaved: "Sample saved as a draft; the formal eval set is unchanged.",
        draftFailed: "Draft failed: ",
        draftPermission: "This connection cannot create drafts.",
        emptyEvidence: "No authorized evidence is available.",
        unknownError: "Unknown error"
      };

      document.documentElement.lang = zh ? "zh-CN" : "en";
      document.getElementById("loading").textContent = copy.loading;

      function request(method, params) {
        const id = nextRequestId++;
        window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
        return new Promise((resolve, reject) => pendingRequests.set(id, { resolve, reject }));
      }

      function errorText(error) {
        return error && typeof error.message === "string" ? error.message : copy.unknownError;
      }

      function setStatus(id, message, tone) {
        const element = document.getElementById(id);
        element.textContent = message;
        element.dataset.tone = tone || "";
      }

      function setBusy(nextBusy) {
        busy = nextBusy;
        document.querySelectorAll("button").forEach((button) => {
          button.disabled = busy;
        });
      }

      function formatTime(value) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
      }

      function renderEvidence(observation) {
        const list = document.getElementById("evidence-list");
        list.replaceChildren();
        if (!Array.isArray(observation.evidence) || observation.evidence.length === 0) {
          const empty = document.createElement("p");
          empty.className = "section-hint";
          empty.textContent = copy.emptyEvidence;
          list.append(empty);
          return;
        }
        observation.evidence.forEach((item) => {
          const article = document.createElement("article");
          article.className = "evidence";
          const time = document.createElement("p");
          time.className = "evidence-time";
          time.textContent = formatTime(item.capturedAt);
          const feedback = document.createElement("p");
          feedback.textContent = String(item.userFeedback || "");
          article.append(time, feedback);
          if (item.evidenceSnippet) {
            const snippet = document.createElement("p");
            snippet.className = "snippet";
            snippet.textContent = String(item.evidenceSnippet);
            article.append(snippet);
          }
          list.append(article);
        });
      }

      function render(nextState) {
        if (!nextState || !nextState.observation || !nextState.actions) return;
        state = nextState;
        const observation = state.observation;
        const coverage = observation.captureCoverage || {};
        document.getElementById("loading").hidden = true;
        document.getElementById("content").hidden = false;
        document.getElementById("coverage-title").textContent = copy.coverageTitle;
        document.getElementById("coverage-description").textContent = copy.coverageDescription;
        document.getElementById("coverage-details-label").textContent = copy.coverageDetails;
        const unavailable = document.getElementById("unavailable-list");
        unavailable.replaceChildren();
        (coverage.unavailableEventKinds || []).forEach((eventKind) => {
          const item = document.createElement("li");
          item.textContent = copy.unavailable[eventKind] || String(eventKind);
          unavailable.append(item);
        });
        document.getElementById("eyebrow").textContent = copy.eyebrow;
        document.getElementById("skill-name").textContent = String(observation.skillName || "OMK");
        document.getElementById("observation-meta").textContent =
          String(observation.observationId || "") + " · " + String(observation.artifactVersion || "unknown");
        document.getElementById("occurrences").textContent = String(observation.occurrences || 0);
        document.getElementById("occurrences-label").textContent = copy.occurrences;
        document.getElementById("evidence-heading").textContent = copy.evidence;
        document.getElementById("evidence-count").textContent =
          String((observation.evidence || []).length) + " " + copy.evidenceCount;
        renderEvidence(observation);

        document.getElementById("review-heading").textContent = copy.review;
        document.getElementById("note-label").textContent = copy.note;
        document.getElementById("review-note").placeholder = copy.notePlaceholder;
        const verdict = observation.review && observation.review.verdict;
        document.getElementById("current-verdict").textContent = verdict
          ? copy.verdict[verdict] || verdict
          : copy.notReviewed;
        document.querySelectorAll("[data-verdict]").forEach((button) => {
          const value = button.dataset.verdict;
          button.textContent = copy.verdict[value] || value;
          button.dataset.active = String(value === verdict);
          button.hidden = !state.actions.canReview;
        });
        document.getElementById("review-note").hidden = !state.actions.canReview;
        document.getElementById("note-label").hidden = !state.actions.canReview;
        if (!state.actions.canReview) setStatus("review-status", copy.readOnly, "");

        const draftVisible = verdict === "real_issue";
        const draftPanel = document.getElementById("draft-panel");
        draftPanel.dataset.visible = String(draftVisible);
        document.getElementById("draft-heading").textContent = copy.draftHeading;
        document.getElementById("draft-description").textContent = copy.draftDescription;
        document.getElementById("prompt-label").textContent = copy.prompt;
        document.getElementById("rubric-label").textContent = copy.rubric;
        const prompt = document.getElementById("candidate-prompt");
        const rubric = document.getElementById("candidate-rubric");
        prompt.placeholder = copy.promptPlaceholder;
        rubric.placeholder = copy.rubricPlaceholder;
        if (state.proposal && !prompt.value) prompt.value = String(state.proposal.prompt || "");
        if (state.proposal && !rubric.value) rubric.value = String(state.proposal.rubric || "");
        const draftButton = document.getElementById("draft-button");
        draftButton.textContent = copy.createDraft;
        draftButton.hidden = !state.actions.canDraft;
        if (draftVisible && !state.actions.canDraft) setStatus("draft-status", copy.draftPermission, "");
      }

      async function refreshObservation() {
        const result = await request("tools/call", {
          name: "get_observation",
          arguments: { observationId: state.observation.observationId }
        });
        if (result && result.structuredContent) {
          render({
            observation: result.structuredContent,
            actions: state.actions,
            proposal: state.proposal
          });
        }
      }

      document.querySelectorAll("[data-verdict]").forEach((button) => {
        button.addEventListener("click", async () => {
          if (busy || !state || !state.actions.canReview) return;
          setBusy(true);
          setStatus("review-status", "", "");
          try {
            await request("tools/call", {
              name: "record_observation_review",
              arguments: {
                observationId: state.observation.observationId,
                verdict: button.dataset.verdict,
                note: document.getElementById("review-note").value.trim() || undefined
              }
            });
            await refreshObservation();
            setStatus("review-status", copy.reviewSaved, "success");
          } catch (error) {
            setStatus("review-status", copy.reviewFailed + errorText(error), "error");
          } finally {
            setBusy(false);
          }
        });
      });

      document.getElementById("draft-button").addEventListener("click", async () => {
        if (busy || !state || !state.actions.canDraft) return;
        const prompt = document.getElementById("candidate-prompt").value.trim();
        const rubric = document.getElementById("candidate-rubric").value.trim();
        if (!prompt) {
          document.getElementById("candidate-prompt").focus();
          return;
        }
        setBusy(true);
        setStatus("draft-status", "", "");
        try {
          await request("tools/call", {
            name: "draft_sample_from_observation",
            arguments: {
              observationId: state.observation.observationId,
              prompt,
              rubric: rubric || undefined
            }
          });
          setStatus("draft-status", copy.draftSaved, "success");
        } catch (error) {
          setStatus("draft-status", copy.draftFailed + errorText(error), "error");
        } finally {
          setBusy(false);
        }
      });

      window.addEventListener("message", (event) => {
        if (event.source !== window.parent) return;
        const message = event.data;
        if (!message || message.jsonrpc !== "2.0") return;
        if (message.id !== undefined && pendingRequests.has(message.id)) {
          const pending = pendingRequests.get(message.id);
          pendingRequests.delete(message.id);
          if (message.error) pending.reject(message.error);
          else pending.resolve(message.result);
          return;
        }
        if (message.method === "ui/notifications/tool-result") {
          render(message.params && message.params.structuredContent);
        }
      }, { passive: true });

      if (window.openai && window.openai.toolOutput) render(window.openai.toolOutput);
    })();
  </script>
</body>
</html>`;
