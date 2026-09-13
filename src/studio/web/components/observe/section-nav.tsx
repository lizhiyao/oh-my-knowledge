'use client';
import Link from 'next/link';
import type { Language } from '../layout/shell';

const suffix = (lang: Language) => (lang === 'en' ? '?lang=en' : '');

/**
 * 观测分区入口：会话流与 Skill 健康度是同一层级的两个观察视角。
 * 收件箱不在此列出——它按宿主开关挂载，静态链接会在裁掉该路由的宿主上 404。
 */
export function ObserveSectionNav({ active, lang }: { active: 'conversations' | 'health'; lang: Language }) {
  const zh = lang === 'zh';
  const items = [
    { key: 'conversations' as const, href: `/observe${suffix(lang)}`, label: zh ? '会话' : 'Conversations' },
    { key: 'health' as const, href: `/observe/health${suffix(lang)}`, label: zh ? 'Skill 健康度' : 'Skill health' },
  ];
  return (
    <nav className="observe-section-nav" aria-label={zh ? '观测分区' : 'Observe sections'}>
      {items.map((item) => (
        <Link key={item.key} href={item.href} aria-current={item.key === active ? 'page' : undefined}>{item.label}</Link>
      ))}
    </nav>
  );
}
