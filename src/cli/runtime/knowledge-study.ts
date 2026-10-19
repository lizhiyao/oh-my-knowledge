// Internal repository tool composition root. Not a public SDK export or an oclif command.
import { executeLocalExtractionStudy as executeStudyApplication } from '../../knowledge/application/study-local.js';
import { createExtractionArchiveProducer } from '../../executors/archive.js';

/** The delivery host supplies the concrete executor; knowledge application consumes only its stable port. */
export function executeLocalExtractionStudy(input: Omit<Parameters<typeof executeStudyApplication>[0], 'producer'> & {
  environment: NodeJS.ProcessEnv;
}) {
  const { environment, ...request } = input;
  return executeStudyApplication({ ...request, producer: createExtractionArchiveProducer(Object.freeze({ ...environment })) });
}
