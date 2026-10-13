/** Clipboard permission and the legacy fallback can both fail. */
export async function copyCommand(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* Try the local fallback before offering manual selection. */ }
  }
  const previous = document.activeElement;
  const field = document.createElement('textarea');
  field.value = text;
  field.style.position = 'fixed';
  field.style.top = '-9999px';
  document.body.appendChild(field);
  try {
    field.focus();
    field.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
    if (previous instanceof HTMLElement) previous.focus();
  }
}

export function initLanding(lang: 'zh' | 'en', root: HTMLElement): () => void {
  const zh = lang === 'zh';
  let disposed = false;
  const bindings: Array<{ button: HTMLButtonElement; listener: () => Promise<void> }> = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  for (const button of root.querySelectorAll<HTMLButtonElement>('button[data-copy-command]')) {
    const label = button.textContent;
    const command = button.dataset.copyCommand!;
    const status = button.closest('.cmd')?.nextElementSibling as HTMLElement | null;
    const listener = async () => {
      button.disabled = true;
      const copied = await copyCommand(command);
      if (disposed) return;
      button.disabled = false;
      button.textContent = copied ? (zh ? '已复制' : 'Copied') : label;
      if (status) status.textContent = copied
        ? (zh ? '命令已复制。' : 'Command copied.')
        : (zh ? '未能复制，请选中命令后手动复制。' : 'Copy failed. Select the command and copy it manually.');
      if (copied) {
        const timer = setTimeout(() => {
          button.textContent = label;
          timers.delete(timer);
        }, 1500);
        timers.add(timer);
      }
    };
    button.addEventListener('click', listener);
    bindings.push({ button, listener });
  }
  return () => {
    disposed = true;
    for (const { button, listener } of bindings) button.removeEventListener('click', listener);
    for (const timer of timers) clearTimeout(timer);
  };
}
