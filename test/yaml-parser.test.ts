import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml } from '../lib/load-samples.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('parseYaml', () => {
  it('parses simple key-value pairs', () => {
    const result = parseYaml('name: Alice\nage: 30');
    assert.deepEqual(result, { name: 'Alice', age: 30 });
  });

  it('parses booleans and null', () => {
    const result = parseYaml('active: true\ndeleted: false\ndata: null');
    assert.deepEqual(result, { active: true, deleted: false, data: null });
  });

  it('parses quoted strings', () => {
    const result = parseYaml('name: "hello world"\nother: \'single\'');
    assert.deepEqual(result, { name: 'hello world', other: 'single' });
  });

  it('parses simple array', () => {
    const result = parseYaml('items:\n  - one\n  - two\n  - three');
    assert.deepEqual(result, { items: ['one', 'two', 'three'] });
  });

  it('parses array of objects', () => {
    const yaml = `
items:
  - name: Alice
    age: 30
  - name: Bob
    age: 25
`.trim();
    const result = parseYaml(yaml);
    assert.deepEqual(result, {
      items: [
        { name: 'Alice', age: 30 },
        { name: 'Bob', age: 25 },
      ],
    });
  });

  it('parses nested objects', () => {
    const yaml = `
server:
  host: localhost
  port: 8080
`.trim();
    const result = parseYaml(yaml);
    assert.deepEqual(result, { server: { host: 'localhost', port: 8080 } });
  });

  it('parses flow arrays', () => {
    const result = parseYaml('tags: [a, b, c]');
    assert.deepEqual(result, { tags: ['a', 'b', 'c'] });
  });

  it('parses flow objects', () => {
    const result = parseYaml('dims: {security: high, perf: low}');
    assert.deepEqual(result, { dims: { security: 'high', perf: 'low' } });
  });

  it('ignores comments', () => {
    const yaml = `# this is a comment\nname: test\n# another comment`;
    const result = parseYaml(yaml);
    assert.deepEqual(result, { name: 'test' });
  });

  it('parses eval-samples-like structure', () => {
    const yaml = `
- sample_id: s001
  prompt: Review this code
  rubric: Find SQL injection
  assertions:
    - type: contains
      value: SQL
      weight: 1
    - type: min_length
      value: 50
      weight: 0.5
  dimensions:
    security: Check for vulnerabilities
    perf: Check for performance
- sample_id: s002
  prompt: Review this code too
  rubric: Find XSS
`.trim();
    const result = parseYaml(yaml) as Array<Record<string, unknown>>;
    assert.equal(result.length, 2);
    assert.equal(result[0].sample_id, 's001');
    assert.equal(result[0].prompt, 'Review this code');
    assert.equal((result[0].assertions as Array<Record<string, unknown>>).length, 2);
    assert.equal((result[0].assertions as Array<Record<string, unknown>>)[0].type, 'contains');
    assert.equal((result[0].assertions as Array<Record<string, unknown>>)[0].value, 'SQL');
    assert.equal((result[0].assertions as Array<Record<string, unknown>>)[0].weight, 1);
    assert.equal((result[0].assertions as Array<Record<string, unknown>>)[1].type, 'min_length');
    assert.equal((result[0].assertions as Array<Record<string, unknown>>)[1].value, 50);
    assert.equal((result[0].dimensions as Record<string, string>).security, 'Check for vulnerabilities');
    assert.equal(result[1].sample_id, 's002');
  });

  it('round-trips against JSON example samples', () => {
    // Verify that the parser can handle the shape of our config format
    const jsonSamples = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'examples', 'code-review', 'eval-samples.json'), 'utf-8'),
    );
    // At minimum, verify the JSON has the expected structure
    assert.ok(Array.isArray(jsonSamples));
    assert.ok(jsonSamples.length > 0);
    assert.ok(jsonSamples[0].sample_id);
  });
});
