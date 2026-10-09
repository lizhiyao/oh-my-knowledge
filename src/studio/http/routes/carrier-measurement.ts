import { createStudioCarrierMeasurement } from '../../application/measure/carrier-measurement.js';
import { createStudioRouter } from './router.js';
import { readJsonObjectBody, RequestBodyError } from '../request-errors.js';
import { JSON_HEADERS } from '../errors.js';
import type { LiveStreamRegistry } from './contracts.js';

export function createCarrierMeasurementRoutes(live:LiveStreamRegistry,application=createStudioCarrierMeasurement()) {
  const handle=createStudioRouter([{pattern:'/api/knowledge/measurements',method:'POST',mutation:true,async handler({request,response,lang}) {
    const controller=new AbortController(); const cancel=()=>controller.abort(); live.add(cancel); response.once('close',cancel);
    try {const result=await application.execute(await readJsonObjectBody(request),lang,controller.signal);if(!response.destroyed){response.writeHead(200,JSON_HEADERS);response.end(JSON.stringify(result));}}
    catch(cause){if(cause instanceof RequestBodyError)throw cause;if(response.destroyed)return;const message=cause instanceof Error?cause.message:'';const code=/^measurement_(conflict|identical|capacity|samples_unsupported|other_server|judge_required|control_invalid)$/.test(message)?message:'measurement_request_failed';response.writeHead(code==='measurement_conflict'?409:400,JSON_HEADERS);response.end(JSON.stringify({error:code}));}
    finally{live.delete(cancel);response.off('close',cancel);}
  }}]);
  return {handle,close:()=>application.close()};
}
