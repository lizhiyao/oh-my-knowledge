import { z } from 'zod';

export const TraceSourceKindSchema = z.enum([
  'claude',
  'codex',
  'dsh',
  'openclaw',
  'markdown_log',
  'unknown',
]);
