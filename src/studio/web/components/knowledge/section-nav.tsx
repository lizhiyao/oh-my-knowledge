'use client';
import Link from 'next/link';
import { langSuffix, type Language } from '../layout/shell';


/**
 * 知识分区入口：skill 视角（体检 + 生产观测的聚合）与受管视角（决策史）是同一层级的两个入口。
 * 两者都由 Next 宿主渲染，静态链接不会指向被裁掉的 HTML 路由。
 */
export function KnowledgeSectionNav({ active, lang }: { active: 'skills' | 'managed'; lang: Language }) {
  const zh = lang === 'zh';
  const items = [
    { key: 'skills' as const, href: `/knowledge${langSuffix(lang)}`, label: zh ? '知识对象' : 'Knowledge artifacts' },
    { key: 'managed' as const, href: `/knowledge/managed${langSuffix(lang)}`, label: zh ? '受管决策史' : 'Managed history' },
  ];
  return (
    <nav className="observe-section-nav" aria-label={zh ? '知识分区' : 'Knowledge sections'}>
      {items.map((item) => (
        <Link key={item.key} href={item.href} aria-current={item.key === active ? 'page' : undefined}>{item.label}</Link>
      ))}
    </nav>
  );
}
