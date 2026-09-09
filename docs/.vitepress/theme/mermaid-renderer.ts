// Mermaid configuration is global. Serialize rendering so concurrent diagrams
// and theme changes cannot overwrite one another's configuration.
let queue: Promise<unknown> = Promise.resolve()
let sequence = 0

export function renderDiagram(source: string, dark: boolean): Promise<string> {
  const result = queue.then(async () => {
    const { default: mermaid } = await import('mermaid')
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: dark ? 'dark' : 'default',
      suppressErrorRendering: true,
      htmlLabels: false,
    })
    const { svg } = await mermaid.render(`omk-mermaid-${++sequence}`, source)
    return svg
  })
  queue = result.catch(() => undefined)
  return result
}
