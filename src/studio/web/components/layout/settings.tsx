'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Drawer, Input, Select } from 'antd';
import type { StudioLanguageChoice, StudioSettings } from '../../../view-models/settings/settings';
import { languageField } from './settings-language';
import type { Language } from './shell';

export function EffectiveSettings({ data, lang }: { data: StudioSettings; lang: Language }) {
  const zh = lang === 'zh';
  return <section className="studio-settings-effective" aria-label={zh ? '当前有效配置' : 'Effective settings'}><h2>{zh ? '当前有效配置' : 'Effective settings'}</h2><dl>
    <div><dt>{zh ? '知识目录' : 'Knowledge folder'}</dt><dd title={data.effective.workspace}>{data.effective.workspace}</dd></div>
    <div><dt>{zh ? '提炼调用' : 'Extraction'}</dt><dd>{data.effective.executor} / {data.effective.model || (zh ? '每次选择模型' : 'Choose a model per extraction')}</dd></div>
    <div><dt>{zh ? '界面语言' : 'Language'}</dt><dd>{data.effective.language === 'zh' ? '中文' : 'English'}</dd></div>
  </dl><p>{zh ? '这是当前生效值；下方填写值保存后影响后续操作。' : 'These are the effective values; saving the fields below applies to future actions.'}</p></section>;
}

