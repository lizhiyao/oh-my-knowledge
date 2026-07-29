<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useData } from 'vitepress'
import './knowledge-explainer.css'

const isZh = useData().lang.value.startsWith('zh')
const pick = (zh, en) => (isZh ? zh : en)

const copy = {
  eyebrow: pick('交互式原理实验室', 'Interactive systems lab'),
  title: pick('AI 是怎么「懂」的？', 'How does AI come to “understand”?'),
  intro: pick(
    '沿着同一条请求，依次观察 Transformer 如何计算、Agent 如何行动，以及 knowledge 如何进入、缺失和改变结果。',
    'Follow one request through Transformer computation, Agent action, and the way knowledge enters, goes missing, and changes the result.',
  ),
  requestLabel: pick('贯穿全程的请求', 'The request we will follow'),
  request: pick(
    '请按照这个项目的规范修复登录失败问题。',
    'Fix the login failure according to this project’s rules.',
  ),
  play: pick('播放', 'Play'),
  pause: pick('暂停', 'Pause'),
  previous: pick('上一步', 'Previous step'),
  next: pick('下一步', 'Next step'),
  restart: pick('重新开始', 'Restart'),
  simulated: pick('教学模拟', 'Teaching simulation'),
  observed: pick('观测事实', 'Observed fact'),
  inferred: pick('系统推断', 'System inference'),
  unavailable: pick('不可观测', 'Unavailable'),
  phaseStatus: pick('当前视角', 'Current lens'),
  transformerLead: pick(
    '先看语言模型如何把上下文变成下一 token 的概率。',
    'First, see how a language model turns context into probabilities for the next token.',
  ),
  agentLead: pick(
    '再拉远视角，看模型如何在上下文和工具之间循环工作。',
    'Then zoom out to see the model loop through context and tools.',
  ),
  knowledgeLead: pick(
    '最后只看 knowledge：它从哪里来、解决什么未知，又怎样改变行动。',
    'Finally, look only at knowledge: where it comes from, which unknown it resolves, and how it changes action.',
  ),
  originalText: pick('原始文字', 'Original text'),
  toyTokens: pick('教学 token', 'Teaching tokens'),
  selectedToken: pick('当前 token', 'Selected token'),
  attentionHint: pick('点击任意 token，查看它与上下文的关联权重。', 'Select any token to inspect its contextual weights.'),
  formula: 'softmax(QKᵀ / √d)',
  candidateLabel: pick('下一 token 的概率示意', 'Illustrative next-token probabilities'),
  agentContext: pick('此刻进入上下文', 'Now entering context'),
  noContext: pick('尚未获得新的任务证据', 'No new task evidence yet'),
  contextCount: pick('上下文证据', 'Context evidence'),
  knowledgeRuleToggle: pick('允许读取项目规范', 'Allow project rules'),
  knowledgeRuleHelp: pick(
    '移除这条 knowledge，观察同一任务会怎样改变。',
    'Remove this knowledge and see how the same task changes.',
  ),
  outcome: pick('当前行动', 'Current action'),
  evidence: pick('可用依据', 'Available basis'),
  unresolved: pick('仍未解决', 'Still unresolved'),
  insightTitle: pick('三种 knowledge，不是同一回事', 'Three kinds of knowledge are not the same'),
  parameterTitle: pick('参数中的 knowledge', 'Knowledge in parameters'),
  parameterBody: pick(
    '训练形成的语言和模式能力，不能像文档一样直接列出。',
    'Language and behavioral patterns learned in training, not a browsable document store.',
  ),
  contextTitle: pick('上下文中的 knowledge', 'Knowledge in context'),
  contextBody: pick(
    '当前可控的指令、项目文件、memory、RAG 与 skill。',
    'Controllable instructions, project files, memory, RAG, and skills available now.',
  ),
  runtimeTitle: pick('运行中获得的 knowledge', 'Knowledge gained at runtime'),
  runtimeBody: pick(
    '读取文件、检索、工具结果和真实环境反馈带来的新证据。',
    'New evidence from files, retrieval, tool results, and the real environment.',
  ),
  boundaryTitle: pick('哪些内容是真的可见？', 'What is actually visible?'),
  boundaryIntro: pick(
    '界面始终区分事实、模拟和推断，不把生成的解释冒充模型真实思维。',
    'The interface keeps facts, simulations, and inferences separate. Generated explanations are not presented as the model’s true thoughts.',
  ),
  boundaryItems: [
    {
      kind: 'simulated',
      label: pick('教学模拟', 'Teaching simulation'),
      body: pick('微型 Transformer 的标准计算与人为简化示例。', 'Standard miniature Transformer mechanics with deliberate simplifications.'),
    },
    {
      kind: 'observed',
      label: pick('观测事实', 'Observed fact'),
      body: pick('真实 Agent 的上下文、文件、工具调用和输出。', 'Real Agent context, files, tool calls, and outputs.'),
    },
    {
      kind: 'inferred',
      label: pick('系统推断', 'System inference'),
      body: pick('根据 trace 判断哪些 knowledge 可能影响了行为。', 'Trace-based estimates of which knowledge may have affected behavior.'),
    },
    {
      kind: 'unavailable',
      label: pick('不可观测', 'Unavailable'),
      body: pick('闭源模型内部的权重、激活和完整因果机制。', 'Weights, activations, and complete causal mechanisms inside a closed model.'),
    },
  ],
  sources: pick('继续阅读', 'Further reading'),
}

