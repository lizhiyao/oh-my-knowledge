const SAFE_SHELL_ARG_RE = /^[A-Za-z0-9_./:@%+=,-]+$/;

/** Format one POSIX shell argument for user-facing copy/paste commands. */
export function shellQuoteArg(value: string): string {
  if (value && SAFE_SHELL_ARG_RE.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
