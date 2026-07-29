# Who omk is for (and what it solves)

> This is omk's positioning note. Before you read the architecture, the statistics, or the three stages, it defines who omk helps, which decisions it supports, and the scope in which those decisions hold. Every design decision (defaults, storage attribution, command shape) should ultimately trace back to this page.

## In one line

**Observe. Measure. Know.** OMK makes knowledge changes in AI applications evidence-backed. It does not assign context-free quality scores. It helps the people who bear the consequences of a change decide whether that change created enough incremental value to ship, under an explicit target audience, task set, model, and acceptance standard.

## First principle: there is no context-free "good knowledge"

People naturally differ in how they understand knowledge and what they require from it. The same prompt / RAG / skill / agent / workflow can help a beginner while distracting an expert, improve one model while degrading another, or raise output quality at an unacceptable cost.

An evaluation result therefore needs an explicit **evaluation contract**:

- the users and tasks being evaluated;
- the model, runtime, and environment;
- the samples, assertions, and human gold that express expectations;
- the constraints on cost, latency, safety, and stability.

The contract does not have to be a standalone configuration file. It is formed by the project's sample set, runtime configuration, and release gates. Eval samples are not neutral truth. They are an executable expression of that contract. omk does not erase differences between people's standards; it makes the standard and its scope explicit, then makes versions comparable under the same contract. "Ready to ship" in a report means: **under this model, sample set, and acceptance standard, the available evidence supports shipping.**

## The problem: two distinct decisions

"Any good?" usually conflates two questions that require different evaluation designs.

**Change efficacy — is this change a real improvement, or noise?** A new knowledge version scores higher, but is that a genuine gain or random eval variation? omk answers with a verdict that carries uncertainty: Bootstrap confidence intervals, length de-biasing, and Krippendorff α when human gold is available, rather than two isolated scores.

**Incremental value — is this knowledge worth maintaining for the target task?** A baseline-vs-skill comparison may measure *necessity* (the model lacked this knowledge) or *implementation quality* (the skill expresses it effectively). If the model already has the capability, a beautifully written skill may add no value. If the samples do not represent the target task, even a significant gain does not generalize. This is a construct-validity question. (See the [sample design guide](../specs/sample-design-spec).)

These decisions can share measurement infrastructure, but they cannot be collapsed into one universal ruler. Authors shipping a revision primarily care about change efficacy; adopters deciding whether to bring in external knowledge care more about incremental value.

## The first workflow

omk's first workflow is the pre-ship loop for a knowledge artifact:

```text
change a skill / prompt / agent artifact
→ doctor: is it structured, runnable, and measurable enough?
→ eval: under this evaluation contract, is the gain credible and are constraints preserved?
→ report / Studio: where does the evidence apply, what failed, and what did it cost?
→ decide ship / don't ship
```

That is the trunk. `observe` matters after real usage exists, but it is not required for omk's first value. A product direction that makes doctor and eval more trustworthy at this context-specific ship/no-ship moment should outrank one that only adds a new surface area.

## Current target users: two hypotheses to validate

**Primary target: authors and maintainers who repeatedly ship knowledge changes.** Not everyone who has written a prompt, but people whose knowledge artifacts are reused, shared, or versioned, and for whom a bad change creates regressions, additional cost, or operational risk. They need to answer: "is this a real improvement for the target task, and is it worth shipping?"

**Secondary target: teams and platform maintainers who bear the consequences of adoption.** They decide whether to introduce, retain, or upgrade external knowledge inputs. They cannot rely only on the author's bundled benchmark; they need to evaluate against their own tasks, constraints, and samples, then record what they adopted and on what evidence (see [evidence-gated management](../specs/evidence-gated-management)).

**Explicitly not the target: passive end-users.** Someone who installs a public skill and uses it directly usually has neither a sample set nor measurement intent; evaluation is additional overhead. omk does not require that person to become an evaluator. Eval artifacts therefore default to the evaluator's project workspace, not a passive user's install directory.

These are omk's **product hypotheses**, not established market facts. In particular, team governance becomes a second pillar only if real teams are willing to define their own evaluation contracts and use them repeatedly. A coherent argument in this document is not proof of demand.

## What would validate the demand

Agreeing that "knowledge changes should have evidence" is not the same as investing time in evaluation. Stronger product signals are:

- a maintainer brings a live change rather than a demo artifact;
- they create or review samples that represent their own requirements;
- report evidence changes a ship, rollback, or sample-expansion decision;
- they run omk again when the next change occurs.

This page can only state **who omk expects to benefit**. Whether those people care enough to bear the evaluation cost must be demonstrated through repeated use. Product priorities should serve users who exhibit those behaviors before expanding for a persona that is logically plausible but not yet present.

## Which stage serves whom

omk's three stages reach different audiences:

- **doctor (check)**: the pre-ship health gate. Authors use it before trusting an eval; adopters can use it to rule out structural, dependency, and measurability problems.
- **eval (evaluate)**: the release decision core. It needs an evaluation contract and measurement intent, so it belongs to author iteration and adoption decisions. Passive users do not need to run it.
- **observe (observe)**: the post-ship feedback loop. It finds gaps in real session traces that the current contract does not cover and feeds the next sample set. It does not replace controlled eval and should not be the first surface a new user must understand.

## Boundaries: what omk doesn't do

- **It doesn't produce a universal knowledge-quality ranking.** Different users and tasks may produce different conclusions. omk compares versions under an explicit contract; it does not assign context-free value.
- **It doesn't extrapolate beyond the evaluation contract.** A report cannot make promises about users, tasks, models, or constraints that its samples did not cover.
- **It doesn't independently adjudicate truth.** omk provides no independent source of truth and does not rule on whether knowledge is correct on its own. It measures results against the cases, assertions, and gold you provide. Factual correctness is testable, but you supply the standard.
- **It doesn't serve passive users.** See above.
- **It doesn't mix the model into the variables.** Hold the model fixed and vary only the knowledge to attribute the difference to the knowledge itself. That is the precondition for "comparable," not a limitation.

## Read next

- [The three stages](./three-stage-workflow): what doctor / eval / observe each do.
- [Architecture](./architecture): how the pieces fit together.
- [Statistical rigor](./statistical-rigor): how the Bootstrap CI / Krippendorff α behind the verdict are computed.
