# Principles and concepts

`explanation/` answers “what is it, why, and how should I understand it?” It owns concepts and rationale, not independent interfaces, schemas, or acceptance requirements.

## Reading order

1. [How OMK understands knowledge](knowledge.md): Concepts of knowledge, entities, context, and carriers.
2. [Who OMK is for](who-omk-is-for.md): Users, tasks, and product boundaries.
3. [The three stages](three-stage-workflow.md): How doctor, eval, and observe work together.
4. [Architecture](architecture.md): Domain responsibilities and dependency rationale.
5. [Statistical rigor](statistical-rigor.md): Evidence, differences, and limits of conclusions.

## Document responsibilities

| Question | Entry |
|---|---|
| What is it, and why this design? | This directory; define each concept once |
| What behavior, boundaries, and acceptance must implementation satisfy? | [Domain specifications](../specs/index.md), marked current, partly delivered, or draft |
| How does a user complete a task? | [Usage guides](../README.md) and guides/ |
| Where can I look up a field, flag, or API? | reference/, such as the [sample format](../reference/eval-sample-format.md) |
| What did a particular trial or old proposal establish? | The corresponding specs domain's history/; original evidence does not establish current capabilities |

A document may link to another responsibility's authoritative source without duplicating a contract that can drift independently. See the [contributing guide](../guides/contributing.md) for maintenance rules.
