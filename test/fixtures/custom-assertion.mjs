/**
 * Example custom assertion for testing.
 * Checks if the output contains a specific keyword count.
 */
export default function (output, { assertion }) {
  const keyword = assertion.keyword || 'SQL';
  const minCount = assertion.minCount || 1;
  const matches = output.match(new RegExp(keyword, 'gi')) || [];
  const pass = matches.length >= minCount;
  return {
    pass,
    message: pass
      ? `Found "${keyword}" ${matches.length} time(s)`
      : `Expected "${keyword}" at least ${minCount} time(s), found ${matches.length}`,
  };
}
