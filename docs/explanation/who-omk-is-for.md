# Who omk is for (and what it solves)

> This is omk's positioning note. Before you read the architecture, statistics, or three stages, it explains how knowledge serves people and AI, which capabilities are available, and which directions still need implementation and validation. Every design decision (defaults, storage attribution, command shape) should ultimately trace back to this page.

## In one line

**Observe. Measure. Know.** Make knowledge useful for people and AI. OMK discovers, preserves, and maintains knowledge with sources from real collaboration between people and AI. It helps people build understanding, methods, and reasons for decisions, and gives AI suitable knowledge for later tasks.

OMK delivers these capabilities through the CLI, Studio, eval-runtime, and the DSH plugin: command-line workflows, local inspection and review, evaluation embedded in Node.js services, and integration with an existing DeepSeek Harness profile. The workbench is one interface, not the definition of the whole product.

## The value of knowledge for people and AI

Knowledge can include domain insights, tradeoffs and reasons for decisions, working methods, collaboration experience, and personal or project goals, preferences, and constraints. It can help people understand problems, make decisions, and carry experience forward, while giving AI useful context and methods for later tasks. Its value extends beyond correcting agents or reducing errors.

Observation preserves how this knowledge formed and where it came from, including successful approaches, user corrections, and gaps exposed by failures. Temporary discussion, unverified AI suggestions, user-confirmed understanding, and conclusions validated in practice must remain distinct. Recording or extracting conversation content does not automatically make it reliable knowledge.

OMK is working toward helping users manage, revise, and reuse their knowledge across conversations and agents; this is not fully implemented. Today, users can extract, review, and maintain knowledge from selected records, then generate and save retained knowledge as a skill or prompt. Supporting multiple observation sources is not complete cross-agent knowledge management, and adding knowledge to context does not prove it was used correctly.

## First principle: there is no context-free "good knowledge"

People naturally differ in how they understand knowledge and what they require from it. The same prompt / RAG / skill / agent / workflow can help a beginner while distracting an expert, improve one model while degrading another, or raise output quality at an unacceptable cost.

An evaluation result therefore needs an explicit **evaluation contract**:

- the users and tasks being evaluated;
- the model, runtime, and environment;
- the samples, assertions, and human gold that express expectations;
- the constraints on cost, latency, safety, and stability.

The contract does not have to be a standalone configuration file. It is formed by the project's sample set, runtime configuration, and release gates. Eval samples are not neutral truth. They are an executable expression of that contract. omk does not erase differences between people's standards; it makes the standard and its scope explicit, then makes versions comparable under the same contract. "Ready to ship" in a report means: **under this model, sample set, and acceptance standard, the available evidence supports shipping.**

## Testing AI task effects: two distinct decisions

When testing a knowledge artifact's effects on AI tasks, "Any good?" usually conflates two questions that require different evaluation designs. Controlled evaluation provides evidence for these decisions; it does not replace assessing how knowledge helps people understand, develop methods, or reuse what they learned.

**Change efficacy — is this change a real improvement, or noise?** A new knowledge version scores higher, but is that a genuine gain or random eval variation? omk answers with a verdict that carries uncertainty: Bootstrap confidence intervals, length de-biasing, and Krippendorff α when human gold is available, rather than two isolated scores.

**Incremental value — is this knowledge worth maintaining for the target task?** A baseline-vs-skill comparison may measure *necessity* (the model lacked this knowledge) or *implementation quality* (the skill expresses it effectively). If the model already has the capability, a beautifully written skill may add no value. If the samples do not represent the target task, even a significant gain does not generalize. This is a construct-validity question. (See the [sample design guide](../specs/sample-design-spec).)

These decisions can share measurement infrastructure, but they cannot be collapsed into one universal ruler. Authors shipping a revision primarily care about change efficacy; adopters deciding whether to bring in external knowledge care more about incremental value.

## Choose knowledge-building and verification entry points as needed

Starting from real work, inspect tasks in Studio, extract and review knowledge, preserve conditions and sources, and generate artifacts for later work as needed. Retaining knowledge does not require building an evaluation set every time. Use controlled comparison when you need to test a specific artifact change's effects on tasks.

If you already have two artifact versions, you can start directly with the pre-ship verification path:

