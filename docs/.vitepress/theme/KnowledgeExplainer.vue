<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useData } from 'vitepress'
import './knowledge-explainer.css'

const isZh = useData().lang.value.startsWith('zh')
const pick = (zh, en) => (isZh ? zh : en)

const copy = {
  eyebrow: pick('一个可探索的 AI 工作现场', 'An explorable AI workbench'),
  title: pick('一条请求，AI 究竟知道什么？', 'One request. What does AI actually know?'),
  intro: pick(
    '不要把它当成三张流程图。播放同一条请求，看文字怎样变成行动、外部 knowledge 怎样进入上下文，以及少一条规范为什么会改变结果。',
    'Do not treat this as three flowcharts. Follow one request as text becomes action, external knowledge enters context, and one missing rule changes the result.',
  ),
  request: pick(
    '请按照这个项目的规范修复登录失败问题。',
    'Fix the login failure according to this project’s rules.',
  ),
  play: pick('播放', 'Play'),
  pause: pick('暂停', 'Pause'),
  previous: pick('上一步', 'Previous'),
  next: pick('下一步', 'Next'),
  restart: pick('重新开始', 'Restart'),
  timeline: pick('动画进度', 'Animation progress'),
  scene: pick('场景', 'Scene'),
  truth: pick('这一幕是什么', 'What this scene represents'),
  ruleToggle: pick('项目规范', 'Project rules'),
  ruleOn: pick('已进入上下文', 'in context'),
  ruleOff: pick('已从上下文移除', 'removed'),
  ruleHelp: pick(
    '切换后，模型不变，只有可用 knowledge 改变。',
    'The model stays fixed. Only the available knowledge changes.',
  ),
  userRequest: pick('用户请求', 'User request'),
  workingContext: pick('工作上下文', 'Working context'),
  contextEmpty: pick('等待外部证据', 'Waiting for external evidence'),
  model: pick('微型 Transformer', 'Toy Transformer'),
  modelMeta: pick('固定参数', 'fixed parameters'),
  attention: 'self-attention',
  actionCandidates: pick('下一动作概率', 'Next-action probabilities'),
  realWorld: pick('真实环境', 'Real environment'),
  toolIdle: pick('工具尚未调用', 'No tool call yet'),
  toolReading: pick('读取项目文件', 'Reading project files'),
  toolTesting: pick('运行登录测试', 'Running login tests'),
  knowledgeSources: pick('可用 knowledge', 'Available knowledge'),
  parameter: pick('参数模式', 'Parameter patterns'),
  projectRule: pick('项目规范', 'Project rules'),
  runtimeEvidence: pick('运行证据', 'Runtime evidence'),
  candidate: pick('经验候选', 'Experience candidate'),
  nextAction: pick('下一行动', 'Next action'),
  withRule: pick('有项目规范', 'With project rules'),
  withoutRule: pick('没有项目规范', 'Without project rules'),
  groundedAction: pick('先按仓库约定处理错误，再运行登录测试。', 'Apply the repository error policy, then run the login tests.'),
  genericAction: pick('按通用经验直接修改登录逻辑。', 'Edit the login logic from generic experience.'),
  observedResult: pick('测试暴露：刷新令牌失效时必须清除本地会话。', 'Test evidence: an expired refresh token must clear the local session.'),
  contextSystem: pick('工具边界', 'Tool boundaries'),
  contextRule: pick('错误处理规范', 'Error-handling policy'),
  contextFile: 'auth/session.ts',
  contextTest: pick('登录测试失败', 'Login test failed'),
  outputTool: pick('读取 AGENTS.md', 'Read AGENTS.md'),
  outputSearch: pick('搜索登录逻辑', 'Search login logic'),
  outputEdit: pick('直接修改代码', 'Edit code now'),
  outputAnswer: pick('直接回答', 'Answer now'),
  selectedToken: pick('点击 token，观察关联', 'Select a token to inspect attention'),
  summaryEyebrow: pick('把尺度分开，才不会把 knowledge 混成一团', 'Separate the scales before discussing knowledge'),
  summaryTitle: pick('模型提供能力，环境提供事实，knowledge 提供具体依据。', 'The model supplies capability, the environment supplies facts, and knowledge supplies situated guidance.'),
  layers: [
    {
      key: 'parameters',
      index: '01',
      title: pick('参数中的 knowledge', 'Knowledge in parameters'),
      body: pick('训练形成的语言与代码模式。它影响能力，但不是一个可以逐条打开的文档库。', 'Language and code patterns formed during training. They shape capability but are not a browsable document store.'),
    },
    {
      key: 'context',
      index: '02',
      title: pick('上下文中的 knowledge', 'Knowledge in context'),
      body: pick('指令、项目文件、memory、RAG 与 skill。它们可检查、可替换，也最适合受控比较。', 'Instructions, project files, memory, RAG, and skills. They are inspectable, replaceable, and suitable for controlled comparison.'),
    },
    {
      key: 'runtime',
      index: '03',
      title: pick('运行中获得的 knowledge', 'Knowledge gained at runtime'),
      body: pick('文件内容、搜索结果、测试反馈与真实环境状态。它们通过工具返回上下文。', 'File contents, search results, test feedback, and environment state. Tools return them to context.'),
    },
    {
      key: 'candidate',
      index: '04',
      title: pick('工作后形成的候选', 'Post-task candidates'),
      body: pick('纠正、失败经验与隐性标准。它们值得复核，但不会自动成为可靠 knowledge。', 'Corrections, failures, and tacit standards. They deserve review but do not automatically become reliable knowledge.'),
    },
  ],
  boundaryEyebrow: pick('别把可视化冒充读心术', 'Visualization is not mind reading'),
  boundaryTitle: pick('我们只展示能够诚实说明的部分。', 'Show only what can be represented honestly.'),
  boundaries: [
    {
      key: 'simulated',
      title: pick('教学模拟', 'Teaching simulation'),
      body: pick('token、attention 和动作概率使用可解释的微型示例。', 'Tokens, attention, and action probabilities use an interpretable toy example.'),
    },
    {
      key: 'observed',
      title: pick('观测事实', 'Observed fact'),
      body: pick('请求、上下文、工具调用、文件和测试结果可以被 trace 记录。', 'Requests, context, tool calls, files, and test results can be recorded in traces.'),
    },
    {
      key: 'inferred',
      title: pick('系统推断', 'System inference'),
      body: pick('移除 knowledge 后的影响需要通过受控比较建立证据。', 'The effect of removing knowledge requires evidence from controlled comparison.'),
    },
    {
      key: 'unavailable',
      title: pick('不可观测', 'Unavailable'),
      body: pick('闭源模型的完整激活、权重因果链和所谓「真实内心独白」。', 'Complete activations, causal weight paths, and any supposed inner monologue of a closed model.'),
    },
  ],
  omkEyebrow: 'OMK',
  omkTitle: pick('OMK 观察的，正是可控 knowledge 与真实结果之间的这段距离。', 'OMK observes the distance between controllable knowledge and real outcomes.'),
  omkBody: pick(
    '它不解释闭源模型脑内发生了什么；它固定模型与评测用例，改变知识载体，记录 trace，并比较版本差异是否真的成立。',
    'It does not explain what happens inside a closed model. It fixes the model and evaluation cases, changes the knowledge artifact, records traces, and tests whether a version difference is real.',
  ),
  sources: pick('参考', 'Sources'),
}

