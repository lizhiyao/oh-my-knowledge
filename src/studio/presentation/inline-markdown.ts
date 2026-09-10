import { InlineNode } from '../view-models/inline-markdown.js';
import { parseInline, plainText } from '../application/inline-markdown.js';
import { e } from './layout.js';

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
