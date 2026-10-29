import type { Language } from '../layout/shell';

/** This scope describes the message-only Studio adapter, not every OMK source. */
export function ConversationSourceScope({ lang, sourceVersion }: { lang: Language; sourceVersion?: string }) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  return <>
    <p className="candidate-help">{t('来源仅包含所选轮次中的用户和助手消息。独立的工具调用与结果、项目文件、附件原件未纳入；消息正文中转述的内容仍会发送。', 'The source includes only user and assistant messages from the selected turns. Separate tool calls and results, project files and original attachments are excluded; content quoted within messages is still sent.')}</p>
    <p className="candidate-help">{t('这次提炼不代表项目资料已完整覆盖；消息中的说法与实际执行结果需要分别核对。', 'This extraction does not establish complete project coverage. Statements in messages and actual execution results require separate review.')}</p>
    {sourceVersion && <details className="conversation-extract-options"><summary>{t('预览来源版本', 'Preview source version')}</summary><code>{sourceVersion}</code></details>}
  </>;
}
