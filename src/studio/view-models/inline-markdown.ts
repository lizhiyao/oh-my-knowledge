export type InlineNode =
  | { nodeKind: 'text'; value: string }
  | { nodeKind: 'code'; value: string }
  | { nodeKind: 'strong'; children: InlineNode[] }
  | { nodeKind: 'emphasis'; children: InlineNode[] }
  | { nodeKind: 'link'; href: string; children: InlineNode[] };
