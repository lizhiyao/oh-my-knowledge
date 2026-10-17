import { createHash } from 'node:crypto';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { z } from 'zod';
import { WindowExtractionEnvelopeSchema, WindowExtractionModelSchema } from './window-proposals.js';

type Schema = Record<string, unknown>;
const digest = (value: string | Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const object = (value: unknown): Schema => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON Schema object.');
  return value as Schema;
};
const schemaMap = (value: unknown) => Object.fromEntries(Object.entries(object(value)).map(([key, entry]) => [key, object(entry)]));
const branches = (value: unknown): Schema[] => {
  if (!Array.isArray(value)) throw new Error('Expected JSON Schema branches.');
  return value.map(object);
};
const strings = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) throw new Error('Expected JSON Schema string list.');
  return value;
};
function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

export const WINDOW_EXTRACTION_WIRE_VERSION = 'omk-knowledge-extraction-wire/v1' as const;
export const WINDOW_EXTRACTION_WIRE_PROFILE = 'omk-strict-structural/v1' as const;
// This is generated from the one production Zod schema, never a parallel domain declaration.
const domainSchema = object(z.toJSONSchema(WindowExtractionModelSchema, {
  target: 'draft-2020-12', io: 'input', reused: 'ref', cycles: 'throw', unrepresentable: 'throw',
}));
const resolveRef = (input: Schema): Schema => {
  let schema = input; const seen = new Set<string>();
  while (schema.$ref !== undefined) {
    const ref = schema.$ref;
    if (typeof ref !== 'string' || !/^#\/\$defs\/[^/]+$/.test(ref) || seen.has(ref)) throw new Error('Unsupported/cyclic domain schema reference.');
    seen.add(ref); schema = object(object(domainSchema.$defs)[ref.slice('#/$defs/'.length).replaceAll('~1', '/').replaceAll('~0', '~')]);
  }
  return schema;
};
const allowsNull = (input: Schema): boolean => {
  const schema = resolveRef(input);
  return schema.type === 'null' || (Array.isArray(schema.type) && schema.type.includes('null'))
    || schema.const === null || (Array.isArray(schema.enum) && schema.enum.includes(null))
    || (schema.anyOf !== undefined && branches(schema.anyOf).some(allowsNull))
    || (schema.oneOf !== undefined && branches(schema.oneOf).some(allowsNull));
};
function disjointDiscriminator(options: Schema[]): string {
  const objects = options.map(resolveRef);
  if (objects.some(schema => schema.type !== 'object' || !schema.properties)) throw new Error('Only disjoint object oneOf is supported.');
  for (const name of Object.keys(object(objects[0].properties))) {
    const values = objects.map(schema => {
      if (!strings(schema.required ?? []).includes(name)) return [];
      const property = schemaMap(schema.properties)[name]; if (!property) return [];
      const resolved = resolveRef(property);
      return resolved.const !== undefined ? [resolved.const] : Array.isArray(resolved.enum) ? resolved.enum : [];
    });
    if (values.every(value => value.length) && values.flat().length === new Set(values.flat().map(value => JSON.stringify(value))).size) return name;
  }
  throw new Error('oneOf cannot become anyOf without a disjoint required discriminator.');
}
const HOST_ONLY = new Set(['minLength', 'maxLength', 'pattern', 'format', 'minimum', 'maximum', 'exclusiveMinimum',
  'exclusiveMaximum', 'multipleOf', 'minItems', 'maxItems']);
const SUPPORTED = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', '$defs', '$ref', 'anyOf', 'oneOf',
  'const', 'enum', 'description', 'title', '$schema', ...HOST_ONLY]);
const hostOnly: { schemaPath: string; keyword: string; value: unknown }[] = [];
const nullableOptionals: { schemaPath: string; property: string }[] = [];
const unionConversions: { schemaPath: string; discriminator: string }[] = [];
const wireFor = new Map<Schema, Schema>();

