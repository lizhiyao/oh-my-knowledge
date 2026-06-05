# OMK knowledge-gap signal specification

> Status: v0.1 draft (drafted 2026-04-13)
> Purpose: define how omk extracts "knowledge-gap signals" from the agent evaluation process, how they aggregate into a gap rate, and how to track the convergence of a knowledge base's risk exposure.
> Audience: this is a **design / specification** doc — the rationale and the exact algorithm. If you just want to read gap signals in a report, run `omk observe` (see the [CLI reference](../reference/cli)); for one-line term definitions see the [glossary](../reference/glossary).

## 1. Stance and positioning

omk is not a "knowledge-base completeness checker." **No one can tell you your knowledge base is complete** — completeness is unprovable mathematically, and unprovable in engineering practice. Any tool that claims to do this is misleading its users.

What omk is: **a tool that makes a knowledge base's risk exposure quantifiable, trackable, and convergent**. This is the honest design that follows from actively acknowledging the limits of measurement. Its three core actions are:

1. **Quantify** the blind spots in the knowledge base that the current sample set touches.
2. **Track** how those blind spots converge across repeated iterations.
3. **Force** the sample set to be a first-class citizen — you must seriously design and evolve your test samples, otherwise every metric is self-deception.

**Gap rate and coverage are conditional measurement tools, not absolute verdicts.** Every number can only be interpreted bound to the test sample set it depends on. Talking about gap rate apart from the test set is misuse. This thread runs through the entire spec.

---

## 2. Why "gap" needs to be its own metric

omk already has a **coverage** metric — based on the Read / Grep tool calls an agent makes during execution, it computes the fraction of knowledge files that were accessed.

`coverage = knowledge files accessed / total knowledge files`

This metric answers **"how much of the known knowledge base is exercised by the test samples."**

Note that coverage is really a **product of the sample set × knowledge base interaction**, not a property of the knowledge base. Low coverage doesn't mean the knowledge base is bad — it means the samples didn't exercise it fully.

It cannot answer a completely different question: **"how many times did the agent want to find something but couldn't"** — that is, **how much of the knowledge base's blind territory the sample set bumped into.**

For example:

> An agent ran 10 evaluation samples and accessed 100% of all `.claude/knowledge/*.md`, so coverage = 100%.
>
> But in 3 of those samples the model said "I'm not sure which domain this data lives in," in 4 samples `Grep "revenue_schema"` returned empty, and in 2 samples `Read CLAUDE.md` failed — those 9 gap signals currently feed into no metric at all.
>
> The report says "100% coverage," and the reader wrongly concludes there are no blind spots.

**High coverage ≠ no gaps.** A knowledge base can hit 100% coverage and still have plenty of gaps — as long as the files it covered aren't the ones the agent actually needed.

So omk needs an independent metric, **gap rate**, dedicated to tracking "the number of questions the sample set touched that the knowledge base currently can't answer." Like coverage, it is a product of the sample set × knowledge base interaction, not a property of the knowledge base itself.

---

## 3. The core limit: what it can and cannot show

This section comes before the signal definitions because any reader, after seeing the aggregation formula and the signal sources, will ask "so what can this number prove?" Here are the honest answers.

### What it can show (valid claims)

1. **"On this batch of evaluation samples, how many times did the agent hit a knowledge blind spot"** — a factual statement about the current test set, beyond dispute.
2. **"Under the same test set, did gap rate drop from last commit to this one"** — a trend measurement. As long as the test set is held fixed, the change in gap rate is a genuine signal of how the system handles this batch of samples.
3. **"Which specific queries failed"** — the per-item gap list has far more diagnostic value than the aggregate. Every failed `Grep "revenue_schema"` is a **named**, **fixable** gap.
4. **"Did this batch of samples exercise the knowledge base fully"** — coverage answers this.
5. **"Is it moving toward convergence under a stable test set"** — this is gap rate's single most generalizable use.

### What it cannot show (claims you must not make)