const scenes = [
  {
    key: 'request',
    short: pick('请求', 'Request'),
    title: pick('任务从一句自然语言开始', 'The task begins as natural language'),
    body: pick(
      'Agent 此刻只有目标。代码在哪里、项目允许怎样修改、真正的根因是什么，都还是未知。',
      'The Agent has a goal, but the code location, accepted project practice, and concrete root cause are still unknown.',
    ),
    truth: pick('观测事实', 'Observed fact'),
    truthKind: 'observed',
  },
  {
    key: 'tokens',
    short: 'Token',
    title: pick('文字先被切成 token', 'Text first becomes tokens'),
    body: pick(
      '模型不会直接读取完整句意。token 被映射为数值表示，沿同一条路径进入模型。',
      'The model does not ingest a finished sentence meaning. Tokens become numerical representations and enter the model together.',
    ),
    truth: pick('教学模拟', 'Teaching simulation'),
    truthKind: 'simulated',
  },
  {
    key: 'attention',
    short: 'Attention',
    title: pick('上下文改变每个 token 的表示', 'Context changes each token representation'),
    body: pick(
      '点击 token 查看 attention 关联。线更强只表示这个微型示例中的权重更高，不等于完整因果解释。',
      'Select a token to inspect attention. A stronger line only means a higher weight in this toy example, not a complete causal explanation.',
    ),
    truth: pick('教学模拟', 'Teaching simulation'),
    truthKind: 'simulated',
  },
  {
    key: 'decision',
    short: pick('动作', 'Action'),
    title: pick('模型生成的下一项，可以是工具调用', 'The next generated item can be a tool call'),
    body: pick(
      '真实 Agent 能观测到工具调用；这里的概率只是教学模拟。项目规范在上下文中时，「先读取规范」更可能被选择。',
      'A real Agent exposes the tool call; the probabilities here are illustrative. When project rules are in context, reading them first becomes more likely.',
    ),
    truth: pick('模拟概率／可观测动作', 'Simulated probability / observed action'),
    truthKind: 'mixed',
  },
  {
    key: 'evidence',
    short: pick('证据', 'Evidence'),
    title: pick('工具把真实世界带回上下文', 'Tools bring the real world back into context'),
    body: pick(
      '文件内容和测试失败不是模型参数里的记忆。它们在运行时被读取，作为新证据返回下一轮模型调用。',
      'File contents and test failures are not memories stored in model parameters. They are read at runtime and returned as evidence for the next model call.',
    ),
    truth: pick('观测事实', 'Observed fact'),
    truthKind: 'observed',
  },
  {
    key: 'knowledge',
    short: 'Knowledge',
    title: pick('项目 knowledge 进入同一个上下文', 'Project knowledge enters the same context'),
    body: pick(
      '参数没有改变。Agent 只是多了一条当前项目认可的错误处理规范，它因此有了更具体的行动依据。',
      'The parameters did not change. The Agent gained one accepted error-handling rule for this project, giving it more specific grounds for action.',
    ),
    truth: pick('观测事实', 'Observed fact'),
    truthKind: 'observed',
  },
  {
    key: 'fork',
    short: pick('分叉', 'Fork'),
    title: pick('同一个模型，不同 knowledge，不同行动', 'Same model, different knowledge, different action'),
    body: pick(
      '切换「项目规范」开关。这个对照展示产品假设；要证明真实效果，还需要固定模型和用例做重复评测。',
      'Toggle project rules. This contrast illustrates the product hypothesis; proving a real effect still requires repeated evaluation with a fixed model and cases.',
    ),
    truth: pick('系统推断', 'System inference'),
    truthKind: 'inferred',
  },
  {
    key: 'candidate',
    short: pick('沉淀', 'Candidate'),
    title: pick('一次任务结束，新的 knowledge 只是一名候选', 'A finished task yields only a knowledge candidate'),
    body: pick(
      '测试暴露的规律、用户纠正和失败经验可以进入待复核池。复用之前，仍要判断它是否稳定、适用且真的有效。',
      'Patterns exposed by tests, user corrections, and failures can enter a review pool. Before reuse, they still need evidence of stability, scope, and effectiveness.',
    ),
    truth: pick('系统推断', 'System inference'),
    truthKind: 'inferred',
  },
]

