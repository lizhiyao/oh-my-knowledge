import type { KnowledgeRetrievalProjection } from './retrieval.js';

type Value = null | boolean | number | string | Value[];
const pools = ['knowledge', 'entities', 'sources', 'evidence', 'items'] as const;
const names = { knowledge: 'knowledge', entities: 'entity', sources: 'source', evidence: 'evidence', items: 'item' };
const encoding = 'typed-columns/v1' as const;
const legend = 'In rows: [n,...] uses types[n-1].columns (n>0); [0,...] is an array; [-1,i] is exact strings[i]. Other scalars are literal. No defaults.';
/** A response-local, lossless representation of the named locator projection, not a storage format. */
export interface KnowledgeRetrievalResult {
  projectionKind: 'knowledge-task-context'; schemaVersion: 2; encoding: typeof encoding; legend: string;
  types: { name: string; columns: string[] }[]; strings: string[];
  omitted: KnowledgeRetrievalProjection['omitted']; scopeDiagnostics?: KnowledgeRetrievalProjection['scopeDiagnostics'];
  knowledge: Value[][]; entities: Value[][]; sources: Value[][]; evidence: Value[][]; items: Value[][];
}
export function encodeKnowledgeContext(projection: KnowledgeRetrievalProjection): KnowledgeRetrievalResult {
  const counts = new Map<string, number>();
  const count = (value: unknown): void => {
    if (typeof value === 'string') counts.set(value, (counts.get(value) ?? 0) + 1);
    else if (Array.isArray(value)) value.forEach(count);
    else if (value && typeof value === 'object') Object.values(value).forEach(count);
  };
  pools.forEach(pool => count(projection[pool]));
  const strings: string[] = [], stringIndices = new Map<string, number>();
  for (const [value, frequency] of counts) {
    const length = Buffer.byteLength(JSON.stringify(value)), referenceLength = JSON.stringify([-1, strings.length]).length;
    if (frequency * (length - referenceLength) > length + 1) { stringIndices.set(value, strings.length); strings.push(value); }
  }
  const types: KnowledgeRetrievalResult['types'] = [], shapes = new Map<string, number>(), usedNames = new Set<string>();
  const put = (value: unknown, name: string): Value => {
    if (typeof value === 'string') { const index = stringIndices.get(value); return index === undefined ? value : [-1, index]; }
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
    if (Array.isArray(value)) return [0, ...value.map(item => put(item, name))];
    if (!value || typeof value !== 'object') throw new Error('Knowledge context must contain only JSON values.');
    const columns = Object.keys(value), key = JSON.stringify(columns);
    let index = shapes.get(key);
    if (index === undefined) {
      index = types.length; shapes.set(key, index);
      const typeName = usedNames.has(name) ? `${name}${index + 1}` : name; usedNames.add(typeName);
      types.push({ name: typeName, columns });
    }
    return [index + 1, ...columns.map(column => put((value as Record<string, unknown>)[column], column))];
  };
  const result: KnowledgeRetrievalResult = { projectionKind: 'knowledge-task-context', schemaVersion: 2, encoding, legend,
    types, strings, omitted: projection.omitted, ...(projection.scopeDiagnostics ? { scopeDiagnostics: projection.scopeDiagnostics } : {}),
    knowledge: [], entities: [], sources: [], evidence: [], items: [] };
  for (const pool of pools) result[pool] = projection[pool].map(value => put(value, names[pool]) as Value[]);
  return result;
}
/** Decode before dropping pools or consuming individual statements; array positions have no cross-response identity. */
export function decodeKnowledgeContext(packet: KnowledgeRetrievalResult): KnowledgeRetrievalProjection {
  const invalid = (): never => { throw new Error('Invalid knowledge task column context.'); };
  if (packet.projectionKind !== 'knowledge-task-context' || packet.schemaVersion !== 2 || packet.encoding !== encoding || packet.legend !== legend
    || !Array.isArray(packet.types) || !Array.isArray(packet.strings) || packet.strings.some(value => typeof value !== 'string')) invalid();
  for (const type of packet.types) if (!type || typeof type.name !== 'string' || !Array.isArray(type.columns)
    || type.columns.some(column => typeof column !== 'string') || new Set(type.columns).size !== type.columns.length) invalid();
  const get = (value: Value): unknown => {
    if (!Array.isArray(value)) {
      if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
      return invalid();
    }
    const tag = value[0];
    if (tag === 0) return value.slice(1).map(get);
    if (tag === -1) {
      const index = value[1];
      if (value.length !== 2 || typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= packet.strings.length) return invalid();
      return packet.strings[index];
    }
    if (typeof tag !== 'number' || !Number.isInteger(tag) || tag < 1 || tag > packet.types.length) return invalid();
    const columns = packet.types[tag - 1].columns;
    if (value.length !== columns.length + 1) return invalid();
    return Object.fromEntries(columns.map((column, index) => [column, get(value[index + 1])]));
  };
  const result = { projectionKind: 'knowledge-task-context', schemaVersion: 2, omitted: packet.omitted,
    ...(packet.scopeDiagnostics ? { scopeDiagnostics: packet.scopeDiagnostics } : {}) } as KnowledgeRetrievalProjection;
  for (const pool of pools) {
    if (!Array.isArray(packet[pool])) invalid();
    const rows = packet[pool].map(row => { if (!Array.isArray(row) || typeof row[0] !== 'number' || row[0] < 1) return invalid(); return get(row); });
    Object.assign(result, { [pool]: rows });
  }
  return result;
}
