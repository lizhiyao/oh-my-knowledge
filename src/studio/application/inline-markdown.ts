import type { InlineNode } from '../view-models/inline-markdown.js';


export function inlineMarkdownText(value: string): string {
  return plainText(parseInline(value));
}

export function parseInline(value: string, depth: number = 0): InlineNode[] {
  if (depth >= 4) return [{ nodeKind: 'text', value }];
  const nodes: InlineNode[] = [];
  let text = '';
  let index = 0;
  const flushText = (): void => {
    if (!text) return;
    nodes.push({ nodeKind: 'text', value: text });
    text = '';
  };

  while (index < value.length) {
    if (value[index] === '\\' && index + 1 < value.length) {
      text += value[index + 1];
      index += 2;
      continue;
    }

    if (value[index] === '`') {
      const closing = value.indexOf('`', index + 1);
      if (closing > index + 1) {
        flushText();
        nodes.push({ nodeKind: 'code', value: value.slice(index + 1, closing) });
        index = closing + 1;
        continue;
      }
    }

    if (value[index] === '[') {
      const labelEnd = value.indexOf('](', index + 1);
      if (labelEnd > index + 1) {
        const urlEnd = matchingParenthesis(value, labelEnd + 1);
        if (urlEnd > labelEnd + 2) {
          flushText();
          nodes.push({
            nodeKind: 'link',
            href: value.slice(labelEnd + 2, urlEnd).trim(),
            children: parseInline(value.slice(index + 1, labelEnd), depth + 1),
          });
          index = urlEnd + 1;
          continue;
        }
      }
    }

    if (value.startsWith('**', index)) {
      const closing = value.indexOf('**', index + 2);
      if (closing > index + 2) {
        flushText();
        nodes.push({
          nodeKind: 'strong',
          children: parseInline(value.slice(index + 2, closing), depth + 1),
        });
        index = closing + 2;
        continue;
      }
    }

    if (value[index] === '*') {
      const closing = value.indexOf('*', index + 1);
      if (closing > index + 1) {
        flushText();
        nodes.push({
          nodeKind: 'emphasis',
          children: parseInline(value.slice(index + 1, closing), depth + 1),
        });
        index = closing + 1;
        continue;
      }
    }

    text += value[index];
    index += 1;
  }
  flushText();
  return nodes;
}

function matchingParenthesis(value: string, opening: number): number {
  if (value[opening] !== '(') return -1;
  let depth = 1;
  for (let index = opening + 1; index < value.length; index += 1) {
    if (value[index] === '\\') {
      index += 1;
      continue;
    }
    if (value[index] === '(') depth += 1;
    if (value[index] === ')') depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

export function plainText(nodes: InlineNode[]): string {
  return nodes.map((node) => (
    node.nodeKind === 'text' || node.nodeKind === 'code'
      ? node.value
      : plainText(node.children)
  )).join('');
}
