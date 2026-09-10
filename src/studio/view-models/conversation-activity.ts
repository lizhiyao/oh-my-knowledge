export interface ConversationActivitySnapshot {
  schemaVersion: 1;
  revision: string;
  runningCount: number;
}

export interface ConversationDetailActivitySnapshot {
  schemaVersion: 1;
  revision: string;
  taskCount: number;
  runningCount: number;
}