1. **"My knowledge base is complete"** — absolutely not. gap rate = 0 only proves "these N samples didn't hit a wall," not "there's nothing beyond the wall."
2. **"Will a new user's questions trigger blind spots"** — no. Their questions may lie outside the distribution of your sample set.
3. **"0% gap rate = done"** — no. It only says the current test set is satisfied. See Section 8, "Sample evolution."
4. **"What the weak areas of my knowledge base are"** — only within the range the samples happen to probe. Everything else is still a black box.
5. **"Whether my knowledge base is better than another team's"** — completely incomparable unless you use the same test set.

### In one sentence

**Gap rate loses meaning apart from the test sample set it depends on.** Any gap rate number must be reported bound to a test set identifier, otherwise it is misleading. This is a boundary of the measurement method itself, not an engineering problem v0.1 can solve. Compare it to code coverage in software testing: 100% line coverage proves no absence of bugs, yet it is still a valuable metric — provided you understand what it does and does not say.

---

## 4. The four sources of gap signals

omk extracts gap signals from the agent trace in four ways, graded by detection difficulty and signal strength.

### 1. Failed search (strong signal · auto-detectable)

The agent actively tries to query something but the tool returns empty or fails. Concrete criteria:

- A `Grep` tool call whose `output` field is empty / contains "No matches found" / has `success: false`.
- A `Read` tool call with `success: false` where the input is a path the agent constructed itself (not one the user gave in the prompt).
- A `Bash` tool call whose input looks like `grep ... / rg ... / find ...` and whose output is empty or whose exit code is non-zero.

**Why it's a strong signal**: the agent's search behavior itself reflects "I need to know X right now." A failure means "this knowledge base doesn't contain X, or the agent didn't find the right entry point." Every failure is a clear gap candidate.

**Noise sources**: exploratory search (the agent ruling out possibilities), pattern typos. These need dedup at aggregation time — consecutive failed similar searches within the same sample collapse to one gap event.

### 2. Explicit marker (weak signal · text matching)

The agent explicitly flags uncertainty or inference in its own output. omk recognizes the following Chinese / English markers:

- `【推断】` / `【知识缺口】` / `【未知】`
- `[inferred]` / `[unknown]` / `[knowledge gap]`

**Why it's a weak signal**: it relies on the agent's diligence in self-marking, with no enforcement. The model not marking = not counted. This metric's own credibility is bounded by the agent's cooperation.

**Use**: a supplementary signal, helping detect cases where "the agent itself realized there was a gap but didn't actively search."

### 3. Hedging language (weak signal · LLM-assisted second-pass judgment)

Confidence-downgrading phrasing appears in the agent's output text:

- Chinese: "我不确定", "没有足够信息", "需要查证", "无法确认", "猜测", "可能是"
- English: "I'm not sure", "insufficient information", "need to verify", "likely", "presumably"

**Why it's a weak signal**: pure string matching has a high false-positive rate — words like "可能是" / "likely" also appear heavily in business reasoning / hypothesis analysis / polite phrasing, and don't necessarily indicate knowledge-level uncertainty in the agent.

**v0.2 implementation strategy: regex recall → LLM second-pass judgment**

A two-stage pipeline (the v0.1 regex stage from §4 stays unchanged; a classifier filter is added downstream):

1. **Recall stage (regex)**: `extractHedgingSignals` still uses pattern matching to dredge up all "suspect sentences" as candidates to send downstream.
2. **Judgment stage (LLM classifier)**: for each candidate, call a small model with the matched sentence + sample context, and let the model decide "is this sentence knowledge-level uncertainty, or business reasoning / hypothesis / polite phrasing."
3. **Filter**: candidates with `isUncertainty=false` are dropped; those with `isUncertainty=true` are kept as a hedging signal, with the verdict (confidence + reason) attached to `signal.classifierVerdict` for the report side to display.

**Classifier interface contract** (`src/analysis/hedging-classifier.ts`):

```typescript
type HedgingCandidate = {
  sampleId: string;
  sentence: string;       // the sentence matched by the regex
  context: string;        // context snippet (1-2 sentences around it)
};

type HedgingVerdict = {
  isUncertainty: boolean; // true = genuine uncertainty · false = business reasoning / hypothesis
  confidence: number;     // 0-1, classifier self-rating
  reason: string;         // short explanation (for debugging / review)
};

async function classifyHedgingCandidates(
  candidates: HedgingCandidate[],
  executor: LlmExecutor,         // reuses the executor from src/grading/judge.ts
  opts?: { maxCandidates?: number; model?: string },
): Promise<{ verdicts: HedgingVerdict[]; costUSD: number }>;
```

