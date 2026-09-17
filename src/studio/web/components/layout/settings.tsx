'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Drawer, Input, Select } from 'antd';
import type { StudioSettings } from '../../../view-models/settings/settings';
import type { Language } from './shell';

/** One settings surface across Studio; reading or saving never invokes a model. */
export function StudioSettingsButton({ lang, trigger }: { lang: Language; trigger?: (open: () => void) => ReactNode }) {
  const zh = lang === 'zh';
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<StudioSettings>();
  const [workspace, setWorkspace] = useState('');
  const [executor, setExecutor] = useState('codex');
  const [model, setModel] = useState('');
  const [language, setLanguage] = useState<Language>(lang);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function load() {
    controller.current?.abort(); const active = new AbortController(); controller.current = active;
    setOpen(true); setBusy(true); setError('');
    try {
      const response = await fetch('/api/settings', { signal: active.signal });
      if (!response.ok) throw new Error('load');
      const value = await response.json() as StudioSettings;
      if (active.signal.aborted) return;
      setData(value); setWorkspace(value.settings.knowledge?.workspace ?? value.defaults.workspace);
      setExecutor(value.settings.knowledge?.executor ?? value.defaults.executor); setModel(value.settings.knowledge?.model ?? '');
      setLanguage(value.settings.language ?? value.defaults.language);
    } catch { if (!active.signal.aborted) setError(zh ? '无法读取设置，请检查本地配置文件。' : 'Cannot read settings. Check the local settings file.'); }
    finally { if (controller.current === active) { controller.current = null; setBusy(false); } }
  }
  async function save() {
    if (!data) return;
    const active = new AbortController(); controller.current = active; setBusy(true); setError('');
    try {
      const response = await fetch('/api/settings', { method: 'POST', signal: active.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: data.revision, settings: { schemaVersion: 1, language, knowledge: { workspace: workspace.trim(), executor, ...(model.trim() ? { model: model.trim() } : {}) } } }) });
      if (!response.ok) throw new Error(response.status === 409 ? 'conflict' : 'save');
      // 语言由设置决定、不进地址：保存后重载当前页即可生效，地址与其余查询参数原样保留。
      window.location.reload();
    } catch (cause) { if (!active.signal.aborted) setError(cause instanceof Error && cause.message === 'conflict' ? (zh ? '设置已被其他窗口修改。请重新读取后再保存。' : 'Settings changed elsewhere. Reload before saving.') : (zh ? '保存失败，请检查目录是否为完整路径及输入格式。' : 'Save failed. Check the absolute folder path and input.')); }
    finally { if (controller.current === active) { controller.current = null; setBusy(false); } }
  }
  return <>{trigger ? trigger(() => void load()) : <Button className="studio-settings-trigger" onClick={() => void load()}>{zh ? '设置' : 'Settings'}</Button>}
    <Drawer title={zh ? '全局设置' : 'Global settings'} open={open} onClose={() => { controller.current?.abort(); setOpen(false); }} size={600} extra={<Button type="primary" disabled={!data || busy || !workspace.trim()} onClick={() => void save()}>{zh ? '保存设置' : 'Save settings'}</Button>}>
      <div className="candidate-form">
        <p>{zh ? '保存在这台电脑上，CLI 与 Studio 共用。只影响后续操作，不移动已有数据或改变历史运行。' : 'Saved on this computer and shared with CLI. Applies to future actions without moving data or changing past runs.'}</p>
        {error && <Alert type="error" title={error} action={<Button disabled={busy} onClick={() => void load()}>{zh ? '重新读取' : 'Reload'}</Button>}/>}
        {data?.overrides.length ? <Alert type="info" title={zh ? `当前启动环境覆盖了部分设置：${data.overrides.join('、')}` : `Environment overrides: ${data.overrides.join(', ')}`}/> : null}
        <label>{zh ? '知识保存目录' : 'Knowledge folder'}<Input disabled={busy || !data} value={workspace} onChange={event => setWorkspace(event.target.value)}/></label>
        <p className="candidate-help">{zh ? '默认位置：' : 'Default: '}{data?.defaults.workspace}</p>
        <label>{zh ? '知识提炼调用方式' : 'Knowledge extraction provider'}<Select style={{ width: '100%' }} disabled={busy || !data} value={executor} onChange={value => { setExecutor(value); setModel(''); }} options={['codex','openai-api','anthropic-api'].map(value => ({ value, label: value }))}/></label>
        <label>{zh ? '知识提炼默认模型' : 'Default extraction model'}<Input disabled={busy || !data} value={model} onChange={event => setModel(event.target.value)} placeholder={zh ? '未设置时，每次提炼需明确选择模型' : 'Choose a model per extraction when unset'}/></label>
        <p className="candidate-help">{zh ? '这里只设置知识提炼模型，不修改评测模型或评委配置。保存设置不会调用模型。' : 'Applies only to knowledge extraction, not evaluation models or judges. Saving invokes no model.'}</p>
        <label>{zh ? '界面与 CLI 默认语言' : 'Default Studio and CLI language'}<Select style={{ width: '100%' }} disabled={busy || !data} value={language} onChange={setLanguage} options={[{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }]}/></label>
        <Button disabled={busy || !data} onClick={() => { if (data) { setWorkspace(data.defaults.workspace); setExecutor(data.defaults.executor); setModel(data.defaults.model); setLanguage(data.defaults.language); } }}>{zh ? '填入内置默认值' : 'Use built-in defaults'}</Button>
        <details><summary>{zh ? '还有哪些配置？' : 'Other configuration'}</summary><ul>
          <li>{zh ? '启动环境：OMK_HOME、Studio 地址／端口、外部 Codex 配置。修改环境后需重启服务。' : 'Startup environment: OMK_HOME, Studio host/port, external Codex configuration. Restart after changing the environment.'}</li>
          <li>{zh ? '凭证与服务地址：OPENAI_API_KEY、ANTHROPIC_API_KEY、对应 BASE_URL，由环境管理，这里不读取或保存密钥。' : 'Credentials and endpoints: OPENAI_API_KEY, ANTHROPIC_API_KEY and corresponding BASE_URL variables. Keys are not read or saved here.'}</li>
          <li>{zh ? '项目／运行：评测配置、评委、样本、并发、预算、报告目录与日志选区，仍在对应入口配置。' : 'Project/run: evaluation config, judges, samples, concurrency, budgets, report directories and log selections remain in their respective flows.'}</li>
        </ul><p>{zh ? '优先级：单次显式指定 → 启动环境覆盖 → 全局设置 → 内置默认。' : 'Priority: explicit request → environment → saved settings → built-in default.'}</p><p className="candidate-help">{data?.path}</p></details>
      </div>
    </Drawer></>;
}
