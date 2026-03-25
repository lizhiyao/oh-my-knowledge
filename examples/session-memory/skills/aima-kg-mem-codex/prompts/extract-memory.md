You are compressing a finished Claude coding conversation into a reusable memory note.

Your job:
1. Decide whether this conversation contains reusable value worth storing.
2. Classify it into exactly one category.
3. Produce a compact structured summary based on what actually happened.

Allowed categories:
- error_resolution
- user_preference
- workflow_pattern
- debugging_method
- project_convention
- reusable_reference

Only store when at least one of these is true:
- a bug or failure was diagnosed and resolved
- the user expressed a stable preference or correction that should influence future work
- a repeatable workflow or debugging method emerged
- a project convention or reusable reference was established

Do not store when the conversation is mostly:
- casual chat
- trivial one-off edits
- low-signal tool output with no reusable lesson
- incomplete work without any stable takeaway

Return ONLY valid JSON with this shape:

{
  "should_store": true,
  "category": "workflow_pattern",
  "summary": "short one-line summary for humans",
  "confidence": 0.78,
  "keywords": ["memory", "hook", "classification"],
  "request": "what the user wanted",
  "investigated": ["what was inspected"],
  "learned": ["what reusable lessons were extracted"],
  "completed": ["what was actually done"],
  "next_steps": ["what remains if anything"],
  "notes": ["extra context worth keeping"]
}

Rules:
- Keep `summary` under 12 words when possible.
- `confidence` must be between 0 and 1.
- Arrays should contain concise bullet-like strings.
- Prefer reusable abstractions over transcript trivia.
- If it should not be stored, return:
  {
    "should_store": false,
    "category": "workflow_pattern",
    "summary": "",
    "confidence": 0.0,
    "keywords": [],
    "request": "",
    "investigated": [],
    "learned": [],
    "completed": [],
    "next_steps": [],
    "notes": ["brief reason for skipping"]
  }
