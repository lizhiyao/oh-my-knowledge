import { z } from 'zod';

export const TraceSourceKindSchema = z.enum([
  'claude',
  'codex',
  'dsh',
  'openclaw',
  'qoder',
  'markdown_log',
  'unknown',
]);
