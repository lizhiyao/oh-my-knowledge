// Facade: types are split by consumer domain under src/types/. This file
// re-exports the public surface so existing imports `from '../types.js'`
// continue to work. New code should import from the same path; the split
// is an internal organization change.
export * from './types/index.js';
