import type { KnowledgeLibraryApplication } from '../../../knowledge/application/library.js';
export type KnowledgeLibraryDetail = ReturnType<KnowledgeLibraryApplication['detail']>;
export type KnowledgeLibraryOwners = ReturnType<KnowledgeLibraryApplication['owners']>;
export type KnowledgeLibraryKnowledge = ReturnType<KnowledgeLibraryApplication['knowledgeCatalog']>;