function derive(schema: Schema, path: string): Schema {
  const cached = wireFor.get(schema); if (cached) return cached;
  const wire: Schema = {}; wireFor.set(schema, wire);
  for (const [keyword, value] of Object.entries(schema)) {
    if (!SUPPORTED.has(keyword)) throw new Error(`Unsupported schema keyword at ${path}/${keyword}; update the wire profile explicitly.`);
    if (HOST_ONLY.has(keyword)) { hostOnly.push({ schemaPath: path, keyword, value }); continue; }
    if (keyword === '$schema' || keyword === 'required') continue;
    if (keyword === 'properties') {
      if (schema.additionalProperties !== false) throw new Error('Domain objects must already reject unknown properties.');
      const required = strings(schema.required ?? []);
      wire.properties = Object.fromEntries(Object.entries(schemaMap(value)).map(([name, child]) => {
        const mapped = derive(child, `${path}/properties/${name}`);
        if (required.includes(name)) return [name, mapped];
        // Optional+nullable would conflate an explicit semantic null with omission: refuse schema drift.
        if (allowsNull(child)) throw new Error(`Ambiguous optional nullable field at ${path}/properties/${name}.`);
        nullableOptionals.push({ schemaPath: path, property: name });
        return [name, { anyOf: [mapped, { type: 'null' }] }];
      }));
      wire.required = Object.keys(object(value)); continue;
    }
    if (keyword === '$defs') { wire.$defs = Object.fromEntries(Object.entries(schemaMap(value)).map(([name, child]) => [name, derive(child, `${path}/$defs/${name}`)])); continue; }
    if (keyword === 'items') { wire.items = derive(object(value), `${path}/items`); continue; }
    if (keyword === 'anyOf' || keyword === 'oneOf') {
      const options = branches(value);
      if (keyword === 'oneOf') unionConversions.push({ schemaPath: path, discriminator: disjointDiscriminator(options) });
      wire.anyOf = options.map((child, index) => derive(child, `${path}/${keyword}/${index}`)); continue;
    }
    if (keyword === 'const') { wire.enum = [value]; continue; }
    wire[keyword] = value;
  }
  return wire;
}
const wireSchema = derive(domainSchema, '#');
if (wireSchema.type !== 'object' || wireSchema.anyOf !== undefined) throw new Error('Wire root must be a single object.');
freeze(domainSchema); freeze(wireSchema);
/** Exact identity bytes: UTF-8 JSON.stringify output with no final newline. */
export const WINDOW_EXTRACTION_WIRE_SCHEMA_JSON = JSON.stringify(wireSchema);
export const WINDOW_EXTRACTION_WIRE_SCHEMA: Readonly<Schema> = wireSchema;
export const WINDOW_EXTRACTION_WIRE_IDENTITY = freeze({
  wireVersion: WINDOW_EXTRACTION_WIRE_VERSION, profile: WINDOW_EXTRACTION_WIRE_PROFILE,
  domainSchemaVersion: WindowExtractionModelSchema.shape.schemaVersion.value,
  zodVersion: `${z.core.version.major}.${z.core.version.minor}.${z.core.version.patch}`,
  sourceDomainSchemaDigest: digest(JSON.stringify(domainSchema)), wireSchemaDigest: digest(WINDOW_EXTRACTION_WIRE_SCHEMA_JSON),
  mappingPolicy: 'nonnullable-optional-null-to-absence/v1',
});
export const WINDOW_EXTRACTION_WIRE_ID = digest(JSON.stringify(WINDOW_EXTRACTION_WIRE_IDENTITY));
export const WINDOW_EXTRACTION_WIRE_HOST_ONLY = freeze({
  omittedKeywords: hostOnly, nullableOptionals, disjointUnionConversions: unionConversions,
  // Zod refinements/overwrites are not represented by JSON Schema; original admission stays authoritative.
  additionalChecks: ['Original string trim/nonblank and scalar/array bounds', 'Entity unresolved/candidate conditions',
    'Time interval ordering and timestamp validity', 'Unique IDs, dependency closure, identity/collection/component rules',
    'Exact quote occurrence and identifier boundaries', 'Proposal/entity/mention/evidence/statement references and grounding'],
});
const ajv = new Ajv2020({ strict: true, allErrors: false, coerceTypes: false, useDefaults: false, removeAdditional: false });
const validateWire = ajv.compile(wireSchema);
const branchValidators = new Map<Schema, ValidateFunction>();
function matchesWire(value: unknown, schema: Schema) {
  let validate = branchValidators.get(schema);
  if (!validate) {
    const wire = wireFor.get(schema); if (!wire) throw new Error('Missing derived wire branch.');
    validate = ajv.compile({ ...wire, $defs: wireSchema.$defs }); branchValidators.set(schema, validate);
  }
  return validate(value);
}
function mapToDomain(value: unknown, original: Schema): unknown {
  const schema = resolveRef(original);
  const union = schema.anyOf ?? schema.oneOf;
  if (union !== undefined) {
    const selected = branches(union).filter(branch => matchesWire(value, branch));
    // Invalid/ambiguous item branches stay untouched for the original itemwise host admission.
    if (selected.length !== 1) return value;
    return mapToDomain(value, selected[0]);
  }
  if (value === null) return null; // Existing domain nulls are semantic values, never globally dropped.
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const properties = schemaMap(schema.properties); const required = strings(schema.required ?? []);
    return Object.fromEntries(Object.entries(object(value)).flatMap(([name, child]) => {
      if (!Object.hasOwn(properties, name)) return [[name, child]]; // Preserve, never strip: host rejects the original item.
      if (!required.includes(name) && child === null) return []; // Only declared nonnullable optional placeholders.
      return [[name, mapToDomain(child, properties[name])]];
    }));
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return value;
    return value.map(child => mapToDomain(child, object(schema.items)));
  }
  return value;
}
export interface WireRawEvidence {
  encoding: 'raw-utf8'; bytesBase64: string; byteLength: number; digest: string; text: string | null;
}
export interface WireIssue { instancePath: string; schemaPath: string; keyword: string; message?: string; params: Record<string, unknown> }
export interface WireItemFailure { field: string; index: number; issues: WireIssue[] }
export type WindowWireDecode =
  | { decodeStatus: 'decoded'; wireId: string; raw: WireRawEvidence; wireStatus: 'valid' | 'item_failures'; wireFailures: WireItemFailure[]; domainInput: unknown }
  | { decodeStatus: 'envelope_failure'; wireId: string; raw: WireRawEvidence; failureKind: 'invalid_utf8' | 'invalid_json' | 'invalid_envelope' | 'invalid_wire_envelope' | 'mapping_contract'; issues: unknown[]; error: string };
