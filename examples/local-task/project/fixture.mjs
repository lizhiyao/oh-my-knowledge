// Deterministic wiring control; the live experiment replaces this executor with Codex.
import { readFile, writeFile } from 'node:fs/promises';
let input = '';
for await (const chunk of process.stdin) input += chunk;
if (JSON.parse(input).knowledge.includes('Implement the requested repair')) {
  const path = 'src/cart.mjs';
  const source = await readFile(path, 'utf8');
  if (!source.includes('subtotal * (1 + taxRate) - discount')) throw new Error('Initial snapshot differs');
  await writeFile(path, source.replace('subtotal * (1 + taxRate) - discount', '(subtotal - discount) * (1 + taxRate)'));
}
console.log('Finished.');
