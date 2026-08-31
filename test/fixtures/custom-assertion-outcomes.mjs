export default function (_output, { assertion }) {
  if (assertion.value === 'throw') {
    throw new Error('fixture custom failure');
  }
  if (assertion.value === 'invalid') {
    return { message: 'fixture invalid result' };
  }
  if (assertion.value === 'timeout') {
    return new Promise(() => {});
  }
  return {
    pass: assertion.value === 'pass',
    message: `fixture ${String(assertion.value)}`,
  };
}
