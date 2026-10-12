import type { KnowledgeLibraryApplication } from '../../../observability/application.js';
export type KnowledgeLibraryCatalog = ReturnType<KnowledgeLibraryApplication['catalog']>;
export type KnowledgeLibraryDetail = ReturnType<KnowledgeLibraryApplication['detail']>;
export type KnowledgeLibraryOwners = ReturnType<KnowledgeLibraryApplication['owners']>;
