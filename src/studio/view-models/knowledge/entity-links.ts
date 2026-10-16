import type { EntityLinkApplication } from '../../../observability/application.js';

export type EntityLinkCandidates = ReturnType<EntityLinkApplication['recall']>;
export type EntityLinkPreview = ReturnType<EntityLinkApplication['preview']>;
type EntityLinkInspection = ReturnType<EntityLinkApplication['inspect']>;
export interface EntityLinkStudioPreview {
  workspace: string;
  previewToken: string;
  preview: EntityLinkPreview;
}
export type EntityLinkStudioInspection = EntityLinkInspection & { workspace: string; startToken?: string };
export type EntityLinkStudioList = Array<EntityLinkInspection['projection']>;