**Key constraints**:

- **Cost cap**: default `maxCandidates = 50` per evaluation; beyond that, truncate + warn (so an outlier sample can't blow up cost).
- **Cache**: in-memory `Map<sha256(sentence), HedgingVerdict>` — the same sentence is not called twice within one process.
- **Failure fallback**: a classifier call failure / parse failure → that candidate defaults to `isUncertainty=true` (conservatively kept; better to over-count soft signals than drop a real one).
- **Weight unchanged**: a hedging signal that passes the classifier still has weight 0.5 (weak signal); the confidence information is only attached to the verdict field for observation, and does not enter the weight calculation directly (avoiding a second uncalibrated dimension).
- **Configuration entry point**: v0.2 goes through a code-level default (enabled + a default model); v0.3 wires up `eval.yaml.hedgingClassifier: { enabled, model, maxCandidates }`.

**Judgment prompt template** (classifier prompt skeleton):

> Given a passage from the agent's output, decide whether it expresses "uncertainty at the knowledge / fact level."
> It counts as "uncertain" if any of the following hold:
>   - It states that it doesn't know the answer / lacks information / needs to verify.
>   - It gives an answer but with markedly downgraded phrasing ("probably X but not sure").
> The following do **not** count as "uncertain":
>   - Business possibility analysis (discussing the possibilities of multiple business scenarios).
>   - Polite / hypothetical phrasing ("if you need it, you could perhaps...").
>   - Uncertainty about the future ("it may in future..."), which is not knowledge uncertainty.
> Return JSON: `{"isUncertainty": bool, "confidence": 0-1, "reason": "..."}`

**Why the weight is still 0.5**: the classifier's second-pass filter mainly reduces false positives, but hedging itself is indirect evidence (unlike failed_search, which is a hard fact at the tool-call level), so the weight retains its weak-signal semantics. Upgrading the weight to 1.0 has to wait until a confidence-calibration experiment in v0.3.

### 4. Repeated tool failure (strong signal · behavioral pattern)

Within the same sample, the agent retries the same class of query more than N times (default N=2). Concrete criteria:

- Same `tool` type (Grep / Read / Bash search).
- Within 3 consecutive turns of the same sample.
- Call count ≥ 3.
- All failed.

**Why it's a strong signal**: repeated failure reflects the agent's genuine confusion — it is trying to solve a problem the knowledge base can't answer. This is far stronger than an isolated single-failure signal.

**Relation to source 1**: source 1 is event-granularity; source 4 is behavioral-pattern granularity. Source 4 can be read as a "severity upgrade" of source 1 — the same gap being detected multiple times means it isn't accidental.

---

## 5. The gap-rate aggregation formula

After the 2026-04-13 discussion, omk adopts a **sample-granularity** aggregation:

```
gap_rate = (samples with any gap signal) / (total samples)
```

Example: 12 samples, of which 5 trigger at least one gap signal, so `gap_rate = 5 / 12 ≈ 41.7%`.

**Why sample granularity**:

- Stable denominator: the total sample count is an inherent size of the evaluation, unaffected by an explosion in agent behavior.
- Easy to interpret: readers can intuitively understand "5 of 12 samples hit a gap."
- Comparable across evaluations: different evaluations may have different sample counts, but a ratio normalizes that.
- Simple to implement: no severity weighting or event-granularity statistics required.

**Why not event granularity**:

Event granularity (total gap-signal occurrences / total agent turns) gets dominated by samples that repeat many times or run especially long. A sample where the agent ran 30 turns, failing Grep in 20 of them, would blow up the whole evaluation's gap rate while really reflecting one sample's local predicament.

**Severity weighting (from v0.2)**:

v0.1 does not distinguish signal severity — all four sources are uniformly "has a signal"; v0.2 introduces weighting to separate hard evidence from soft signals. Each signal falls into one of two tiers per `SIGNAL_WEIGHTS`:

| Signal type | Weight | Tier rationale |
|---------|------|----------|
| `failed_search` | **1.0** (strong) | The agent really called Grep/Read at the tool level and missed — a deterministic miss. |
| `repeated_failure` | **1.0** (strong) | The same class of query failed ≥3 times in a row — no longer accidental. |
| `explicit_marker` | 0.5 (weak) | Relies on the agent marking 【推断】 etc. by convention; may be missed or faked. |
| `hedging` | 0.5 (weak) | regex recall + LLM second-pass judgment (v0.2, see §4.3); when the classifier fails, all are kept. |

Aggregation produces **`weightedGapRate`** (alongside `gapRate`, not replacing it):

```
sample_weight(s) = max(signal.weight for signal in s)  // no signal = 0
weightedGapRate = Σ sample_weight / sampleCount
```

**Why aggregation takes max, not sum**: when failed search + hedging both fire in the same sample, the sample's severity is represented by max (failed search alone is enough to call it a blind spot); sum would double-count the soft signal.

**Using both metrics side by side**:

- `gapRate`: the fraction of samples that triggered any signal (the original v0.1 definition, kept for backward compatibility).
- `weightedGapRate`: the severity-weighted sample mean, **always ≤ `gapRate`**.

The difference `gapRate - weightedGapRate` reflects the "share of soft signals":

- Difference < 10%: signals are mostly hard evidence; the `gapRate` conclusion is trustworthy.
- Difference ≥ 10%: soft signals make up a fair share; `gapRate` may be inflated by hedging / explicit markers — cross-check the weak signals' real meaning against the gap inventory.

**The watermark requirement is unchanged**: both gap rates must carry the test set identifier (§7.1); no standalone value may be reported apart from the test set.

**Sample-size credibility guardrail (observe side)**: gap rate / weightedGapRate and the overall health band are not trustworthy when the segment count is too small — a "red" from 1 segment + one failed search does not carry the same weight as 50 segments all red. observe's `SkillHealth` and `overall` therefore carry a three-tier `confidence` (isomorphic to eval's UNDERPOWERED):

