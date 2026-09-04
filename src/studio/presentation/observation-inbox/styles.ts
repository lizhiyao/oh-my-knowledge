import { OBSERVATION_INBOX_EXPERIENCE_STYLES } from './styles/experience.js';
import { OBSERVATION_INBOX_METRIC_STYLES } from './styles/metrics.js';
import { OBSERVATION_INBOX_REVIEW_STYLES } from './styles/review.js';
import { OBSERVATION_INBOX_SHELL_STYLES } from './styles/shell.js';
import { OBSERVATION_INBOX_TRAJECTORY_STYLES } from './styles/trajectory.js';

/** Order is part of CSS precedence; section modules only partition ownership. */
export const OBSERVATION_INBOX_STYLES = OBSERVATION_INBOX_SHELL_STYLES
  + OBSERVATION_INBOX_REVIEW_STYLES
  + OBSERVATION_INBOX_EXPERIENCE_STYLES
  + OBSERVATION_INBOX_TRAJECTORY_STYLES
  + OBSERVATION_INBOX_METRIC_STYLES;
