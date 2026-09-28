// Offline wiring control, not an Agent or evidence that either skill is effective.
import { readFile, writeFile } from 'node:fs/promises';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { knowledge } = JSON.parse(input);
if ((await readFile('math.mjs', 'utf8')).includes('Math.abs')) throw new Error('Contaminated initial workspace');
if (knowledge.includes('positive and zero')) {
  await writeFile('math.mjs', 'export function absolute(value) { return Math.abs(value); }\n');
} else if (knowledge.includes('always negating')) {
  await writeFile('math.mjs', 'export function absolute(value) { return -value; }\n');
}
console.log('The bug is fixed.');
