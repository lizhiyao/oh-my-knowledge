import type { Language } from '../layout/shell';

/** Source3 selects original records. Its readable projections can include multiple events in the same record. */
export function ConversationSourceScope({ lang, sourceVersion }: { lang: Language; sourceVersion?: string }) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  return <>
    <p className="candidate-help">{t('选择消息会选中其所在的原始记录；模型材料包含这些记录的可读事件，同条记录中的工具事件也可能纳入，以完整片段预览为准。未选中的独立记录、项目文件和附件原件不纳入；原文中转述的内容仍会发送。', 'Selecting a message selects its original record. Model material contains the readable events of those records, including tool events in the same record where present; review the complete excerpts. Unselected separate records, project files and original attachments are excluded; quoted content in the originals is still sent.')}</p>
    <p className="candidate-help">{t('这次提炼不代表项目资料已完整覆盖；消息中的说法与实际执行结果需要分别核对。', 'This extraction does not establish complete project coverage. Statements in messages and actual execution results require separate review.')}</p>
    {sourceVersion && <details className="conversation-extract-options"><summary>{t('预览来源版本', 'Preview source version')}</summary><code>{sourceVersion}</code></details>}
  </>;
}