const tokens = isZh
  ? ['请', '按', '项目', '规范', '修复', '登录', '问题']
  : ['Fix', 'login', 'using', 'project', 'rules', 'please', '.']

const activeScene = ref(0)
const selectedToken = ref(isZh ? 3 : 4)
const isPlaying = ref(false)
const rulesEnabled = ref(true)
let timer

const scene = computed(() => scenes[activeScene.value])
const stageClass = computed(() => [
  `scene-${activeScene.value}`,
  `scene-${scene.value.key}`,
  rulesEnabled.value ? 'rules-on' : 'rules-off',
])
const sceneProgress = computed(() => ((activeScene.value + 1) / scenes.length) * 100)
const showAttention = computed(() => activeScene.value === 2)
const showProbabilities = computed(() => activeScene.value >= 3)

const attentionWeights = computed(() => {
  const links = isZh
    ? {
        0: [1, 4],
        1: [2, 3, 4],
        2: [1, 3, 4],
        3: [1, 2, 4],
        4: [2, 3, 5, 6],
        5: [4, 6],
        6: [4, 5],
      }
    : {
        0: [1, 2, 5],
        1: [0, 2, 6],
        2: [0, 1, 3, 4],
        3: [2, 4],
        4: [2, 3],
        5: [0, 6],
        6: [1, 5],
      }
  const related = links[selectedToken.value] || []
  const values = tokens.map((_, index) => {
    const self = index === selectedToken.value ? 0.36 : 0
    const semantic = related.includes(index) ? 0.25 : 0
    const proximity = 0.1 / (Math.abs(index - selectedToken.value) + 1)
    return 0.02 + self + semantic + proximity
  })
  const total = values.reduce((sum, value) => sum + value, 0)
  return values.map((value) => value / total)
})

