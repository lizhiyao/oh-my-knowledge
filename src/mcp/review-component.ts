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
    title: 'OMK 知识反馈复核',
    description: '查看用户授权的证据，记录人工结论，并生成回归评测草稿。',
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
    title: '复核 OMK 知识反馈',
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
      title: '复核 OMK 知识反馈',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: {
      ui: { resourceUri: OBSERVATION_REVIEW_RESOURCE_URI },
      'openai/toolInvocation/invoking': '正在准备知识反馈复核…',
      'openai/toolInvocation/invoked': '知识反馈复核已就绪。',
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
        text: `已准备知识反馈 ${detail.observationId} 的复核卡片；覆盖范围为部分。`,
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
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OMK 知识反馈复核</title>
  <style>
    :root {
      color-scheme: light dark;
      --paper: #fcfcfb;
      --paper-raised: #ffffff;
      --ink: #18212b;
      --muted: #68737f;
      --line: #dce2e7;
      --soft: #f4f6f7;
      --accent: #167a68;
      --accent-strong: #0f6657;
      --accent-soft: #eaf5f2;
      --warning: #a56a12;
      --warning-soft: #fbf4e7;
      --danger: #a9463d;
      --success: #167a68;
      --focus: #5aa99b;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      padding: 0;
      color: var(--ink);
      background: transparent;
    }

    button, textarea, input { font: inherit; }

    button:focus-visible, textarea:focus-visible, summary:focus-visible {
      outline: 2px solid var(--focus);
      outline-offset: 2px;
    }

    .card {
      position: relative;
      overflow: hidden;
      max-width: 720px;
      margin: 0 auto;
      background: var(--paper);
    }

    .coverage-rail {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      margin: 0 18px 14px;
      padding: 11px 12px;
      border: 1px solid #ead9bb;
      border-radius: 9px;
      background: var(--warning-soft);
    }

    .coverage-rail::before {
      content: "";
      flex: 0 0 auto;
      width: 7px;
      height: 7px;
      margin-top: 5px;
      border-radius: 50%;
      background: var(--warning);
    }

    .coverage-copy { min-width: 0; }

    .coverage-title {
      margin: 0 0 2px;
      color: #70470c;
      font-size: 13px;
      font-weight: 700;
    }

    .coverage-copy p {
      margin: 0;
      color: #765b35;
      font-size: 12px;
      line-height: 1.55;
    }

    .header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
      padding: 18px 18px 12px;
    }

    .eyebrow {
      margin: 0 0 4px;
      color: var(--accent);
      font-size: 12px;
      font-weight: 700;
    }

    h1 {
      margin: 0;
      font-size: clamp(20px, 4vw, 25px);
      line-height: 1.2;
      letter-spacing: -0.02em;
    }

    .meta {
      margin: 6px 0 0;
      color: var(--muted);
      font-size: 11px;
      overflow-wrap: anywhere;
    }

    .count {
      display: inline-flex;
      align-items: baseline;
      gap: 4px;
      padding: 5px 9px;
      border-radius: 999px;
      color: var(--muted);
      background: var(--soft);
      white-space: nowrap;
    }

    .count strong { color: var(--ink); font-size: 12px; line-height: 1; }
    .count span { font-size: 11px; }

    .section {
      position: relative;
      margin: 0 18px;
      padding: 15px 0 15px 28px;
      border-top: 1px solid var(--line);
    }

    .section::before {
      content: attr(data-step);
      position: absolute;
      top: 14px;
      left: 0;
      display: grid;
      width: 18px;
      height: 18px;
      place-items: center;
      border: 1px solid var(--line);
      border-radius: 50%;
      color: var(--muted);
      background: var(--paper);
      font: 600 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    }

    .section + .section::after {
      content: "";
      position: absolute;
      top: -16px;
      left: 9px;
      width: 1px;
      height: 30px;
      background: var(--line);
    }

    .section-heading {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 12px;
      margin-bottom: 10px;
    }

    h2 { margin: 0; font-size: 14px; letter-spacing: 0.01em; }
    .section-hint { color: var(--muted); font-size: 11px; }

    .evidence-list { display: grid; gap: 9px; }

    .evidence {
      padding: 11px 12px;
      border-left: 2px solid var(--accent);
      border-radius: 0 8px 8px 0;
      background: var(--soft);
    }

    .evidence-time {
      margin: 0 0 7px;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 10px;
    }

    .evidence p { margin: 0; font-size: 13px; line-height: 1.65; white-space: pre-wrap; }

    .snippet {
      margin-top: 8px !important;
      padding-left: 10px;
      border-left: 2px solid var(--line);
      color: var(--muted);
    }

    .verdict {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
    }

    .button {
      min-height: 36px;
      padding: 7px 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      color: var(--ink);
      background: var(--paper-raised);
      cursor: pointer;
      transition: border-color 120ms ease, background 120ms ease, color 120ms ease;
    }

    .button:hover:not(:disabled) { border-color: #aeb9c1; background: var(--soft); }
    .button:disabled { cursor: not-allowed; opacity: 0.55; }
    .button.primary { color: #fff; border-color: var(--accent); background: var(--accent); }
    .button.primary:hover:not(:disabled) { background: var(--accent-strong); }
    .button[data-active="true"] { color: #fff; border-color: var(--accent); background: var(--accent); }

    .field { display: grid; gap: 6px; margin-top: 11px; }
    .field label { color: var(--muted); font-size: 11px; font-weight: 600; }

    textarea {
      width: 100%;
      min-height: 68px;
      resize: vertical;
      padding: 10px 11px;
      border: 1px solid var(--line);
      border-radius: 8px;
      color: var(--ink);
      background: var(--paper-raised);
      line-height: 1.55;
    }

    .draft-panel {
      display: none;
      margin-top: 13px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 9px;
      background: var(--soft);
    }

    .draft-panel[data-visible="true"] { display: block; }
    .draft-panel h3 { margin: 0; font-size: 13px; }
    .draft-panel p { margin: 4px 0 0; color: var(--muted); font-size: 11px; line-height: 1.55; }
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

    details { margin-top: 5px; color: var(--muted); font-size: 11px; }
    summary { width: fit-content; cursor: pointer; }
    .unavailable { margin: 7px 0 0; padding-left: 18px; line-height: 1.6; }

    .loading { padding: 22px 18px; color: var(--muted); font-size: 13px; }

    @media (max-width: 520px) {
      .header { padding: 16px 14px 10px; }
      .coverage-rail { margin: 0 14px 12px; }
      .section { margin: 0 14px; padding-left: 26px; }
      .verdict { grid-template-columns: 1fr; }
      .draft-actions { display: grid; }
    }

    @media (prefers-reduced-motion: reduce) {
      .button { transition: none; }
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --paper: #171b1f;
        --paper-raised: #20262b;
        --ink: #edf1f3;
        --muted: #a9b2b9;
        --line: #343c42;
        --soft: #20262b;
        --accent: #53b5a3;
        --accent-strong: #67c8b6;
        --accent-soft: #1d3833;
        --warning: #d6a24e;
        --warning-soft: #332a1c;
        --danger: #f08b82;
        --focus: #73c9ba;
      }
      .coverage-rail { border-color: #564427; }
      .coverage-title { color: #efc77f; }
      .coverage-copy p { color: #d2bb93; }
      .button.primary, .button[data-active="true"] { color: #10241f; }
    }
  </style>
</head>
<body>
  <main class="card" aria-live="polite">
    <div id="loading" class="loading">正在准备复核…</div>
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

      <section class="section" data-step="1" aria-labelledby="evidence-heading">
        <div class="section-heading">
          <h2 id="evidence-heading"></h2>
          <span id="evidence-count" class="section-hint"></span>
        </div>
        <div id="evidence-list" class="evidence-list"></div>
      </section>

      <section class="section" data-step="2" aria-labelledby="review-heading">
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
      let reviewNoteDirty = false;

      const zh = (navigator.language || "").toLowerCase().startsWith("zh");
      const copy = zh ? {
        loading: "正在准备复核…",
        coverageTitle: "仅覆盖已提交内容",
        coverageDescription: "此记录不包含完整对话、其它工具调用或隐藏推理。",
        coverageDetails: "查看范围说明",
        unavailable: {
          full_conversation: "完整对话",
          external_tool_calls: "其它工具调用",
          hidden_reasoning: "隐藏推理"
        },
        unknownUnavailable: "其它未观测内容",
        eyebrow: "知识反馈",
        recordId: "记录",
        artifactVersion: "知识版本",
        unknownVersion: "未标注",
        occurrences: "次记录",
        evidence: "反馈证据",
        evidenceCount: "条",
        review: "人工复核",
        notReviewed: "待复核",
        verdict: {
          reviewed: "已复核",
          real_issue: "真实问题",
          not_issue: "不是问题",
          needs_more_context: "需要更多上下文"
        },
        unknownVerdict: "未知结论",
        note: "判断依据（可选）",
        notePlaceholder: "补充判断依据，最多 500 字。",
        reviewSaved: "复核结论已保存。",
        reviewFailed: "复核失败：",
        readOnly: "当前连接只有读取权限。",
        draftHeading: "回归评测草稿",
        draftDescription: "仅保存候选草稿，不会写入正式评测集。",
        prompt: "复现问题",
        rubric: "通过标准（可选）",
        promptPlaceholder: "输入可以复现该知识问题的提问。",
        rubricPlaceholder: "输入清晰、可核验的通过标准。",
        createDraft: "保存为评测草稿",
        draftSaved: "评测草稿已保存，正式评测集未改变。",
        draftFailed: "保存草稿失败：",
        draftPermission: "当前连接无权保存评测草稿。",
        emptyEvidence: "没有可展示的授权证据。",
        invalidReviewResponse: "复核服务未返回权威状态。",
        invalidDraftResponse: "草稿服务未返回有效结果。",
        unknownError: "未知错误"
      } : {
        loading: "Preparing observation review…",
        coverageTitle: "Coverage: partial",
        coverageDescription: "Includes only feedback and evidence explicitly submitted to OMK, not the complete client conversation.",
        coverageDetails: "See what was not observed",
        unavailable: {
          full_conversation: "Complete client conversation",
          external_tool_calls: "Other tool calls",
          hidden_reasoning: "Hidden reasoning"
        },
        unknownUnavailable: "Other unavailable context",
        eyebrow: "Explicit knowledge observation",
        recordId: "Record",
        artifactVersion: "Knowledge version",
        unknownVersion: "Not specified",
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
        unknownVerdict: "Unknown verdict",
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
        invalidReviewResponse: "The review service did not return authoritative state.",
        invalidDraftResponse: "The draft service did not return a valid result.",
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

      function toolResultError(result) {
        const textItem = result && Array.isArray(result.content)
          ? result.content.find((item) => item && item.type === "text" && typeof item.text === "string")
          : undefined;
        return new Error(textItem && textItem.text ? textItem.text : copy.unknownError);
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

      function formatCount(value, unit) {
        return zh ? String(value) + unit : String(value) + " " + unit;
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
          item.textContent = copy.unavailable[eventKind] || copy.unknownUnavailable;
          unavailable.append(item);
        });
        document.getElementById("eyebrow").textContent = copy.eyebrow;
        document.getElementById("skill-name").textContent = String(observation.skillName || "OMK");
        const artifactVersion = observation.artifactVersion && observation.artifactVersion !== "unknown"
          ? String(observation.artifactVersion)
          : copy.unknownVersion;
        document.getElementById("observation-meta").textContent =
          copy.recordId + " " + String(observation.observationId || "") +
          " · " + copy.artifactVersion + " " + artifactVersion;
        document.getElementById("occurrences").textContent = String(observation.occurrences || 0);
        document.getElementById("occurrences-label").textContent = copy.occurrences;
        document.getElementById("evidence-heading").textContent = copy.evidence;
        document.getElementById("evidence-count").textContent =
          formatCount((observation.evidence || []).length, copy.evidenceCount);
        renderEvidence(observation);

        document.getElementById("review-heading").textContent = copy.review;
        document.getElementById("note-label").textContent = copy.note;
        const reviewNote = document.getElementById("review-note");
        reviewNote.placeholder = copy.notePlaceholder;
        if (!reviewNoteDirty && document.activeElement !== reviewNote) {
          reviewNote.value = String((observation.review && observation.review.note) || "");
        }
        const verdict = observation.review && observation.review.verdict;
        document.getElementById("current-verdict").textContent = verdict
          ? copy.verdict[verdict] || copy.unknownVerdict
          : copy.notReviewed;
        document.querySelectorAll("[data-verdict]").forEach((button) => {
          const value = button.dataset.verdict;
          button.textContent = copy.verdict[value] || copy.unknownVerdict;
          button.dataset.active = String(value === verdict);
          button.hidden = !state.actions.canReview;
        });
        reviewNote.hidden = !state.actions.canReview;
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

      document.querySelectorAll("[data-verdict]").forEach((button) => {
        button.addEventListener("click", async () => {
          if (busy || !state || !state.actions.canReview) return;
          setBusy(true);
          setStatus("review-status", "", "");
          try {
            const result = await request("tools/call", {
              name: "record_observation_review",
              arguments: {
                observationId: state.observation.observationId,
                verdict: button.dataset.verdict,
                note: document.getElementById("review-note").value.trim() || undefined
              }
            });
            const review = result && result.structuredContent && result.structuredContent.review;
            if (!review) throw new Error(copy.invalidReviewResponse);
            reviewNoteDirty = false;
            render({
              observation: { ...state.observation, review },
              actions: state.actions,
              proposal: state.proposal
            });
            setStatus("review-status", copy.reviewSaved, "success");
          } catch (error) {
            setStatus("review-status", copy.reviewFailed + errorText(error), "error");
          } finally {
            setBusy(false);
          }
        });
      });

      document.getElementById("review-note").addEventListener("input", () => {
        reviewNoteDirty = true;
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
          const result = await request("tools/call", {
            name: "draft_sample_from_observation",
            arguments: {
              observationId: state.observation.observationId,
              prompt,
              rubric: rubric || undefined
            }
          });
          if (!result || !result.structuredContent || result.structuredContent.status !== "draft") {
            throw new Error(copy.invalidDraftResponse);
          }
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
          else if (message.result && message.result.isError) {
            pending.reject(toolResultError(message.result));
          } else pending.resolve(message.result);
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
