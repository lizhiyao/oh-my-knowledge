import { z } from 'zod';
import type { Mock, MockMatch, MockReturn } from '../../../executors/contracts/mock.js';

const mockMatchBaseShape = {
  file_path: z.string().min(1).optional(),
  file_path_endswith: z.string().min(1).optional(),
  command_glob: z.string().min(1).optional(),
  input: z.record(z.string(), z.json()).optional(),
  input_contains: z.string().min(1).optional(),
};

export const MockMatchSchema: z.ZodType<MockMatch> = z.union([
  z.object({ ...mockMatchBaseShape, url: z.string().min(1) }).strict(),
  z.object({ ...mockMatchBaseShape, url_glob: z.string().min(1) }).strict(),
  z.object(mockMatchBaseShape).strict(),
]);

export const MockReturnSchema: z.ZodType<MockReturn> = z.union([
  z.string(),
  z.record(z.string(), z.json()),
]);

const mockBaseShape = {
  tool: z.string().min(1),
  match: MockMatchSchema.optional(),
};

/** Strict authoring shape with exactly one return source. */
export const MockSchema: z.ZodType<Mock> = z.union([
  z.object({ ...mockBaseShape, return: MockReturnSchema }).strict(),
  z.object({ ...mockBaseShape, return_file: z.string().min(1) }).strict(),
  z.object({ ...mockBaseShape, return_seq: z.array(MockReturnSchema).min(1) }).strict(),
], { error: 'mock requires exactly one of return, return_file, or return_seq' });