```text
change a skill / prompt / agent artifact
→ doctor: is it structured, runnable, and measurable enough?
→ eval: under this evaluation contract, is the gain credible and are constraints preserved?
→ report / Studio: where does the evidence apply, what failed, and what did it cost?
→ decide ship / don't ship
```

This path does not require logs. Knowledge-maintenance decisions should remain traceable to sources; effectiveness judgments also need an evaluation contract and evidence scope. Retaining knowledge, writing an artifact, passing evaluation, and publishing are separate records.

## Who builds knowledge: specific benefits still need validation

**Agent users.** People who want to preserve understanding, methods, and context from working with AI, then consult, revise, and reuse them in later work. They need to know what is worth keeping, its evidence, and where it applies, and gradually use suitable knowledge with different agents. Maintaining knowledge does not require them to take on evaluation work first.

**AI application and knowledge artifact authors and maintainers.** Their knowledge artifacts are reused, shared, or versioned, and a bad change may create regressions, additional cost, or operational risk. They need both to preserve real working experience and to answer: "is this a real improvement for the target task, and is it worth adopting or shipping?"

**Teams and platform maintainers who bear the consequences of adoption.** They decide whether to introduce, retain, or upgrade external knowledge inputs and manage knowledge for their tasks and constraints. When they intend to measure effects, they cannot rely only on the author's bundled benchmark; they should evaluate against their own cases and preserve evidence. Evaluation artifacts default to the evaluator's project workspace, not a user's install directory.

These describe product direction and intended beneficiaries, not established market facts. Whether knowledge preservation is worth its review and maintenance costs, whether reuse across agents brings benefits, and which users need controlled evaluation must be tested through real work.

## What would validate the demand

Agreeing that knowledge has value is not the same as investing time in maintaining or evaluating it. Stronger product signals are:

- a user reviews and retains knowledge from real collaboration, then consults, revises, or reuses it later;
- retained knowledge helps a person understand a problem or make a decision, or helps AI complete a later task correctly;
- a maintainer brings a live change rather than a demo artifact;
- they create or review samples that represent their own requirements;
- report evidence changes a ship, rollback, or sample-expansion decision;
- they run omk again when the next change occurs.

This page can only state **who omk expects to benefit**. Assess actual reuse benefits alongside the costs of reading, review, maintenance, and measurement. Product priorities should follow real use and repeated reuse; counts of logs, reports, or candidates cannot replace that evidence.

## Which needs each entry point serves

Observation, knowledge maintenance, and controlled measurement serve different needs and can be combined for the current goal:

- **Knowledge extraction and maintenance**: organize facts, experience, and methods worth keeping from selected sources; review conditions, revisions, and reasons; generate and explicitly save knowledge artifacts.
- **doctor (check)**: the pre-ship health gate. Authors use it before trusting an eval; adopters can use it to rule out structural, dependency, and measurability problems.
- **eval (evaluate)**: the release decision core. It needs an evaluation contract and measurement intent, so it belongs to author iteration and adoption decisions. Passive users do not need to run it.
- **observe (observe)**: provides real collaboration and sources for knowledge building, including successful approaches, user corrections, and knowledge gaps. These can inform cases when testing a change, but observation signals cannot replace controlled comparison or establish causality.

## Boundaries: what omk doesn't do

- **It doesn't produce a universal knowledge-quality ranking.** Different users and tasks may produce different conclusions. omk compares versions under an explicit contract; it does not assign context-free value.
- **It doesn't extrapolate beyond the evaluation contract.** A report cannot make promises about users, tasks, models, or constraints that its samples did not cover.
- **It doesn't independently adjudicate truth.** omk provides no independent source of truth and does not rule on whether knowledge is correct on its own. It measures results against the cases, assertions, and gold you provide. Factual correctness is testable, but you supply the standard.
- **It doesn't require evaluation for every knowledge-maintenance step.** Users can preserve and reuse knowledge as needed; controlled judgments about task effects still require explicit models, cases, and acceptance standards.
- **It doesn't mix the model into the variables.** Hold the model fixed and vary only the knowledge to attribute the difference to the knowledge itself. That is the precondition for "comparable," not a limitation.

## Read next

- [The three stages](./three-stage-workflow): what doctor / eval / observe each do.
- [Architecture](./architecture): how the pieces fit together.
- [Statistical rigor](./statistical-rigor): how the Bootstrap CI / Krippendorff α behind the verdict are computed.
