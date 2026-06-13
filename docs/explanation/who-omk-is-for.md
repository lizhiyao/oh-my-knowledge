# Who omk is for (and what it solves)

> This is omk's positioning note — before you read the architecture, the statistics, or the three stages, here's who omk is for and what it solves for them. Every design decision (defaults, storage attribution, command shape) should ultimately trace back to this page.

## In one line

omk turns "is this knowledge input (prompt / skill / RAG / agent) any good?" from a gut call into a **comparable, evidence-backed decision** — hold the model fixed, vary only the knowledge, and measure the difference with statistical rigor.

## The problem, in two layers

"Any good?" is really two stacked questions.

**Lower layer — is this change a real improvement, or noise?** You revised a prompt / skill, the new version scores higher — but is that a genuine gain or just the random wobble of the eval itself? This is the question everyone asks and the easiest to grasp: "you changed your prompt — did it actually get better?" omk answers with a verdict that carries uncertainty (Bootstrap confidence intervals, length de-biasing, Krippendorff α when you supply a human gold), not two lonely scores.

**Upper layer — is this knowledge worth having at all?** One level up: did the skill actually make the model stronger, or did the model already know this and the skill just reworded existing capability? A baseline-vs-skill comparison can measure *necessity* (the model lacked this knowledge) rather than *quality* (the skill is well written) — both produce impressive verdict numbers while answering different questions. This is a construct-validity question, and it decides whether a piece of knowledge is worth maintaining. (See the [sample design guide](../specs/sample-design-spec).)

The lower layer is what authors ask daily; the upper layer is what adopters / platforms ask when deciding what to use and keep. omk's two-layer ruler maps to two kinds of people.

## Who it's for

**Primary: authors / maintainers of knowledge inputs.** Iterating on a prompt / skill / RAG / agent, needing to answer "is my change a real improvement, and is it shippable?" omk's doctor → eval → observe loop is built for them: change a version, measure, read the verdict, change again.

**Second pillar: adopters / platform-governance teams.** Deciding "should our team use this third-party skill, and which knowledge inputs should we approve and keep?" They don't trust the author's bundled benchmark — they run it against *their own* sample set, and record "what we adopted, on what evidence" as a traceable decision log (see [evidence-gated management](../specs/evidence-gated-management)). This isn't an add-on — the governance gate cites the very reports (reportId) the author loop produces; it's the same evidence at team scale.

**Explicitly NOT for: passive end-users.** Someone who installs a skill from a public source to *use* it won't evaluate it — no sample set, no measurement intent; evaluation is pure overhead for them. omk bends none of its design around that persona. The people who run evals and generate reports are always the two above (the author in their skill / benchmark repo, the adopter in their use-case repo). This settles one thing directly: eval artifacts default to the evaluator's project workspace, not anyone's install directory.

## Which stage serves whom

omk's three stages reach different audiences:

- **doctor (check)** — a cheap pre-flight / smoke test. Authors use it as a CI gate; adopters run it right after install to see "is this skill broken?" Both.
- **eval (evaluate)** — a statistical A/B that needs a sample set and measurement intent. Author iteration + adopter procurement. Passive users don't touch it.
- **observe (observe)** — mines signal from real session traces. This stage is closest to someone actually *using* a skill: no sample set required, it reads their own usage to show "did this skill actually help?"

## Boundaries: what omk doesn't do

- **It doesn't judge whether the knowledge content is "correct."** omk doesn't review prose, grade writing quality, or rule on whether a domain fact is right; it measures whether there's a measurable, comparable difference on the cases you gave it.
- **It doesn't serve passive users.** See above.
- **It doesn't mix the model into the variables.** Hold the model fixed, vary only the knowledge — that's how you attribute the difference to the knowledge itself. It's the precondition for "comparable," not a limitation.

## Read next

- [The three stages](./three-stage-workflow): what doctor / eval / observe each do.
- [Architecture](./architecture): how the pieces fit together.
- [Statistical rigor](./statistical-rigor): how the Bootstrap CI / Krippendorff α behind the verdict are computed.
