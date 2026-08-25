import { join } from 'node:path';
import { OMK_HOME } from '../eval-core/default-dirs.js';

export const DEFAULT_PROJECT_OBSERVATIONS_DIR = join(process.cwd(), '.omk', 'observe-inbox');
export const DEFAULT_GLOBAL_OBSERVATIONS_DIR = join(OMK_HOME, 'observe-inbox');
export const DEFAULT_OBSERVATIONS_DIR = DEFAULT_PROJECT_OBSERVATIONS_DIR;
