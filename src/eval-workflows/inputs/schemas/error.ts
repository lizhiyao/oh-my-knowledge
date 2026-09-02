interface ZodIssueLike {
  readonly code?: string;
  readonly message: string;
  readonly path: readonly PropertyKey[];
  readonly errors?: readonly (readonly ZodIssueLike[])[];
}

export interface DetailedSchemaIssue {
  readonly message: string;
  readonly path: readonly PropertyKey[];
}

function leafIssues(
  issues: readonly ZodIssueLike[],
  prefix: readonly PropertyKey[] = [],
): ZodIssueLike[] {
  const leaves: ZodIssueLike[] = [];
  for (const issue of issues) {
    const path = [...prefix, ...issue.path];
    if (issue.errors?.length) {
      for (const branch of issue.errors) leaves.push(...leafIssues(branch, path));
    } else {
      leaves.push({ ...issue, path });
    }
  }
  return leaves;
}

/** Picks the deepest actionable leaf from nested union failures. */
export function detailedSchemaIssue(error: { readonly issues: readonly unknown[] }): DetailedSchemaIssue {
  const roots = error.issues as readonly ZodIssueLike[];
  const issues = leafIssues(roots);
  const mockReturnRoot = roots.find((issue) => (
    issue.message === 'mock requires exactly one of return, return_file, or return_seq'
  ));
  if (mockReturnRoot) {
    const nonReturnUnknown = issues.find((issue) => (
      issue.code === 'unrecognized_keys'
      && !/"(?:return|return_file|return_seq)"/.test(issue.message)
    ));
    if (!nonReturnUnknown) {
      return { path: mockReturnRoot.path, message: mockReturnRoot.message };
    }
  }
  const selected = issues.sort((left, right) => {
    const leftUnknown = left.code === 'unrecognized_keys' ? 1 : 0;
    const rightUnknown = right.code === 'unrecognized_keys' ? 1 : 0;
    const unknown = rightUnknown - leftUnknown;
    if (unknown !== 0) return unknown;
    return right.path.length - left.path.length;
  })[0];
  return selected ?? { path: [], message: 'invalid shape' };
}
