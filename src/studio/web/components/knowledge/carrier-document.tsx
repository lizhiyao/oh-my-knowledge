'use client';
import Link from 'next/link';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Language } from '../layout/shell';

export function CarrierDocument({ content, lang }: { content: string; lang: Language }) {
  // Frontmatter remains in the exact original view; the reading view starts at its Markdown body.
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
  return <div className="carrier-document"><Markdown skipHtml remarkPlugins={[remarkGfm]} components={{
    a: ({ href, children }) => href && /^https?:\/\//i.test(href) ? <Link href={href} prefetch={false}>{children}</Link> : <span>{children}{href && <code> ({href})</code>}</span>,
    img: ({ src, alt }) => typeof src === 'string' && /^https?:\/\//i.test(src) ? <Link href={src} prefetch={false}>{alt || (lang === 'zh' ? '图片' : 'Image')}</Link> : <span>{alt}{typeof src === 'string' && <code> ({src})</code>}</span>,
    table: ({ children }) => <div className="carrier-document-table" role="region" aria-label={lang === 'zh' ? '载体中的表格' : 'Artifact table'} tabIndex={0}><table>{children}</table></div>,
  }}>{body}</Markdown></div>;
}
