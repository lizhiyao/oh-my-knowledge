import { z } from 'zod';
import { createCarrierMeasurementService, findCarrierMeasurementOrigin } from '../../../eval-workflows/hosts/carrier-measurement.js';
import { createNodeCoreContentStore, createNodeCoreRunArtifactStore } from '../../../eval-workflows/artifact-store/index.js';
import { projectLayout } from '../../../evidence/storage/layout.js';
import { join, resolve } from 'node:path';
import type { CoreStudioCatalog, CoreStudioRunCard } from '../../view-models/measure/core-runs.js';
import { createCoreStudioCatalog } from './core-run-catalog.js';

const text=z.string().trim().min(1).max(4096); const id=z.string().uuid();
const schema=z.discriminatedUnion('operation',[
  z.strictObject({operation:z.literal('preview'),input:z.unknown()}),
  z.strictObject({operation:z.literal('start'),workspace:text,id}),
  z.strictObject({operation:z.literal('status'),workspace:text,id}),
  z.strictObject({operation:z.literal('cancel'),workspace:text,id}),
  z.strictObject({operation:z.literal('list'),workspace:text,artifactId:id,version:z.number().int().positive()}),
]);
export function createStudioCarrierMeasurement(service=createCarrierMeasurementService()) {
  return {close:()=>service.close(), async execute(raw:unknown,lang:'zh'|'en',signal?:AbortSignal) {
    const request=schema.parse(raw);
    if(request.operation==='preview') return service.preview(request.input,lang,signal);
    if(request.operation==='start') return service.start(request.workspace,request.id,lang);
    if(request.operation==='cancel') return service.cancel(request.workspace,request.id);
    if(request.operation==='status') return service.status(request.workspace,request.id);
    return service.list(request.workspace,request.artifactId,request.version);
  }};
}
/** Explicit selected workspace uses the same standard project eval store as the writer. */
export function carrierMeasureCatalog(workspace:string, base?:CoreStudioCatalog):CoreStudioCatalog {
  const directory=projectLayout(resolve(workspace)).evalDir;
  const local=createCoreStudioCatalog(createNodeCoreRunArtifactStore(directory,{contentResolver:createNodeCoreContentStore(join(directory,'content'))}));
  if(!base)return local;
  const same=(a:CoreStudioRunCard,b:CoreStudioRunCard)=>{if(a.artifactSetDigest!==b.artifactSetDigest || a.runContractDigest!==b.runContractDigest)throw new Error('measurement_source_identity_conflict');};
  return {async list(){const rows=new Map<string,CoreStudioRunCard>();for(const row of [...await base.list(),...await local.list()]){const previous=rows.get(row.runId);if(previous)same(previous,row);rows.set(row.runId,row);}return [...rows.values()];},
    async get(id){const [a,b]=await Promise.all([base.get(id),local.get(id)]);if(a&&b)same(a.run,b.run);return b??a;},
    async inspect(id){const [a,b]=await Promise.all([base.inspect(id),local.inspect(id)]);if(a&&b)same(a,b);return b??a;}};
}

export function carrierMeasureOrigin(workspace:string,runId:string,runContractDigest:string) {
  return findCarrierMeasurementOrigin(workspace,runId,runContractDigest);
}
