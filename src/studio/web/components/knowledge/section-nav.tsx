'use client';
import Link from 'next/link';
import { HEALTH_INDEX_PATH, KNOWLEDGE_INDEX_PATH, MANAGED_LIST_PATH } from '../../../http/page-paths';
import { type Language } from '../layout/shell';


/**
 * 知识分区入口：知识对象、Skill 健康度与受管决策史。
 * 页面都由 Next 宿主渲染，静态链接不会指向被裁掉的 HTML 路由。
 */
export function KnowledgeSectionNav({ active, lang }: { active: 'skills' | 'managed' | 'health'; lang: Language }) {
  const zh = lang === 'zh';
  const items = [
    { key: 'skills' as const, href: KNOWLEDGE_INDEX_PATH, label: zh ? '知识对象' : 'Knowledge artifacts' },
    { key: 'health' as const, href: HEALTH_INDEX_PATH, label: zh ? 'Skill 健康度' : 'Skill health' },
    { key: 'managed' as const, href: MANAGED_LIST_PATH, label: zh ? '受管决策史' : 'Managed history' },
  ];
  return (
    <nav className="observe-section-nav" aria-label={zh ? '知识分区' : 'Knowledge sections'}>
      {items.map((item) => (
        <Link key={item.key} href={item.href} aria-current={item.key === active ? 'page' : undefined}>{item.label}</Link>
      ))}
    </nav>
  );
}
