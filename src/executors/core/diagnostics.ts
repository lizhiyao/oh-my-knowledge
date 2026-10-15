/** Capture known credentials before async I/O; redact presentation diagnostics only. */
export function createExecutorDiagnosticRedactor(environment: NodeJS.ProcessEnv = process.env): (message: string) => string {
  const credentials = [...new Set(Object.entries(environment)
    .filter(([key]) => /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|SECRET_ACCESS_KEY)$/i.test(key))
    .flatMap(([, value]) => value ? [value, value.trim(), JSON.stringify(value).slice(1, -1)].filter(Boolean) : []))]
    .sort((left, right) => right.length - left.length);
  return (message) => {
    let redacted = message;
    for (const credential of credentials) redacted = redacted.split(credential).join('[REDACTED]');
    return redacted.replace(/(\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[REDACTED]');
  };
}
