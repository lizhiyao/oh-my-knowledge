'use client';
import { useState } from 'react';
import { Button, Drawer } from 'antd';
import type { Language } from './shell';
import { StudioSettingsButton } from './settings';

/** Local Studio has no signed-in identity; expose only capabilities it actually has. */
export function StudioUtilities({ lang }: { lang: Language }) {
  const [help, setHelp] = useState(false);
  const zh = lang === 'zh';
  return <footer className="studio-utilities" aria-label={zh ? '工作区与设置' : 'Workspace and settings'}>
    <span className="studio-local-context">{zh ? '本地工作区' : 'Local workspace'}</span>
    <StudioSettingsButton lang={lang}/>
    <Button type="text" onClick={() => setHelp(true)}>{zh ? '帮助' : 'Help'}</Button>
    <Drawer title={zh ? '使用帮助' : 'Help'} open={help} onClose={() => setHelp(false)} width={440}>
      <div className="studio-help">
        <h3>{zh ? '找到并阅读对话' : 'Find and read conversations'}</h3>
        <p>{zh ? '左侧按项目查找会话，或从最近对话直接打开。对话按时间顺序排列，向上滚动可加载更早内容。查看历史时，有更新会提示“有新消息”。' : 'Find a conversation under its project or open a recent conversation. Messages follow chronological order. Scroll up to load earlier content; new messages are announced while you read history.'}</p>
        <h3>{zh ? '从对话中留下知识' : 'Keep knowledge from conversations'}</h3>
        <p>{zh ? '在会话中点击“提炼知识”，确认范围与模型后开始。生成的候选需要核对原始依据，再决定保留。保存位置和默认模型在设置中管理。' : 'Choose Extract knowledge, confirm the scope and model, then start. Review candidates against their evidence before keeping them. Settings controls the save location and default model.'}</p>
        <h3>{zh ? '查看执行与评测' : 'Inspect execution and evaluation'}</h3>
        <p>{zh ? '每轮的执行详情保留工具调用、知识访问和原始记录。评测用于比较改动前后的表现；工具报错次数本身不代表最终工作失败。' : 'Execution details preserve tool calls, knowledge access and source records. Measure compares performance across changes; tool errors alone do not determine the final outcome.'}</p>
      </div>
    </Drawer>
  </footer>;
}