const wireIssues = (validate: ValidateFunction): WireIssue[] => (validate.errors ?? []).map(issue => ({
  instancePath: issue.instancePath, schemaPath: issue.schemaPath, keyword: issue.keyword,
  ...(issue.message ? { message: issue.message } : {}), params: { ...issue.params },
}));
const itemValidators = Object.entries(schemaMap(domainSchema.properties)).flatMap(([field, node]) => {
  const source = resolveRef(node);
  if (source.type !== 'array') return [];
  const item = object(wireFor.get(source)?.items);
  return [{ field, validate: ajv.compile({ ...item, $defs: wireSchema.$defs }) }];
});

/** Pure decoding only: preserve raw bytes, validate structure, map placeholders. Never call a model or repair content. */
export function decodeWindowExtractionWire(input: Uint8Array): WindowWireDecode {
  const bytes = Buffer.from(input); const text = bytes.toString('utf8');
  const validUtf8 = Buffer.from(text, 'utf8').equals(bytes);
  const raw: WireRawEvidence = { encoding: 'raw-utf8', bytesBase64: bytes.toString('base64'), byteLength: bytes.length,
    digest: digest(bytes), text: validUtf8 ? text : null };
  const failure = (failureKind: Extract<WindowWireDecode, { decodeStatus: 'envelope_failure' }>['failureKind'], error: string, issues: unknown[] = []): WindowWireDecode =>
    ({ decodeStatus: 'envelope_failure', wireId: WINDOW_EXTRACTION_WIRE_ID, raw, failureKind, issues, error });
  if (!validUtf8) return failure('invalid_utf8', 'Input is not valid UTF-8; original bytes retained.');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (error) { return failure('invalid_json', String(error)); }
  const envelope = WindowExtractionEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) return failure('invalid_envelope', 'Original response envelope rejected.', envelope.error.issues);
  const wireValid = validateWire(parsed); const completeIssues = wireValid ? [] : wireIssues(validateWire);
  const wireFailures: WireItemFailure[] = itemValidators.flatMap(({ field, validate }) =>
    (object(parsed)[field] as unknown[]).flatMap((item, index) => validate(item) ? [] : [{ field, index, issues: wireIssues(validate) }]));
  if (!wireValid && !wireFailures.length) return failure('invalid_wire_envelope', 'Wire envelope differs from the frozen contract.', completeIssues);
  try { return { decodeStatus: 'decoded', wireId: WINDOW_EXTRACTION_WIRE_ID, raw,
    wireStatus: wireFailures.length ? 'item_failures' : 'valid', wireFailures, domainInput: mapToDomain(parsed, domainSchema) }; }
  catch (error) { return failure('mapping_contract', String(error)); }
}
