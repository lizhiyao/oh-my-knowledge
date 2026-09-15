import { z } from 'zod';
import { studioSettings, saveStudioSettings } from '../../application/settings/settings.js';
import { JSON_HEADERS, writeJsonError } from '../errors.js';
import { RequestBodyError } from '../request-errors.js';
import { readJsonObjectBody } from '../request-errors.js';
import { createStudioRouter } from './router.js';
export function createSettingsRoutes() {
  return createStudioRouter([
    { pattern: '/api/settings', handler({ response }) {
      try { const result = studioSettings(); response.writeHead(200, JSON_HEADERS); response.end(JSON.stringify(result)); }
      catch { writeJsonError(response, 400, 'settings_unavailable'); }
    } },
    { pattern: '/api/settings', method: 'POST', mutation: true, async handler({ request, response }) {
      try {
        const input = z.strictObject({ settings: z.unknown(), revision: z.string() }).parse(await readJsonObjectBody(request));
        const result = saveStudioSettings(input.settings, input.revision);
        response.writeHead(200, JSON_HEADERS); response.end(JSON.stringify(result));
      } catch (error) {
        if (error instanceof RequestBodyError) { writeJsonError(response, error.statusCode, error.code); return; }
        const conflict = error instanceof Error && error.message.includes('conflict');
        writeJsonError(response, conflict ? 409 : 400, conflict ? 'settings_conflict' : 'settings_invalid');
      }
    } },
  ]);
}
