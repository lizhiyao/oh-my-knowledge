'use client';
import {useEffect,useState} from 'react';
import {useRouter} from 'next/navigation';
import {Button,Tag} from 'antd';
import type {Language} from '../layout/shell';
const statuses: Record<string, string> = { open: '进行中', completed: '已完成', failed: '失败', aborted: '已中止', interrupted: '已中断', unknown: '未知', success: '成功', failure: '失败', cancelled: '已取消' };
export function Status({status, lang}: {status: string; lang: Language}) {
  return <Tag className={status === 'open' ? 'studio-running-status' : undefined} color={status === 'open' ? 'processing' : status === 'failed' ? 'error' : undefined}>{status === 'open' && <span className="studio-running-dot" aria-hidden="true"/>}{lang === 'zh' ? statuses[status] ?? status : status}</Tag>;
}
/** Refresh only when the domain activity revision changes; cancel polling on navigation. */
export function useActivity(endpoint: string, revision: string) {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const check = async () => {
      if (pending || document.hidden) return;
      pending = true;
      setChecking(true);
      try {
        const response = await fetch(endpoint, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error('activity unavailable');
        const activity = await response.json() as {revision: string};
        if (!controller.signal.aborted) {
          setFailed(false);
          if (activity.revision !== revision) router.refresh();
        }
      } catch { if (!controller.signal.aborted) setFailed(true); }
      finally { pending = false; if (!controller.signal.aborted) setChecking(false); }
    };
    if (attempt > 0) void check();
    const timer = setInterval(check, 5000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [endpoint, revision, router, attempt]);
  return { failed, checking, retry: () => setAttempt(value => value + 1) };
}

export function ActivityNotice({activity, lang}: {activity: ReturnType<typeof useActivity>; lang: Language}) {
  if (!activity.failed) return null;
  return <div className="observe-update-notice"><span role="status" title={lang === 'zh' ? '暂时无法获取新内容，当前列表仍可查看；系统会自动重试。' : 'Updates are unavailable. Existing records remain available; automatic retries continue.'}><span aria-hidden="true">⚠</span> {lang === 'zh' ? '更新暂不可用' : 'Updates unavailable'}</span><Button type="link" size="small" loading={activity.checking} onClick={activity.retry}>{lang === 'zh' ? '重试' : 'Retry'}</Button></div>;
}