const phases = [
  {
    short: 'Transformer',
    title: pick('模型怎样生成', 'How the model generates'),
    lead: copy.transformerLead,
    steps: [
      pick('切成 token', 'Split into tokens'),
      pick('形成表示', 'Build representations'),
      pick('上下文关联', 'Mix context'),
      pick('预测下一 token', 'Predict next token'),
    ],
  },
  {
    short: 'Agent',
    title: pick('Agent 怎样工作', 'How the Agent works'),
    lead: copy.agentLead,
    steps: [
      pick('收到请求', 'Receive request'),
      pick('装配上下文', 'Assemble context'),
      pick('搜索代码', 'Search code'),
      pick('读取规范', 'Read rules'),
      pick('修改并验证', 'Edit and verify'),
      pick('返回结果', 'Return result'),
    ],
  },
  {
    short: 'Knowledge',
    title: pick('Knowledge 怎样流动', 'How knowledge flows'),
    lead: copy.knowledgeLead,
    steps: [
      pick('参数基础', 'Parameter base'),
      pick('上下文注入', 'Context injection'),
      pick('运行时求证', 'Runtime evidence'),
      pick('任务后沉淀', 'Post-task learning'),
    ],
  },
]

const zhTokens = ['请', '按', '项目', '规范', '修复', '登录', '问题']
const enTokens = ['Please', 'follow', 'project', 'rules', 'fix', 'login', 'failure']
const tokens = isZh ? zhTokens : enTokens

const candidateTokens = isZh
  ? [
      { token: '先', value: 46 },
      { token: '读取', value: 31 },
      { token: '我', value: 15 },
      { token: '直接', value: 8 },
    ]
  : [
      { token: 'I', value: 42 },
      { token: 'First', value: 34 },
      { token: 'Let', value: 16 },
      { token: 'Directly', value: 8 },
    ]

