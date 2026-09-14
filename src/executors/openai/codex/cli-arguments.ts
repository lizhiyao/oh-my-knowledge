/** Codex wire arguments. Callers own policy selection and validate their own inputs. */
export interface CodexExecArguments {
  readonly model?: string;
  readonly workingDirectory?: string;
  readonly prompt: string;
  readonly sandbox: 'read-only' | 'workspace-write';
  readonly strictConfig: boolean;
  readonly color?: 'never';
  readonly shellEnvironmentInheritance?: 'none';
  readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export function buildCodexExecArguments(input: Readonly<CodexExecArguments>): string[] {
  return [
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    ...(input.strictConfig ? ['--strict-config'] : []),
    '--skip-git-repo-check',
    ...(input.color === undefined ? [] : ['--color', input.color]),
    '--sandbox', input.sandbox,
    '-c', 'approval_policy="never"',
    ...(input.shellEnvironmentInheritance === undefined
      ? []
      : ['-c', `shell_environment_policy.inherit=${JSON.stringify(input.shellEnvironmentInheritance)}`]),
    ...(input.effort === undefined
      ? []
      : ['-c', `model_reasoning_effort=${JSON.stringify(input.effort)}`]),
    ...(input.model === undefined ? [] : ['--model', input.model]),
    ...(input.workingDirectory === undefined ? [] : ['-C', input.workingDirectory]),
    // A prompt beginning with '-' must remain data, including frontmatter and system text.
    '--', input.prompt,
  ];
}