- `underpowered`: segment count < 5 — too few samples; the band / gap rate are indicative only, and the rendering layer softens the hard color band;
- `low`: segment count < 20 — only large gaps are discernible;
- `high`: segment count ≥ 20.

This is conditional measurement, not an absolute verdict: low N does not mean the skill is fine, only that the current observation window is insufficient to conclude — accumulate more real-usage traces before drawing conclusions.

**Special-case handling**:

- If one sample triggers multiple gap signals (e.g. failed Grep + explicit marker), it still counts as 1 sample with a gap. The aggregation is "whether," not "how many."
- If a sample has no complete trace because execution failed (the agent crashed entirely), it is **not counted in the denominator**. gap rate is computed only on successfully-executed samples, keeping the boundary consistent with the coverage metric.

---

## 6. Cross-evaluation trend

A single evaluation's gap rate is the baseline; the real value lies in the trend across multiple evaluations.

omk already has the `src/renderer/trends.ts` cross-evaluation time-series table. This spec requires a new column in that table:

```
| Time | git commit | composite | coverage | gap_rate | Sample set | Sample count | Cost |
```

Note that the `Sample set` (the test set identifier, usually filename + first 8 chars of content hash) must be shown at the same time, otherwise cross-evaluation comparison may mix up numbers from different test sets and be misread.

**Key observation types**:

1. **gap rate decreasing monotonically**: each addition to the knowledge base → gap rate drops → a healthy convergence signal.
2. **gap rate flat**: the added content didn't hit the real gaps → check the priority of uncovered files.
3. **gap rate rising**: either the samples got harder, or the knowledge base was broken, or the sample set was swapped — check the sample set identifier.
4. **gap rate near 0**: **not a moment to celebrate**. See Section 8, "Sample evolution."

**The showpiece result**: a time-series line chart with commit on the x-axis and gap rate on the y-axis, marking each event where content was added to the knowledge base. A curve descending from 60% to 5% is the sharpest single chart in omk's promotional material — provided the chart clearly annotates the test set it depends on.

---

## 7. What action gap rate drives

gap rate is not just a number; it must drive executable action. The report shows at least four classes of information.

### 1. Mandatory test set watermark

Every time a report shows gap rate or coverage, it **must also show**:

