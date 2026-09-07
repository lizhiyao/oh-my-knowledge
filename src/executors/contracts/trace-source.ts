import type { z } from 'zod';
import type { TraceSourceKindSchema } from './trace-source-schema.js';

/** Stable source identity shared by execution evidence and Trace IR. */
export type TraceSourceKind = z.infer<typeof TraceSourceKindSchema>;