const actionCandidates = computed(() => {
  if (rulesEnabled.value) {
    return [
      { label: copy.outputTool, value: 56, kind: 'primary' },
      { label: copy.outputSearch, value: 27, kind: 'secondary' },
      { label: copy.outputEdit, value: 11, kind: 'warning' },
      { label: copy.outputAnswer, value: 6, kind: 'muted' },
    ]
  }
  return [
    { label: copy.outputSearch, value: 39, kind: 'secondary' },
    { label: copy.outputEdit, value: 35, kind: 'warning' },
    { label: copy.outputAnswer, value: 18, kind: 'muted' },
    { label: copy.outputTool, value: 8, kind: 'primary' },
  ]
})

function attentionX(index) {
  return 22 + index * 39
}

function attentionPath(index) {
  const from = attentionX(selectedToken.value)
  const to = attentionX(index)
  if (from === to) return `M ${from} 76 C ${from - 12} 42, ${from + 12} 42, ${to} 76`
  return `M ${from} 76 Q ${(from + to) / 2} ${18 + Math.abs(from - to) * 0.04} ${to} 76`
}

function stopPlayback() {
  isPlaying.value = false
  if (timer) {
    window.clearInterval(timer)
    timer = undefined
  }
}

function goToScene(index, { keepPlayback = false } = {}) {
  if (!keepPlayback) stopPlayback()
  activeScene.value = Math.max(0, Math.min(scenes.length - 1, Number(index)))
}

function previousScene() {
  goToScene(activeScene.value > 0 ? activeScene.value - 1 : scenes.length - 1)
}

function nextScene({ fromPlayback = false } = {}) {
  const atEnd = activeScene.value === scenes.length - 1
  if (atEnd && fromPlayback) {
    stopPlayback()
    return
  }
  goToScene(atEnd ? 0 : activeScene.value + 1, { keepPlayback: fromPlayback })
}

function togglePlayback() {
  if (isPlaying.value) {
    stopPlayback()
    return
  }
  if (activeScene.value === scenes.length - 1) activeScene.value = 0
  isPlaying.value = true
  timer = window.setInterval(() => nextScene({ fromPlayback: true }), 3200)
}

function restart() {
  stopPlayback()
  activeScene.value = 0
  selectedToken.value = isZh ? 3 : 4
  rulesEnabled.value = true
}

function toggleRules() {
  stopPlayback()
  rulesEnabled.value = !rulesEnabled.value
}

