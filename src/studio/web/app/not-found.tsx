import { StudioShell } from '../components/layout/shell';
export default function NotFound() {
  return <StudioShell lang="zh" active={false}><section><h1>运行记录不存在 / Run not found</h1><a href="/measure">返回评测 / Back to Measure</a></section></StudioShell>;
}