const agentEvents = [
  {
    title: pick('用户请求', 'User request'),
    meta: 'user',
    gained: pick('任务目标', 'Task goal'),
    detail: pick('模型收到修复目标，但还不知道代码位置和项目约束。', 'The model has the goal, but not the code location or project constraints.'),
  },
  {
    title: pick('系统与项目指令', 'System and project instructions'),
    meta: 'context',
    gained: pick('工具边界、仓库约定', 'Tool boundaries, repository conventions'),
    detail: pick('运行时装配系统指令、项目级说明和当前工作目录。', 'The runtime assembles system instructions, project guidance, and the working directory.'),
  },
  {
    title: pick('搜索登录代码', 'Search login code'),
    meta: 'tool',
    gained: pick('相关文件位置', 'Relevant file locations'),
    detail: pick('Agent 发起搜索，工具结果作为新证据返回上下文。', 'The Agent searches, and tool results return to context as new evidence.'),
  },
  {
    title: pick('读取项目规范', 'Read project rules'),
    meta: 'file',
    gained: pick('错误处理与测试要求', 'Error handling and test requirements'),
    detail: pick('项目规范把通用修复能力约束成当前仓库认可的做法。', 'Project rules constrain generic repair ability to the repository’s accepted practice.'),
  },
  {
    title: pick('修改并运行测试', 'Edit and run tests'),
    meta: 'tool',
    gained: pick('真实运行反馈', 'Real execution feedback'),
    detail: pick('代码改动接受真实测试反馈，失败会再次进入上下文。', 'The edit receives real test feedback, and failures re-enter the context.'),
  },
  {
    title: pick('返回有依据的结果', 'Return an evidenced result'),
    meta: 'answer',
    gained: pick('改动、测试与剩余风险', 'Changes, tests, and residual risk'),
    detail: pick('最终回答来自模型能力、上下文 knowledge 和运行证据的共同作用。', 'The final answer combines model capability, contextual knowledge, and runtime evidence.'),
  },
]

const knowledgeSources = [
  {
    kind: 'parameter',
    title: pick('参数', 'Parameters'),
    subtitle: pick('语言与代码模式', 'Language and code patterns'),
    detail: pick('模型在训练中形成的通用语言、代码和问题求解模式。', 'General language, code, and problem-solving patterns formed during training.'),
  },
  {
    kind: 'context',
    title: pick('上下文', 'Context'),
    subtitle: pick('项目规范与指令', 'Project rules and instructions'),
    detail: pick('当前任务显式提供、能够检查和替换的 knowledge。', 'Knowledge explicitly supplied to this task and available for inspection or replacement.'),
  },
  {
    kind: 'runtime',
    title: pick('运行证据', 'Runtime evidence'),
    subtitle: pick('代码、搜索与测试', 'Code, search, and tests'),
    detail: pick('Agent 在真实环境中读取和验证后获得的新事实。', 'New facts obtained by reading and validating against the real environment.'),
  },
  {
    kind: 'candidate',
    title: pick('任务后候选', 'Post-task candidate'),
    subtitle: pick('纠正与失败经验', 'Corrections and failures'),
    detail: pick('本次工作暴露出的可复用理解，尚未自动写入任何载体。', 'Reusable understanding exposed by the task, not yet written into any artifact.'),
  },
]

const activePhase = ref(0)
const activeStep = ref(0)
const selectedToken = ref(4)
const isPlaying = ref(false)
const includeProjectRules = ref(true)
let timer = null

const currentPhase = computed(() => phases[activePhase.value])
const currentStepLabel = computed(() => currentPhase.value.steps[activeStep.value])
const progressText = computed(
  () => `${activeStep.value + 1} / ${currentPhase.value.steps.length}`,
)
const activeAgentEvent = computed(() => agentEvents[activeStep.value])
const activeKnowledgeSource = computed(() => knowledgeSources[activeStep.value])

const attentionWeights = computed(() => {
  const semanticLinks = {
    0: [1, 4],
    1: [2, 3, 4],
    2: [1, 3, 4],
    3: [1, 2, 4],
    4: [2, 3, 5, 6],
    5: [4, 6],
    6: [4, 5],
  }
  const links = semanticLinks[selectedToken.value] || []
  const raw = tokens.map((_, index) => {
    const self = index === selectedToken.value ? 0.34 : 0
    const semantic = links.includes(index) ? 0.28 : 0
    const proximity = 0.1 / (Math.abs(index - selectedToken.value) + 1)
    return 0.025 + self + semantic + proximity
  })
  const total = raw.reduce((sum, value) => sum + value, 0)
  return raw.map((value) => value / total)
})

