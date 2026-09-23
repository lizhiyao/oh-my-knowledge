'use client';
import { useState } from 'react';
import { Dropdown, Drawer } from 'antd';
import type { Language } from './shell';
import { StudioSettingsButton } from './settings';

/** Local Studio has no signed-in identity; expose only capabilities it actually has. Rendered only by the shell at the sidebar foot (#1055); the menu opens upward from there. */
export function StudioUtilities({ lang }: { lang: Language }) {
  const [help, setHelp] = useState(false);
  const zh = lang === 'zh';
  return <div className="studio-utilities">
    <StudioSettingsButton lang={lang} trigger={openSettings => <Dropdown trigger={['click']} placement="topLeft" menu={{
      items: [{ key: 'settings', label: zh ? '全局设置' : 'Global settings' }, { key: 'help', label: zh ? '使用帮助' : 'Help' }],
      onClick: ({ key }) => key === 'settings' ? openSettings() : setHelp(true),
    }}><button className="studio-utilities-trigger" aria-label={zh ? '设置与帮助' : 'Settings and help'}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><g transform="translate(1.2 1.2) scale(0.9)"><path d="m9 3-.6 2.2-2 .9L4.4 5.5 2 9.5l1.6 1.6v1.8L2 14.5l2.4 4 2-.6 2 .9L9 21h6l.6-2.2 2-.9 2 .6 2.4-4-1.6-1.6v-1.8L22 9.5l-2.4-4-2 .6-2-.9L15 3Z"/><circle cx="12" cy="12" r="2.7"/></g></svg>
      <span>{zh ? '设置与帮助' : 'Settings and help'}</span>
    </button></Dropdown>}/>
    <Drawer title={zh ? '使用帮助' : 'Help'} open={help} onClose={() => setHelp(false)} size={440}>
      <div className="studio-help">
        <h3>{zh ? '找到并阅读对话' : 'Find and read conversations'}</h3>
        <p>{zh ? '左侧按项目查找对话，或从独立对话直接打开。对话按时间顺序排列，向上滚动可加载更早内容。查看历史时，有更新会提示“有新消息”。' : 'Find a conversation under its project or open a standalone conversation. Messages follow chronological order. Scroll up to load earlier content; new messages are announced while you read history.'}</p>
        <h3>{zh ? '从对话中留下知识' : 'Keep knowledge from conversations'}</h3>
        <p>{zh ? '在对话中点击“提炼知识”，确认范围与模型后开始。生成的候选需要核对原始依据，再决定保留。保存位置和默认模型在设置中管理。' : 'Choose Extract knowledge, confirm the scope and model, then start. Review candidates against their evidence before keeping them. Settings controls the save location and default model.'}</p>
        <h3>{zh ? '查看执行与评测' : 'Inspect execution and evaluation'}</h3>
        <p>{zh ? '每轮的执行详情保留工具调用、知识访问和原始记录。评测用于比较改动前后的表现；工具报错次数本身不代表最终工作失败。' : 'Execution details preserve tool calls, knowledge access and source records. Measure compares performance across changes; tool errors alone do not determine the final outcome.'}</p>
      </div>
    </Drawer>
  </div>;
}
