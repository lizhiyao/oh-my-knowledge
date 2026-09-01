import { describe, expect, it } from 'vitest';
import { doctorReportFileStem } from '../../src/measurement-artifacts/file-names.js';

describe('artifact file names', () => {
  it('doctor stem preserves ordinary names and separates lossy-safe collisions', () => {
    expect(doctorReportFileStem('code-review', 'doctor-r1')).toBe('code-review-r1');
    expect(doctorReportFileStem('a:b', 'doctor-r1')).not.toBe(
      doctorReportFileStem('a_b', 'doctor-r1'),
    );
    expect(doctorReportFileStem('skill', 'doctor-a:b')).not.toBe(
      doctorReportFileStem('skill', 'doctor-a_b'),
    );
  });
});