const vectorRows = computed(() =>
  tokens.map((_, tokenIndex) =>
    Array.from({ length: 6 }, (_, vectorIndex) => {
      const value = ((tokenIndex + 2) * (vectorIndex + 3) * 17) % 91
      return 18 + value * 0.72
    }),
  ),
)

const knowledgeOutcome = computed(() => {
  if (includeProjectRules.value) {
    return {
      tone: 'grounded',
      action: pick('先读取规范，再定位代码并运行测试。', 'Read the rules, locate the code, then run tests.'),
      basis: pick('通用代码能力 + 项目规范 + 运行证据', 'General coding ability + project rules + runtime evidence'),
      unresolved: pick('登录失败的具体根因，等待代码与测试确认', 'The concrete root cause, pending code and test evidence'),
    }
  }
  return {
    tone: 'uncertain',
    action: pick('直接按通用经验修改，项目约束缺失。', 'Edit from generic experience while project constraints are missing.'),
    basis: pick('通用代码能力 + 部分运行证据', 'General coding ability + partial runtime evidence'),
    unresolved: pick('项目认可的做法、测试要求与禁止事项', 'Accepted project practice, test requirements, and prohibited actions'),
  }
})

const sceneExplanation = computed(() => {
  if (activePhase.value === 0) {
    const details = [
      pick('真实 tokenizer 因模型而异。这里用可读词片展示「文字先变成离散 token」这一过程。', 'Real tokenizers vary by model. Readable pieces show how text first becomes discrete tokens.'),
      pick('每个 token 被映射成一组数值。图中的条形只是表示维度，不对应可直接命名的概念。', 'Each token maps to a vector. The bars represent dimensions, not directly named concepts.'),
      pick('attention 让当前 token 根据其它位置更新表示。权重高不等于完整的因果解释。', 'Attention updates a token from other positions. High weight is not a complete causal explanation.'),
      pick('模型把最终表示映射成词表概率，再选择一个 token，重复这一过程继续生成。', 'The model maps its final representation to vocabulary probabilities, chooses one token, and repeats.'),
    ]
    return details[activeStep.value]
  }
  if (activePhase.value === 1) return activeAgentEvent.value.detail
  return activeKnowledgeSource.value.detail
})

const sceneTruthKind = computed(() => {
  if (activePhase.value === 0) return copy.simulated
  if (activePhase.value === 1) return copy.observed
  return activeStep.value === 3 ? copy.inferred : copy.observed
})

function attentionX(index) {
  return 60 + index * 90
}

function attentionPath(index) {
  const from = attentionX(selectedToken.value)
  const to = attentionX(index)
  if (from === to) return `M ${from} 116 C ${from - 20} 68, ${from + 20} 68, ${to} 116`
  const lift = 42 - Math.min(24, Math.abs(from - to) * 0.04)
  return `M ${from} 116 Q ${(from + to) / 2} ${lift} ${to} 116`
}

function selectPhase(index) {
  stopPlayback()
  activePhase.value = index
  activeStep.value = 0
}

function previousStep() {
  stopPlayback()
  if (activeStep.value > 0) {
    activeStep.value -= 1
    return
  }
  if (activePhase.value > 0) {
    activePhase.value -= 1
    activeStep.value = phases[activePhase.value].steps.length - 1
  }
}

function nextStep({ fromPlayback = false } = {}) {
  if (!fromPlayback) stopPlayback()
  if (activeStep.value < currentPhase.value.steps.length - 1) {
    activeStep.value += 1
    return
  }
  if (activePhase.value < phases.length - 1) {
    activePhase.value += 1
    activeStep.value = 0
    return
  }
  if (fromPlayback) {
    stopPlayback()
    return
  }
  activePhase.value = 0
  activeStep.value = 0
}

