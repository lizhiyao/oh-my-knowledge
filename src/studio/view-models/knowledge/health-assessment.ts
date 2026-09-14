export interface HealthAssessment {
  score: number | null;
  label: string;
  color: 'green' | 'yellow' | 'red' | 'gray';
}
