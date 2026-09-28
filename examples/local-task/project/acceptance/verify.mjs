import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const { cartTotal } = await import(pathToFileURL(resolve('src/cart.mjs')).href);
const cases = [
  ['discount-before-tax', [{ price: 100, quantity: 1 }], { discount: 10, taxRate: 0.1 }, 99],
  ['quantity', [{ price: 12.5, quantity: 2 }], { discount: 5, taxRate: 0.2 }, 24],
  ['no-discount', [{ price: 10, quantity: 1 }], { taxRate: 0.1 }, 11],
  ['no-tax', [{ price: 100, quantity: 1 }], { discount: 10 }, 90],
  ['rounding', [{ price: 12.34, quantity: 1 }], { discount: 0.34, taxRate: 0.075 }, 12.9],
  ['empty', [], {}, 0],
];
const checks = cases.map(([checkId, items, options, expected]) => {
  const actual = cartTotal(items, options);
  return { checkId, passed: actual === expected, detail: `expected=${expected}; actual=${actual}` };
});
console.log(JSON.stringify({ schemaVersion: 'omk.local-task-acceptance/v1', passed: checks.every((check) => check.passed), checks }));
