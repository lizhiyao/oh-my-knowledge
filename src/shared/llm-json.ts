/** Extract one JSON value from a model response, tolerating fences and introductory prose. */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(trimmed); } catch { /* inspect the first complete object */ }
  const start = trimmed.indexOf('{');
  if (start < 0) throw new Error('LLM response did not contain JSON');
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (escape) { escape = false; continue; }
    if (character === '\\' && inString) { escape = true; continue; }
    if (character === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return JSON.parse(trimmed.slice(start, index + 1));
  }
  throw new Error('LLM response JSON was incomplete');
}
