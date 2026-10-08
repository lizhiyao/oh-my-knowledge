'use client';
import Link from 'next/link';
import { useWorkspaceHref } from '../layout/workspace-link';
import { HEALTH_INDEX_PATH, KNOWLEDGE_CANDIDATES_PATH, KNOWLEDGE_INDEX_PATH } from '../../../http/page-paths';
import { type Language } from '../layout/shell';


/**
 * 知识分区入口：提炼的知识、知识载体与 Skill 健康度。
 * 页面都由 Next 宿主渲染，静态链接不会指向被裁掉的 HTML 路由。
 */
export function KnowledgeSectionNav({ active, lang }: { active: 'candidates' | 'skills' | 'health'; lang: Language }) {
  const zh = lang === 'zh';
  const href = useWorkspaceHref();
  const items = [
    { key: 'candidates' as const, href: KNOWLEDGE_CANDIDATES_PATH, label: zh ? '提炼的知识' : 'Extracted knowledge' },
    { key: 'skills' as const, href: KNOWLEDGE_INDEX_PATH, label: zh ? '知识载体' : 'Knowledge artifacts' },
    { key: 'health' as const, href: HEALTH_INDEX_PATH, label: zh ? 'Skill 健康度' : 'Skill health' },
  ];
  return (
    <nav className="observe-section-nav" aria-label={zh ? '知识分区' : 'Knowledge sections'}>
      {items.map((item) => (
        <Link key={item.key} href={href(item.href)} aria-current={item.key === active ? 'page' : undefined}>{item.label}</Link>
      ))}
    </nav>
  );
}
