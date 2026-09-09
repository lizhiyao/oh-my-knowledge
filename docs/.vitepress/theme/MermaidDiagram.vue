<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useData } from 'vitepress'
import { renderDiagram } from './mermaid-renderer'

const props = defineProps<{ source: string }>()
const { isDark, lang } = useData()
const svg = ref('')
const failed = ref(false)
const enlarged = ref(false)
let revision = 0
let stop: (() => void) | undefined

onMounted(() => {
  stop = watch([() => props.source, isDark], async ([source, dark]) => {
    const current = ++revision
    svg.value = ''
    failed.value = false
    try {
      const result = await renderDiagram(source, dark)
      if (current === revision) svg.value = result
    } catch {
      if (current === revision) failed.value = true
    }
  }, { immediate: true })
})
onBeforeUnmount(() => { revision++; stop?.() })
</script>

<template>
  <figure class="omk-diagram">
    <button v-if="svg" class="omk-diagram-toggle" type="button" :aria-pressed="enlarged" @click="enlarged = !enlarged">
      {{ lang.startsWith('zh') ? (enlarged ? '适应宽度' : '放大查看') : (enlarged ? 'Fit width' : 'Enlarge diagram') }}
    </button>
    <div v-if="svg" class="omk-diagram-scroll" tabindex="0" :aria-label="lang.startsWith('zh') ? '流程图，可横向滚动' : 'Diagram, scroll horizontally'">
      <div class="omk-diagram-svg" :class="{ enlarged }" v-html="svg" />
    </div>
    <template v-else>
      <p v-if="failed" role="status">{{ lang.startsWith('zh') ? '图表渲染失败，以下为源代码。' : 'Diagram rendering failed. Source is shown below.' }}</p>
      <pre><code>{{ source }}</code></pre>
    </template>
  </figure>
</template>

<style scoped>
.omk-diagram { margin: 24px 0; }
.omk-diagram-scroll { overflow-x: auto; }
.omk-diagram-svg.enlarged { min-width: 1000px; }
.omk-diagram-toggle { padding: 4px 12px; margin-bottom: 12px; border: 1px solid var(--vp-c-divider); border-radius: 6px; color: var(--vp-c-brand-1); }
.omk-diagram-svg :deep(svg) { height: auto; max-width: 100%; }
.omk-diagram pre { padding: 16px; background: var(--vp-code-block-bg); overflow-x: auto; }
</style>