- The current test set's file path.
- The total sample count.
- The first 8 chars of the SHA hash of the test set's content (to tell whether the sample set has changed).
- A plain-text warning: "This metric only reflects the interaction between the current test set and the knowledge base, and does not represent the knowledge base's absolute completeness."

This is not a suggestion; it is a **hard requirement of the spec**. A gap rate number without a watermark is treated as invalid at omk's output. The reason: once a number leaves its context it gets misused — a reader seeing "gap rate = 5%" without a watermark will assume it means "the knowledge base is 95% complete," which is exactly the misjudgment omk most wants to avoid.

### 2. Gap inventory (per-evaluation)

Each evaluation report adds a "knowledge gap inventory" block listing the concrete context of every gap signal in that evaluation:

```
Sample s003 / turn 4 / [failed search]
  Grep "revenue_schema" → no matches
  agent self-report: need to verify which domain the revenue field definitions live in

Sample s007 / turn 2 / [explicit marker]
  agent output: 【推断】this data should come from the user_profile table
```

After reading the inventory the reader immediately knows "what I should add" — the failed Grep pattern is very likely the name of the missing knowledge entry.

### 3. Gap classification (per-evaluation)

Count separately by gap-signal source (failed search / explicit marker / hedging language / repeated failure). This tells the reader whether the gaps this evaluation triggered are mostly "what the agent said itself" or "what the agent searched for and couldn't find" — the former means the docs didn't say it clearly, the latter means the knowledge itself doesn't exist.

### 4. CI thresholds (cross-evaluation)

CI mode (`omk eval`) supports two guard modes:

- `--max-gap-rate <number>`: **absolute threshold**. CI fails when gap rate exceeds number. For "the acceptable upper bound we set."
- `--gap-rate-regression <delta>`: **regression threshold**. CI fails when gap rate rises more than delta relative to the last evaluation. For "preventing knowledge-base degradation."

Both modes can be enabled at once. This lifts gap rate from "after-the-fact observation" to a "pre-merge gate," so knowledge-base degradation can't happen silently.

---

## 8. Sample evolution: gap rate near 0 is not the finish line

When a sample set's gap rate comes out near 0 several times in a row, **you should not celebrate — you should expand the samples.**

The reason: a low gap rate has two interpretations:
- **A**: the knowledge base really does cover the domains the test samples ask about.
- **B**: the test samples only asked questions the knowledge base can already answer, avoiding the boundary.

These two cases are **completely indistinguishable** from the gap rate number. The only way to break the tie is to **actively expand the test set to probe new boundaries.**

### Concrete practices for sample evolution (what v0.1 can do)

1. **Manually expand samples**: after an evaluation finishes, look at coverage's uncovered-files list — those files aren't currently touched by any sample and are natural candidates for new samples.
2. **Reverse-engineer from the gap inventory**: failed Grep patterns in the gap inventory (e.g. `revenue_schema`) often reveal the knowledge base's real needs, and can seed new samples.
3. **Periodically reset the baseline**: swap in a fresh batch of test sets each quarter to prevent "domestication" — once your test set has been learned by the knowledge base, it loses its probing value.

### The decision rule for sample evolution

The omk spec recommends (does not enforce): when the same test set's gap rate is **≤ 10% for 3 consecutive evaluations**, the tool automatically appends a line to the report:

> ⚠ The current sample set's gap rate has been below 10% for 3 evaluations in a row. Consider expanding the sample set to probe new areas, otherwise the drop in gap rate may only reflect "sample domestication" rather than "knowledge filled in."

This is a **nudge**, not a fail. The goal is to keep the reader alert when the numbers turn pretty, rather than slipping into a "see green, feel safe" comfort zone.

### Why this rule has to be in the spec

If the spec doesn't make this explicit, gap rate gets misread as a monotonic "low = good" metric. Users will treat "chasing a low gap rate" as the goal, then naturally avoid challenging it with the samples that make gap rate look bad — that is **overfitting to the test set in action**. The spec must repeatedly stress: **gap rate is a diagnostic tool, not a KPI.**

---

## 9. v0.2 outlook: active probing (Competency Questions)