/** One settings surface across Studio; reading or saving never invokes a model. */
export function StudioSettingsButton({ lang, trigger }: { lang: Language; trigger?: (open: () => void) => ReactNode }) {
  const zh = lang === 'zh';
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<StudioSettings>();
  const [workspace, setWorkspace] = useState('');
  const [executor, setExecutor] = useState('codex');
  const [model, setModel] = useState('');
  const [language, setLanguage] = useState<StudioLanguageChoice>(lang);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [failure, setFailure] = useState<'load' | 'save' | 'conflict' | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function load() {
    controller.current?.abort(); const active = new AbortController(); controller.current = active;
    setOpen(true); setBusy(true); setError(''); setFailure(null); setData(undefined);
    try {
      const response = await fetch('/api/settings', { signal: active.signal });
      if (!response.ok) throw new Error('load');
      const value = await response.json() as StudioSettings;
      if (active.signal.aborted) return;
      setData(value); setWorkspace(value.settings.knowledge?.workspace ?? value.defaults.workspace);
      setExecutor(value.settings.knowledge?.executor ?? value.defaults.executor); setModel(value.settings.knowledge?.model ?? '');
      setLanguage(value.settings.language ?? 'auto');
    } catch { if (!active.signal.aborted) { setFailure('load'); setError(zh ? '无法读取设置。请检查本地配置文件，修复后重新读取。当前设置读取成功前不能保存。' : 'Cannot read settings. Check the local settings file, then reload. Saving is unavailable until current settings are loaded.'); } }
    finally { if (controller.current === active) { controller.current = null; setBusy(false); } }
  }
  async function save() {
    if (!data || busy || failure === 'conflict') return;
    const active = new AbortController(); controller.current = active; setBusy(true); setError(''); setFailure(null);
    try {
      const response = await fetch('/api/settings', { method: 'POST', signal: active.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: data.revision, settings: { schemaVersion: 1, ...languageField(language), knowledge: { workspace: workspace.trim(), executor, ...(model.trim() ? { model: model.trim() } : {}) } } }) });
      if (!response.ok) throw new Error(response.status === 409 ? 'conflict' : 'save');
      // 语言由设置决定、不进地址：保存后重载当前页即可生效，地址与其余查询参数原样保留。
      window.location.reload();
    } catch (cause) { if (!active.signal.aborted) { const conflict = cause instanceof Error && cause.message === 'conflict'; setFailure(conflict ? 'conflict' : 'save'); setError(conflict ? (zh ? '设置已被其他窗口修改，当前填写内容仍在。重新读取会替换填写值，请先保留需要的内容，再读取最新设置。' : 'Settings changed elsewhere; your input is still here. Reloading replaces it. Keep any needed changes before loading the latest settings.') : (zh ? '设置未保存，填写内容已保留。请检查知识目录是否为完整路径及输入格式，再点击保存。' : 'Settings were not saved; your input is preserved. Check the absolute knowledge path and input, then save again.')); } }
    finally { if (controller.current === active) { controller.current = null; setBusy(false); } }
  }
  return <>{trigger ? trigger(() => void load()) : <Button className="studio-settings-trigger" onClick={() => void load()}>{zh ? '设置' : 'Settings'}</Button>}
    <Drawer title={zh ? '全局设置' : 'Global settings'} open={open} onClose={() => { controller.current?.abort(); setOpen(false); }} size={600} onKeyDown={event => {
      if (event.key !== 'Tab') return;
      // The drawer's focus list omits native summary controls; include them in the boundary cycle.
      const items = [...event.currentTarget.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,summary,[tabindex="0"]')].filter(item => item.tabIndex >= 0 && item.getClientRects().length && !item.matches(':disabled'));
      const target = event.shiftKey && document.activeElement === items[0] ? items.at(-1)
        : !event.shiftKey && document.activeElement === items.at(-1) ? items[0] : undefined;
      if (target) { event.preventDefault(); target.focus(); }
    }} extra={<Button type="primary" loading={busy} disabled={!data || busy || failure === 'conflict' || !workspace.trim()} onClick={() => void save()}>{zh ? '保存设置' : 'Save settings'}</Button>}>
      <div className="candidate-form studio-settings-form">
        <p>{zh ? 'CLI 与 Studio 共用这台电脑上的设置。先阅读对话也可以；需要提炼知识时再配置模型。保存不会调用模型、移动已有知识或改变历史运行。' : 'CLI and Studio share these local settings. You can read conversations first and configure a model when extracting knowledge. Saving calls no model, moves no knowledge and changes no past runs.'}</p>
        {busy && <p role="status">{zh ? '正在读取或保存设置…' : 'Reading or saving settings…'}</p>}
        {error && <Alert type="error" showIcon title={error} action={failure !== 'save' ? <Button disabled={busy} onClick={() => void load()}>{zh ? '重新读取' : 'Reload settings'}</Button> : undefined}/>}
        {data && <EffectiveSettings data={data} lang={lang}/>}
        {data?.overrides.length ? <Alert type="info" title={zh ? `启动环境覆盖：${data.overrides.join('、')}` : `Environment overrides: ${data.overrides.join(', ')}`} description={zh ? '保存仍会记录填写值，但这些环境覆盖优先。更改启动环境后需重启服务。' : 'Saving records your values, but these environment overrides take precedence. Restart after changing the startup environment.'}/> : null}
        <h2>{zh ? '知识保存与提炼' : 'Knowledge storage and extraction'}</h2>
        <label>{zh ? '知识保存目录' : 'Knowledge folder'}<Input disabled={busy || !data} value={workspace} onChange={event => setWorkspace(event.target.value)}/></label>
        <p className="candidate-help">{zh ? '填写完整目录路径。默认位置：' : 'Use an absolute directory. Default: '}{data?.defaults.workspace}</p>
        <label>{zh ? '知识提炼调用方式' : 'Knowledge extraction provider'}<Select aria-label={zh ? '知识提炼调用方式' : 'Knowledge extraction provider'} style={{ width: '100%' }} disabled={busy || !data} value={executor} onChange={value => { setExecutor(value); setModel(''); }} options={['codex','openai-api','anthropic-api'].map(value => ({ value, label: value }))}/></label>
        <label>{zh ? '知识提炼默认模型' : 'Default extraction model'}<Input disabled={busy || !data} value={model} onChange={event => setModel(event.target.value)} placeholder={zh ? '未设置时，每次提炼需明确选择模型' : 'Choose a model per extraction when unset'}/></label>
        <p className="candidate-help">{zh ? '这里只设置知识提炼模型；评测的执行模型和评委在评测入口单独核对。切换调用方式会清空此处的模型。' : 'Applies only to extraction. Confirm task models and judges in the evaluation flow. Changing the provider clears this model.'}</p>
        <h2>{zh ? '界面与 CLI' : 'Studio and CLI'}</h2>
        {/* 「自动」不写死语言：保存时省略该字段，交回 OMK_LANG → 系统 locale → zh 的解析链。 */}
        <label>{zh ? '界面与 CLI 默认语言' : 'Default Studio and CLI language'}<Select aria-label={zh ? '默认语言' : 'Default language'} style={{ width: '100%' }} disabled={busy || !data} value={language} onChange={setLanguage} options={[
          { value: 'auto' as StudioLanguageChoice, label: zh ? `自动（当前 ${data?.effective.language ?? lang}）` : `Auto (currently ${data?.effective.language ?? lang})` },
          { value: 'zh' as StudioLanguageChoice, label: '中文' },
          { value: 'en' as StudioLanguageChoice, label: 'English' },
        ]}/></label>
        <Button disabled={busy || !data} onClick={() => { if (data) { setWorkspace(data.defaults.workspace); setExecutor(data.defaults.executor); setModel(data.defaults.model); setLanguage('auto'); } }}>{zh ? '填入内置默认值' : 'Use built-in defaults'}</Button>
        <details className="studio-settings-advanced"><summary>{zh ? '配置边界与设置文件' : 'Configuration scope and settings file'}</summary><ul>
          <li>{zh ? '带 workspace 的页面继续使用显式选定目录；改默认位置不迁移或切换该页面的数据。' : 'A page with an explicit workspace keeps that folder. Changing the default does not migrate data or switch that page’s workspace.'}</li>
          <li>{zh ? '启动环境：OMK_HOME、Studio 地址／端口、外部 Codex 配置。修改环境后需重启服务。' : 'Startup environment: OMK_HOME, Studio host/port, external Codex configuration. Restart after changing the environment.'}</li>
          <li>{zh ? '凭证与服务地址：OPENAI_API_KEY、ANTHROPIC_API_KEY、对应 BASE_URL，由环境管理，这里不读取或保存密钥。' : 'Credentials and endpoints: OPENAI_API_KEY, ANTHROPIC_API_KEY and corresponding BASE_URL variables. Keys are not read or saved here.'}</li>
          <li>{zh ? '项目／运行：评测配置、评委、样本、并发、预算、报告目录与日志选区，仍在对应入口配置。' : 'Project/run: evaluation config, judges, samples, concurrency, budgets, report directories and log selections remain in their respective flows.'}</li>
        </ul><p>{zh ? '优先级：单次显式指定 → 启动环境覆盖 → 全局设置 → 系统 locale → 内置默认 zh。' : 'Priority: explicit request → environment → saved settings → system locale → built-in default zh.'}</p><p className="candidate-help">{data?.path}</p></details>
      </div>
    </Drawer></>;
}
