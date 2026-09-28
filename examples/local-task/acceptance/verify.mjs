import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const { absolute } = await import(pathToFileURL(resolve('math.mjs')).href);
const checks = [
  { checkId: 'negative', passed: absolute(-3) === 3, detail: 'absolute(-3) must equal 3' },
  { checkId: 'positive-regression', passed: absolute(3) === 3, detail: 'absolute(3) must remain 3' },
  { checkId: 'zero', passed: absolute(0) === 0, detail: 'absolute(0) must equal 0' },
];
console.log(JSON.stringify({ schemaVersion: 'omk.local-task-acceptance/v1', passed: checks.every((check) => check.passed), checks }));