All four signal types defined in the v0.1 spec are **passive** — a gap signal can only be captured when the agent hits a wall while running human-written samples. This means gap rate can only reflect the boundaries that human-written samples happen to touch; areas humans didn't think of stay a black box forever.

v0.2 will introduce **active probing** (competency questions): let the LLM read the knowledge base's structure (filenames, section titles, CLAUDE.md principles) and actively generate questions that "this knowledge base should be able to answer by its scope but may not have covered," as a supplementary sample source. The gap rate from running this generated batch is shown alongside the gap rate from human-written samples — the latter is "the boundary my designed sample set touched," the former is "the boundary exposed by the knowledge base's own structure."

**Why v0.1 doesn't do it**:

1. Engineering complexity: the CQ generation prompt needs careful design, the scoring rubric differs from human-written samples (there's no "ground-truth answer"), and wiring it into the sample pipeline needs a new execution path.
2. Risk: if LLM-generated CQs go off the rails (inventing out-of-scope questions), they pollute gap rate with fake signals and lose credibility instead.
3. v0.1's purpose is to establish the baseline first: only after passive signal collection is stable, the report format works, and trend tracking can draw a chart, do we introduce generative probing. Stacking two uncertain things together lets them pollute each other.

**Related literature**:

- The competency-question method from ontology engineering.
- "Don't Hallucinate, Abstain" (Cole et al., 2024) on LLM-collaborative knowledge-boundary probing.

---

## 10. Known limits and future work

1. **Agent self-marking depends on model cooperation**: source 2 (explicit marker) makes demands of the model. In future the system prompt could make "if you are inferring or uncertain, you must mark it with 【推断】 / 【知识缺口】" explicit, turning it from optional behavior into an enforced convention.

2. **Signal noise**: exploratory search (the agent ruling out possibilities rather than finding an answer) gets misjudged as failed search. v0.1 accepts this noise; v0.2 can introduce "search-intent classification" to denoise.

3. **Cross-sample dedup**: the current spec dedups within a sample (multiple triggers in the same sample count once) but not across samples (two samples both failing to search `revenue_schema` count as 2 gap samples). This is intentional — repeated occurrence means the gap is frequent and should show up in gap rate.

4. **Gap and coverage coexist**: this spec does not replace coverage. Both are results of the **sample set × knowledge base** interaction, but the angles are complementary: coverage measures "how much the sample set utilizes the knowledge base," gap measures "how much of the knowledge base's blind spots the sample set touched." The report should show both. An evaluation that reports `coverage = 80% / gap_rate = 25%` at once is more informative than either metric alone.

5. **Hedging language false positives**: v0.1 uses string matching, known to misjudge. After implementation, if the false-positive rate exceeds 40% (measured), consider temporarily disabling source 3 in v0.1.1, re-enabling it once v0.2's LLM-assisted recognition ships.

---

## Appendix: terminology mapping

| Chinese | English | One-sentence definition |
|------|------|-----------|
| 基于测评用例的知识覆盖率 | Test Case Knowledge Coverage | the fraction of known knowledge accessed by test cases (how much of the knowledge base is exercised by the test cases) |
| 基于测评用例的知识缺口 / 缺口率 | Test Case Knowledge Gap / Gap Rate | the fraction of test cases that trigger a knowledge blind spot (how much unknown territory the test cases bumped into) |
| 缺口信号 | gap signal | a single concrete event of "the agent wanting to find something and failing" |
| 失败搜索 | failed search | a Grep / Read / Bash search tool call that misses |
| 显式标记 | explicit marker | 【推断】【知识缺口】 and other Chinese/English markers in the agent's output text |
| 降级措辞 | hedging language | confidence-downgrading phrasing like "我不确定 / 需要查证 / 可能是" |
| 连续失败 | repeated failure | the behavioral pattern of retrying the same class of query ≥3 times within one sample, all failing |
| 缺口清单 | gap inventory | the per-item context display of gap signals in each evaluation report |
| 强制水印 | test set watermark | the test set identifier + plain-text warning that must accompany a gap rate report |
| 用例进化 | sample evolution | the active strategy that prevents sample domestication when gap rate nears 0 |
| 主动探测 | competency questions | LLM-generated probing questions introduced in v0.2 to supplement passive signals |
