'use client';
import Link from 'next/link';
import type { Language } from '../layout/shell';

const suffix = (lang: Language) => (lang === 'en' ? '?lang=en' : '');

/**
 * 知识分区入口：知识对象、Skill 健康度与受管决策史。
 * 页面都由 Next 宿主渲染，静态链接不会指向被裁掉的 HTML 路由。
 */
export function KnowledgeSectionNav({ active, lang }: { active: 'skills' | 'managed' | 'health'; lang: Language }) {
  const zh = lang === 'zh';
  const items = [
    { key: 'skills' as const, href: `/knowledge${suffix(lang)}`, label: zh ? '知识对象' : 'Knowledge artifacts' },
    { key: 'health' as const, href: `/observe/health${suffix(lang)}`, label: zh ? 'Skill 健康度' : 'Skill health' },
    { key: 'managed' as const, href: `/knowledge/managed${suffix(lang)}`, label: zh ? '受管决策史' : 'Managed history' },
  ];
  return (
    <nav className="observe-section-nav" aria-label={zh ? '知识分区' : 'Knowledge sections'}>
      {items.map((item) => (
        <Link key={item.key} href={item.href} aria-current={item.key === active ? 'page' : undefined}>{item.label}</Link>
      ))}
    </nav>
  );
}
