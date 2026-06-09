---
layout: home

hero:
  name: omk
  text: 知识改了，真的变好了吗？
  tagline: 面向 LLM 知识输入（prompt / RAG / skill / agent）的评测与迭代框架。固定模型、只变知识载体，用统计可比的诊断代替「感觉好像好了」。
  actions:
    - theme: brand
      text: 快速上手
      link: /zh/quickstart-skill-eval
    - theme: alt
      text: 为什么要测量学
      link: /zh/explanation/statistical-rigor
    - theme: alt
      text: GitHub
      link: https://github.com/lizhiyao/oh-my-knowledge

features:
  - title: 三阶段——检查 / 评测 / 观测
    details: doctor 在花钱前先把用例集健康度卡住；eval 用五层管道给知识变体打分；observe 追踪线上回归。一套框架，三件事。
  - title: 统计可比，不是凭感觉
    details: 对差值做 bootstrap 置信区间、评委一致性、长度去偏。报告里的 Δ 代表测量噪声之内的真实差异，而不是「数字动了一下」。
  - title: evolve——只收被证明的提升
    details: 提出一处改动，在留出集上要求统计显著才接受，并在锁定的 test 集上给一个无偏泛化分。拒绝与评委噪声不可分的「提升」。
  - title: Agent Skill 入场
    details: 通过 npm 安装 omk 后运行 `omk install omk-agent-skill`，即可把 omk 官方 Agent Skill 装到本机 coding agent，用自然语言驱动 doctor、eval、sample、evolve、observe 和 studio。
---
