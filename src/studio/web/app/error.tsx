'use client';
import { Button, Result } from 'antd';
export default function ErrorPage({ reset }: {reset: () => void}) {
  return <Result status="error" title="页面暂时无法加载 / Unable to load page" extra={<Button onClick={reset}>重试 / Retry</Button>}/>;
}
