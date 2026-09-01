export interface ReportServer {
  start: () => Promise<string>;
}

export function parseLastWindow(spec: string): string | null {
  // "7d" / "24h" / "30m" → ISO timestamp (from = now - spec)
  const m = /^(\d+)([dhm])$/.exec(spec);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  const ms = unit === 'd' ? n * 86400_000 : unit === 'h' ? n * 3600_000 : n * 60_000;
  return new Date(Date.now() - ms).toISOString();
}
