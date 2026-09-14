export type HealthGrade = 'excellent' | 'good' | 'fair' | 'unhealthy' | 'unscored';

export interface HealthAssessment {
  grade: HealthGrade;
  score: number | null;
  label: string;
  emoji: string;
  color: 'green' | 'yellow' | 'red' | 'gray';
}

