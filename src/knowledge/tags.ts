import { z } from 'zod';
import type { KnowledgeActor } from './contracts.js';

/** User-maintained topics, separate from claims, evidence and extraction transport. */
export const KnowledgeTagsSchema = z.array(z.string().trim().normalize().min(1).max(80)
  .regex(/^[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*$/u)
  .refine(value => /[^\p{N}]/u.test(value), 'Tags must contain a nonnumeric character.')).max(32)
  .transform(values => [...new Map(values.map(value => [value.toLowerCase(), value])).values()]);

export interface KnowledgeTagState { generation: number; tags: string[] }
export interface KnowledgeTagStore {
  read(knowledgeId: string): KnowledgeTagState;
  write(knowledgeId: string, generation: number, tags: unknown, actor: KnowledgeActor): KnowledgeTagState;
}