function startPlayback() {
  if (timer) return
  isPlaying.value = true
  timer = window.setInterval(() => nextStep({ fromPlayback: true }), 2200)
}

function stopPlayback() {
  isPlaying.value = false
  if (timer) {
    window.clearInterval(timer)
    timer = null
  }
}

function togglePlayback() {
  if (isPlaying.value) stopPlayback()
  else startPlayback()
}

function restart() {
  stopPlayback()
  activePhase.value = 0
  activeStep.value = 0
  selectedToken.value = 4
  includeProjectRules.value = true
}

onMounted(() => {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) stopPlayback()
})
onUnmounted(stopPlayback)
</script>

<template>
  <main class="omk-knowledge-explainer">
    <section class="kx-intro">
      <div class="kx-wrap">
        <p class="kx-eyebrow">{{ copy.eyebrow }}</p>
        <h1>{{ copy.title }}</h1>
        <p class="kx-lead">{{ copy.intro }}</p>
        <div class="kx-request">
          <span>{{ copy.requestLabel }}</span>
          <strong>{{ copy.request }}</strong>
        </div>
      </div>
    </section>

    <section class="kx-lab-section">
      <div class="kx-wrap">
        <div class="kx-lab">
          <header class="kx-lab-header">
            <div class="kx-phase-switch" role="tablist" :aria-label="copy.phaseStatus">
              <button
                v-for="(phase, index) in phases"
                :key="phase.short"
                type="button"
                role="tab"
                :aria-selected="activePhase === index"
                :class="{ active: activePhase === index }"
                @click="selectPhase(index)"
              >
                <span>{{ index + 1 }}</span>
                {{ phase.short }}
              </button>
              <i class="kx-phase-packet" :style="{ left: `${(activePhase + 0.5) * 33.3333}%` }" aria-hidden="true"></i>
            </div>

            <div class="kx-playback">
              <button type="button" class="kx-icon-button" :title="copy.previous" :aria-label="copy.previous" @click="previousStep">
                <span aria-hidden="true">←</span>
              </button>
              <button type="button" class="kx-play-button" @click="togglePlayback">
                <span aria-hidden="true">{{ isPlaying ? 'Ⅱ' : '▶' }}</span>
                {{ isPlaying ? copy.pause : copy.play }}
              </button>
              <button type="button" class="kx-icon-button" :title="copy.next" :aria-label="copy.next" @click="nextStep()">
                <span aria-hidden="true">→</span>
              </button>
              <button type="button" class="kx-icon-button" :title="copy.restart" :aria-label="copy.restart" @click="restart">
                <span aria-hidden="true">↺</span>
              </button>
            </div>
          </header>

          <div class="kx-scene-head">
            <div>
              <span>{{ copy.phaseStatus }} · {{ activePhase + 1 }}</span>
              <h2>{{ currentPhase.title }}</h2>
              <p>{{ currentPhase.lead }}</p>
            </div>
            <div class="kx-step-state" aria-live="polite">
              <strong>{{ currentStepLabel }}</strong>
              <span>{{ progressText }}</span>
            </div>
          </div>

          <div class="kx-step-rail" :style="{ '--step-count': currentPhase.steps.length }">
            <button
              v-for="(label, index) in currentPhase.steps"
              :key="label"
              type="button"
              :class="{ active: activeStep === index, done: activeStep > index }"
              @click="stopPlayback(); activeStep = index"
            >
              <i aria-hidden="true"></i>
              <span>{{ label }}</span>
            </button>
          </div>

          <div class="kx-scene">
            <div class="kx-visual">
              <div v-if="activePhase === 0" class="kx-transformer-scene">
                <div class="kx-original">
                  <span>{{ copy.originalText }}</span>
                  <p>{{ copy.request }}</p>
                </div>

                <div v-if="activeStep === 0" class="kx-tokenization">
                  <p>{{ copy.toyTokens }}</p>
                  <div class="kx-token-row">
                    <span v-for="(token, index) in tokens" :key="`${token}-${index}`" :style="{ '--delay': `${index * 55}ms` }">
                      {{ token }}
                    </span>
                  </div>
                </div>

                <div v-else-if="activeStep === 1" class="kx-vector-field">
                  <div v-for="(token, tokenIndex) in tokens" :key="`${token}-vector`" class="kx-vector-token">
                    <strong>{{ token }}</strong>
                    <div class="kx-vector-bars" aria-hidden="true">
                      <i
                        v-for="(value, vectorIndex) in vectorRows[tokenIndex]"
                        :key="vectorIndex"
                        :style="{ height: `${value}%`, opacity: 0.38 + vectorIndex * 0.08 }"
                      ></i>
                    </div>
                  </div>
                </div>

                <div v-else-if="activeStep === 2" class="kx-attention">
                  <div class="kx-attention-meta">
                    <span>{{ copy.selectedToken }}：<strong>{{ tokens[selectedToken] }}</strong></span>
                    <code>{{ copy.formula }}</code>
                  </div>
                  <svg viewBox="0 0 660 154" role="img" :aria-label="copy.attentionHint">
                    <path
                      v-for="(_, index) in tokens"
                      :key="`path-${index}`"
                      :d="attentionPath(index)"
                      :class="{ selected: index === selectedToken }"
                      :style="{
                        '--weight': attentionWeights[index],
                        strokeWidth: 1.5 + attentionWeights[index] * 15,
                        opacity: 0.18 + attentionWeights[index] * 1.7,
                      }"
                    />
                    <circle
                      v-for="(_, index) in tokens"
                      :key="`node-${index}`"
                      :cx="attentionX(index)"
                      cy="116"
                      :r="index === selectedToken ? 8 : 5"
                      :class="{ selected: index === selectedToken }"
                    />
                  </svg>
                  <div class="kx-token-selector">
                    <button
                      v-for="(token, index) in tokens"
                      :key="`${token}-selector`"
                      type="button"
                      :class="{ active: selectedToken === index }"
                      :aria-pressed="selectedToken === index"
                      @click="selectedToken = index"
                    >
                      <span>{{ token }}</span>
                      <small>{{ Math.round(attentionWeights[index] * 100) }}%</small>
                    </button>
                  </div>
                  <p class="kx-inline-hint">{{ copy.attentionHint }}</p>
                </div>

                <div v-else class="kx-probabilities">
                  <p>{{ copy.candidateLabel }}</p>
                  <div v-for="candidate in candidateTokens" :key="candidate.token" class="kx-probability-row">
                    <strong>{{ candidate.token }}</strong>
                    <span><i :style="{ width: `${candidate.value}%` }"></i></span>
                    <em>{{ candidate.value }}%</em>
                  </div>
                </div>
              </div>

              <div v-else-if="activePhase === 1" class="kx-agent-scene">
                <div class="kx-agent-track">
                  <div
                    v-for="(event, index) in agentEvents"
                    :key="event.title"
                    :class="['kx-agent-event', { active: activeStep === index, done: activeStep > index }]"
                  >
                    <span>{{ event.meta }}</span>
                    <strong>{{ event.title }}</strong>
                    <i v-if="index < agentEvents.length - 1" aria-hidden="true">→</i>
                  </div>
                </div>
                <div class="kx-context-strip">
                  <div>
                    <span>{{ copy.agentContext }}</span>
                    <strong>{{ activeAgentEvent.gained || copy.noContext }}</strong>
                  </div>
                  <div class="kx-context-meter">
                    <span>{{ copy.contextCount }}</span>
                    <i><b :style="{ width: `${18 + activeStep * 15}%` }"></b></i>
                    <strong>{{ activeStep + 1 }}</strong>
                  </div>
                </div>
              </div>

              <div v-else class="kx-knowledge-scene">
                <div class="kx-knowledge-river">
                  <div
                    v-for="(source, index) in knowledgeSources"
                    :key="source.kind"
                    :class="['kx-knowledge-source', source.kind, { active: activeStep === index, muted: index === 1 && !includeProjectRules }]"
                  >
                    <span>{{ index + 1 }}</span>
                    <strong>{{ source.title }}</strong>
                    <small>{{ source.subtitle }}</small>
                  </div>
                  <i class="kx-knowledge-packet" :style="{ left: `${(activeStep + 0.5) * 25}%` }" aria-hidden="true"></i>
                </div>

                <label class="kx-rule-toggle">
                  <input v-model="includeProjectRules" type="checkbox">
                  <span aria-hidden="true"><i></i></span>
                  <strong>{{ copy.knowledgeRuleToggle }}</strong>
                  <small>{{ copy.knowledgeRuleHelp }}</small>
                </label>

                <div :class="['kx-outcome', knowledgeOutcome.tone]">
                  <div>
                    <span>{{ copy.outcome }}</span>
                    <strong>{{ knowledgeOutcome.action }}</strong>
                  </div>
                  <dl>
                    <div>
                      <dt>{{ copy.evidence }}</dt>
                      <dd>{{ knowledgeOutcome.basis }}</dd>
                    </div>
                    <div>
                      <dt>{{ copy.unresolved }}</dt>
                      <dd>{{ knowledgeOutcome.unresolved }}</dd>
                    </div>
                  </dl>
                </div>
              </div>
            </div>

            <aside class="kx-inspector" aria-live="polite">
              <span :class="['kx-truth-badge', `phase-${activePhase}`]">{{ sceneTruthKind }}</span>
              <p class="kx-inspector-step">{{ currentStepLabel }}</p>
              <p>{{ sceneExplanation }}</p>
              <div v-if="activePhase === 2" class="kx-source-detail">
                <span>{{ activeKnowledgeSource.title }}</span>
                <strong>{{ activeKnowledgeSource.subtitle }}</strong>
              </div>
            </aside>
          </div>
        </div>
      </div>
    </section>

    <section class="kx-insight-section">
      <div class="kx-wrap">
        <p class="kx-eyebrow">{{ copy.insightTitle }}</p>
        <div class="kx-insight-grid">
          <article>
            <span>01</span>
            <h2>{{ copy.parameterTitle }}</h2>
            <p>{{ copy.parameterBody }}</p>
          </article>
          <article>
            <span>02</span>
            <h2>{{ copy.contextTitle }}</h2>
            <p>{{ copy.contextBody }}</p>
          </article>
          <article>
            <span>03</span>
            <h2>{{ copy.runtimeTitle }}</h2>
            <p>{{ copy.runtimeBody }}</p>
          </article>
        </div>
      </div>
    </section>

    <section class="kx-boundary-section">
      <div class="kx-wrap">
        <div class="kx-boundary-head">
          <p class="kx-eyebrow">{{ copy.boundaryTitle }}</p>
          <p>{{ copy.boundaryIntro }}</p>
        </div>
        <div class="kx-boundary-grid">
          <article v-for="item in copy.boundaryItems" :key="item.kind" :class="item.kind">
            <i aria-hidden="true"></i>
            <div>
              <h2>{{ item.label }}</h2>
              <p>{{ item.body }}</p>
            </div>
          </article>
        </div>
        <nav class="kx-sources" :aria-label="copy.sources">
          <span>{{ copy.sources }}</span>
          <a href="https://arxiv.org/abs/1706.03762" target="_blank" rel="noreferrer">Attention Is All You Need</a>
          <a href="https://arxiv.org/abs/2305.04388" target="_blank" rel="noreferrer">Chain-of-Thought Faithfulness</a>
          <a href="https://www.anthropic.com/research/mapping-mind-language-model" target="_blank" rel="noreferrer">Mechanistic Interpretability</a>
        </nav>
      </div>
    </section>
  </main>
</template>