watch(activeScene, (value) => {
  if (value === 6 && isPlaying.value) stopPlayback()
})

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
      </div>
    </section>

    <section class="kx-theater-section">
      <div class="kx-wrap">
        <div class="kx-theater">
          <header class="kx-story-head">
            <div>
              <span>{{ copy.scene }} {{ activeScene + 1 }} / {{ scenes.length }}</span>
              <h2>{{ scene.title }}</h2>
              <p>{{ scene.body }}</p>
            </div>
            <div :class="['kx-truth', scene.truthKind]">
              <small>{{ copy.truth }}</small>
              <strong>{{ scene.truth }}</strong>
            </div>
          </header>

          <div :class="['kx-stage', ...stageClass]" aria-live="polite">
            <svg class="kx-stage-connections" viewBox="0 0 1200 620" preserveAspectRatio="none" aria-hidden="true">
              <defs>
                <marker id="kx-arrow-blue" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" class="kx-marker blue"></path>
                </marker>
                <marker id="kx-arrow-cyan" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" class="kx-marker cyan"></path>
                </marker>
                <marker id="kx-arrow-amber" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" class="kx-marker amber"></path>
                </marker>
              </defs>

              <path class="kx-flow request-model" d="M 298 128 C 365 128, 390 230, 454 230" marker-end="url(#kx-arrow-blue)"></path>
              <path class="kx-flow model-tool" d="M 746 236 C 792 236, 807 164, 850 164" marker-end="url(#kx-arrow-blue)"></path>
              <path class="kx-flow tool-context" d="M 994 278 C 914 350, 530 407, 324 380" marker-end="url(#kx-arrow-cyan)"></path>
              <path class="kx-flow context-model" d="M 324 360 C 380 342, 400 300, 454 294" marker-end="url(#kx-arrow-cyan)"></path>
              <path class="kx-flow knowledge-context" d="M 568 520 C 510 472, 400 430, 276 418" marker-end="url(#kx-arrow-amber)"></path>
              <path class="kx-flow model-outcome" d="M 746 310 C 810 328, 814 422, 858 438" marker-end="url(#kx-arrow-blue)"></path>
              <path class="kx-flow result-candidate" d="M 998 502 C 916 560, 790 574, 706 548" marker-end="url(#kx-arrow-amber)"></path>

              <circle class="kx-packet request-packet" r="6">
                <animateMotion dur="1.4s" repeatCount="indefinite" path="M 298 128 C 365 128, 390 230, 454 230"></animateMotion>
              </circle>
              <circle class="kx-packet tool-packet" r="6">
                <animateMotion dur="1.5s" repeatCount="indefinite" path="M 746 236 C 792 236, 807 164, 850 164"></animateMotion>
              </circle>
              <circle class="kx-packet evidence-packet" r="6">
                <animateMotion dur="2.1s" repeatCount="indefinite" path="M 994 278 C 914 350, 530 407, 324 380"></animateMotion>
              </circle>
              <circle class="kx-packet knowledge-packet" r="6">
                <animateMotion dur="1.7s" repeatCount="indefinite" path="M 568 520 C 510 472, 400 430, 276 418"></animateMotion>
              </circle>
              <circle class="kx-packet candidate-packet" r="6">
                <animateMotion dur="1.8s" repeatCount="indefinite" path="M 998 502 C 916 560, 790 574, 706 548"></animateMotion>
              </circle>
            </svg>

            <section class="kx-stage-node kx-request-node">
              <span class="kx-node-kicker">01 · REQUEST</span>
              <p>{{ copy.request }}</p>
              <div class="kx-request-caret" aria-hidden="true"></div>
            </section>

            <div class="kx-travel-tokens" aria-label="tokens">
              <button
                v-for="(token, index) in tokens"
                :key="`${token}-${index}`"
                type="button"
                :class="{ selected: selectedToken === index }"
                :disabled="!showAttention"
                :aria-pressed="selectedToken === index"
                :title="copy.selectedToken"
                @click="selectedToken = index"
              >
                {{ token }}
              </button>
            </div>

            <section class="kx-stage-node kx-context-node">
              <div class="kx-node-title">
                <span class="kx-node-kicker">CONTEXT</span>
                <strong>{{ copy.workingContext }}</strong>
              </div>
              <div class="kx-context-stack">
                <span class="system">{{ copy.contextSystem }}</span>
                <span :class="['rule', { absent: !rulesEnabled }]">{{ copy.contextRule }}</span>
                <span class="file">{{ copy.contextFile }}</span>
                <span class="test">{{ copy.contextTest }}</span>
              </div>
              <small>{{ copy.contextEmpty }}</small>
            </section>

            <section class="kx-stage-node kx-model-node">
              <div class="kx-node-title">
                <span class="kx-node-kicker">MODEL</span>
                <strong>{{ copy.model }}</strong>
                <small>{{ copy.modelMeta }}</small>
              </div>

              <div class="kx-model-stack" aria-hidden="true">
                <i>embedding</i>
                <i>{{ copy.attention }}</i>
                <i>MLP + residual</i>
                <i>softmax</i>
              </div>

              <div :class="['kx-model-detail', { probabilities: showProbabilities }]">
                <div class="kx-attention-view">
                  <svg viewBox="0 0 280 92" role="img" :aria-label="copy.selectedToken">
                    <path
                      v-for="(_, index) in tokens"
                      :key="`attention-${index}`"
                      :d="attentionPath(index)"
                      :class="{ selected: selectedToken === index }"
                      :style="{
                        strokeWidth: 1 + attentionWeights[index] * 12,
                        opacity: 0.16 + attentionWeights[index] * 2,
                      }"
                    ></path>
                    <circle
                      v-for="(_, index) in tokens"
                      :key="`attention-node-${index}`"
                      :cx="attentionX(index)"
                      cy="76"
                      :r="selectedToken === index ? 6 : 4"
                      :class="{ selected: selectedToken === index }"
                    ></circle>
                  </svg>
                  <small>{{ copy.selectedToken }}</small>
                </div>

                <div class="kx-probability-view">
                  <span>{{ copy.actionCandidates }}</span>
                  <div v-for="candidate in actionCandidates" :key="candidate.label" class="kx-probability">
                    <strong>{{ candidate.label }}</strong>
                    <i><b :class="candidate.kind" :style="{ width: `${candidate.value}%` }"></b></i>
                    <em>{{ candidate.value }}%</em>
                  </div>
                </div>
              </div>
            </section>

            <section class="kx-stage-node kx-tool-node">
              <div class="kx-node-title">
                <span class="kx-node-kicker">TOOLS + ENV</span>
                <strong>{{ copy.realWorld }}</strong>
              </div>
              <div class="kx-terminal">
                <span class="idle">{{ copy.toolIdle }}</span>
                <span class="reading"><i>$</i> {{ copy.toolReading }}</span>
                <span class="testing"><i>$</i> {{ copy.toolTesting }}</span>
                <strong>{{ copy.observedResult }}</strong>
              </div>
            </section>

            <section class="kx-stage-node kx-knowledge-node">
              <div class="kx-node-title">
                <span class="kx-node-kicker">KNOWLEDGE</span>
                <strong>{{ copy.knowledgeSources }}</strong>
              </div>
              <div class="kx-knowledge-items">
                <span class="parameter">{{ copy.parameter }}</span>
                <span :class="['project', { absent: !rulesEnabled }]">{{ copy.projectRule }}</span>
                <span class="runtime">{{ copy.runtimeEvidence }}</span>
                <span class="candidate">{{ copy.candidate }}</span>
              </div>
            </section>

            <section class="kx-stage-node kx-outcome-node">
              <span class="kx-node-kicker">OUTCOME</span>
              <strong>{{ copy.nextAction }}</strong>
              <div class="kx-outcome-paths">
                <article :class="{ active: rulesEnabled }">
                  <span>{{ copy.withRule }}</span>
                  <p>{{ copy.groundedAction }}</p>
                </article>
                <article :class="{ active: !rulesEnabled }">
                  <span>{{ copy.withoutRule }}</span>
                  <p>{{ copy.genericAction }}</p>
                </article>
              </div>
            </section>

            <div class="kx-stage-label request">{{ copy.userRequest }}</div>
            <div class="kx-stage-label model">{{ copy.model }}</div>
            <div class="kx-stage-label evidence">{{ copy.runtimeEvidence }}</div>
          </div>

          <div class="kx-control-deck">
            <div class="kx-playback">
              <button type="button" class="kx-icon-button" :title="copy.previous" :aria-label="copy.previous" @click="previousScene">
                <span aria-hidden="true">←</span>
              </button>
              <button type="button" class="kx-play-button" @click="togglePlayback">
                <span aria-hidden="true">{{ isPlaying ? 'Ⅱ' : '▶' }}</span>
                {{ isPlaying ? copy.pause : copy.play }}
              </button>
              <button type="button" class="kx-icon-button" :title="copy.next" :aria-label="copy.next" @click="nextScene()">
                <span aria-hidden="true">→</span>
              </button>
              <button type="button" class="kx-icon-button" :title="copy.restart" :aria-label="copy.restart" @click="restart">
                <span aria-hidden="true">↺</span>
              </button>
            </div>

            <div class="kx-scrubber">
              <input
                :value="activeScene"
                type="range"
                min="0"
                :max="scenes.length - 1"
                step="1"
                :aria-label="copy.timeline"
                :style="{ '--progress': `${sceneProgress}%` }"
                @input="goToScene($event.target.value)"
              >
              <div class="kx-chapters">
                <button
                  v-for="(item, index) in scenes"
                  :key="item.key"
                  type="button"
                  :class="{ active: activeScene === index, done: activeScene > index }"
                  @click="goToScene(index)"
                >
                  <i aria-hidden="true"></i>
                  <span>{{ item.short }}</span>
                </button>
              </div>
            </div>

            <button
              type="button"
              role="switch"
              :aria-checked="rulesEnabled"
              :disabled="activeScene < 5"
              :class="['kx-rule-switch', { active: rulesEnabled, revealed: activeScene >= 5 }]"
              @click="toggleRules"
            >
              <span aria-hidden="true"><i></i></span>
              <strong>{{ copy.ruleToggle }}</strong>
              <small>{{ rulesEnabled ? copy.ruleOn : copy.ruleOff }}</small>
            </button>
          </div>

          <p v-if="activeScene >= 5" class="kx-rule-help">{{ copy.ruleHelp }}</p>
        </div>
      </div>
    </section>

    <section class="kx-summary-section">
      <div class="kx-wrap">
        <p class="kx-eyebrow">{{ copy.summaryEyebrow }}</p>
        <h2>{{ copy.summaryTitle }}</h2>
        <div class="kx-layer-list">
          <article v-for="layer in copy.layers" :key="layer.key" :class="layer.key">
            <span>{{ layer.index }}</span>
            <div>
              <h3>{{ layer.title }}</h3>
              <p>{{ layer.body }}</p>
            </div>
          </article>
        </div>
      </div>
    </section>

    <section class="kx-boundary-section">
      <div class="kx-wrap">
        <div class="kx-boundary-head">
          <div>
            <p class="kx-eyebrow">{{ copy.boundaryEyebrow }}</p>
            <h2>{{ copy.boundaryTitle }}</h2>
          </div>
          <div class="kx-boundary-list">
            <article v-for="item in copy.boundaries" :key="item.key" :class="item.key">
              <i aria-hidden="true"></i>
              <div>
                <h3>{{ item.title }}</h3>
                <p>{{ item.body }}</p>
              </div>
            </article>
          </div>
        </div>

        <div class="kx-omk-note">
          <span>{{ copy.omkEyebrow }}</span>
          <div>
            <h2>{{ copy.omkTitle }}</h2>
            <p>{{ copy.omkBody }}</p>
          </div>
        </div>

        <nav class="kx-sources" :aria-label="copy.sources">
          <span>{{ copy.sources }}</span>
          <a href="https://poloclub.github.io/transformer-explainer/" target="_blank" rel="noreferrer">Transformer Explainer</a>
          <a href="https://www.3blue1brown.com/lessons/attention/" target="_blank" rel="noreferrer">3Blue1Brown · Attention</a>
          <a href="https://distill.pub/about/" target="_blank" rel="noreferrer">Distill</a>
          <a href="https://arxiv.org/abs/2305.04388" target="_blank" rel="noreferrer">CoT Faithfulness</a>
        </nav>
      </div>
    </section>
  </main>
</template>
