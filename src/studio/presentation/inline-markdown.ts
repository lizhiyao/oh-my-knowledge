import { e } from './layout.js';

type InlineNode =
  | { nodeKind: 'text'; value: string }
  | { nodeKind: 'code'; value: string }
  | { nodeKind: 'strong'; children: InlineNode[] }
  | { nodeKind: 'emphasis'; children: InlineNode[] }
  | { nodeKind: 'link'; href: string; children: InlineNode[] };

export interface InlineMarkdownOptions {
  links?: 'anchors' | 'text';
  maxLength?: number;
}

export function renderSafeInlineMarkdown(
  value: string,
  options: InlineMarkdownOptions = {},
): string {
  const nodes = parseInline(value);
  const visibleLength = plainText(nodes).length;
  const limitedNodes = options.maxLength !== undefined && visibleLength > options.maxLength
    ? [...takeVisibleText(nodes, Math.max(0, options.maxLength - 1)), { nodeKind: 'text' as const, value: '…' }]
    : nodes;
  return renderNodes(limitedNodes, options.links ?? 'anchors');
}

export function inlineMarkdownText(value: string): string {
  return plainText(parseInline(value));
}

function parseInline(value: string, depth: number = 0): InlineNode[] {
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

function renderNodes(nodes: InlineNode[], links: 'anchors' | 'text'): string {
  return nodes.map((node) => {
    if (node.nodeKind === 'text') return e(node.value);
    if (node.nodeKind === 'code') return `<code>${e(node.value)}</code>`;
    if (node.nodeKind === 'strong') return `<strong>${renderNodes(node.children, links)}</strong>`;
    if (node.nodeKind === 'emphasis') return `<em>${renderNodes(node.children, links)}</em>`;
    const label = renderNodes(node.children, links);
    const href = safeLinkHref(node.href);
    if (links === 'text' || !href) return label;
    return `<a class="inline-markdown-link" href="${e(href)}" target="_blank" rel="noreferrer noopener">${label}</a>`;
  }).join('');
}

function plainText(nodes: InlineNode[]): string {
  return nodes.map((node) => (
    node.nodeKind === 'text' || node.nodeKind === 'code'
      ? node.value
      : plainText(node.children)
  )).join('');
}

function takeVisibleText(nodes: InlineNode[], maxLength: number): InlineNode[] {
  let remaining = maxLength;
  const take = (items: InlineNode[]): InlineNode[] => {
    const result: InlineNode[] = [];
    for (const node of items) {
      if (remaining <= 0) break;
      if (node.nodeKind === 'text' || node.nodeKind === 'code') {
        const value = node.value.slice(0, remaining);
        remaining -= value.length;
        if (value) result.push({ ...node, value });
        continue;
      }
      const children = take(node.children);
      if (children.length > 0) result.push({ ...node, children });
    }
    return result;
  };
  return take(nodes);
}

function safeLinkHref(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:'
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
