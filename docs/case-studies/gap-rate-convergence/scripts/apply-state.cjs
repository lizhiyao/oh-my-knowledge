#!/usr/bin/env node
/**
 * apply-state.js — 把 semantic-index.md 切换到指定的 strip 状态
 *
 * 用法:
 *   node apply-state.js v0    # 最 strip 状态
 *   node apply-state.js v1    # 部分回补
 *   node apply-state.js v2    # 完整状态（还原原始）
 *
 * 基准：_original.md（Phase 0 快照）作为 single source of truth
 * 目标：workspace/.claude/knowledge/semantic-index.md
 *
 * 永远从 _original.md 生成 → 写入 target。不会累积 strip 错误。
 */

const fs = require('node:fs');
const path = require('node:path');

const ORIGINAL = path.resolve(__dirname, '..', 'knowledge-diffs', '_original.md');
const TARGET = '/Users/lizhiyao/Projects/workspace/.claude/knowledge/semantic-index.md';

// ============================================================================
// Strip 主题定义
// ============================================================================
// 每个主题声明两类移除目标：
//   linePatterns:    单行级移除（table row、inline 引用）
//   sectionHeaders:  三级标题级整段移除（从匹配的 ### 到下一个 ###/##）
//
// 说明：所有 pattern 是 RegExp，作用在单行文本上。section 移除以匹配到的
// ### 开头行为起点，直到遇到下一个 ### 或 ## 为止（不含下一行）。
// ============================================================================

const TOPICS = {
  'multi-insured': {
    description: '多被保人老样式投保组件',
    linePatterns: [
      /多被保人老样式/,
      /MultipleInsuredUsers/,
      /example-app-biz-multiple-insured-users/,
    ],
    sectionHeaders: [],
  },
  'health-aspect': {
    description: '健康险切面（双险投保）',
    linePatterns: [
      /example-app-aspect-health/,
      /健康险切面/,
      /dual-insure/,
      /适当性评估/,
    ],
    sectionHeaders: [
      /^### example-app-aspect-health/,
    ],
  },
  'video-component': {
    description: '投保页视频组件',
    linePatterns: [
      /components-insure-common-video/,
      /投保页视频播放/,
      /视频组件.*投保页/,
    ],
    sectionHeaders: [],
  },
  'insadvance': {
    description: '新投进阶/升级（云梯）组件',
    linePatterns: [
      /insadvance/,
      /insdavance/, // intentional typo in source
      /云梯/,
      /新投进阶/,
      /升级讲解视频/,
    ],
    sectionHeaders: [
      /^### 新投进阶\/升级/,
    ],
  },
};

// ============================================================================
// State 定义
// ============================================================================
const STATES = {
  v0: {
    description: '最 strip 状态：剪除 4 个主题',
    strip: ['multi-insured', 'health-aspect', 'video-component', 'insadvance'],
  },
  v1: {
    description: '部分回补：恢复 multi-insured + video-component',
    strip: ['health-aspect', 'insadvance'],
  },
  v2: {
    description: '完整状态：不剪除任何主题（还原原始）',
    strip: [],
  },
};

// ============================================================================
// Strip 主体逻辑
// ============================================================================

function stripContent(content, topicsToStrip) {
  const lines = content.split('\n');
  const removed = { byPattern: 0, bySection: 0 };

  // Pass 1: 标记 section 移除范围
  const sectionRangesToRemove = [];
  for (const topicKey of topicsToStrip) {
    const topic = TOPICS[topicKey];
    if (!topic) continue;
    for (const sectionHeader of topic.sectionHeaders) {
      for (let i = 0; i < lines.length; i++) {
        if (sectionHeader.test(lines[i])) {
          // 从当前行开始，往下找到下一个 ### 或 ##
          let end = lines.length;
          for (let j = i + 1; j < lines.length; j++) {
            if (/^## /.test(lines[j]) || /^### /.test(lines[j])) {
              end = j;
              break;
            }
          }
          sectionRangesToRemove.push([i, end]);
        }
      }
    }
  }

  // 合并重叠的 section 范围
  sectionRangesToRemove.sort((a, b) => a[0] - b[0]);
  const mergedRanges = [];
  for (const range of sectionRangesToRemove) {
    const last = mergedRanges[mergedRanges.length - 1];
    if (last && range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1]);
    } else {
      mergedRanges.push([...range]);
    }
  }

  // 标记被 section 范围覆盖的行
  const sectionRemoved = new Array(lines.length).fill(false);
  for (const [start, end] of mergedRanges) {
    for (let i = start; i < end; i++) {
      if (!sectionRemoved[i]) {
        sectionRemoved[i] = true;
        removed.bySection += 1;
      }
    }
  }

  // Pass 2: 行级 pattern 移除（跳过已被 section 移除的）
  const linePatternRemoved = new Array(lines.length).fill(false);
  for (const topicKey of topicsToStrip) {
    const topic = TOPICS[topicKey];
    if (!topic) continue;
    for (const pattern of topic.linePatterns) {
      for (let i = 0; i < lines.length; i++) {
        if (sectionRemoved[i] || linePatternRemoved[i]) continue;
        if (pattern.test(lines[i])) {
          linePatternRemoved[i] = true;
          removed.byPattern += 1;
        }
      }
    }
  }

  // Pass 3: 组装保留行
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    if (sectionRemoved[i] || linePatternRemoved[i]) continue;
    kept.push(lines[i]);
  }

  return { content: kept.join('\n'), removed };
}

// ============================================================================
// 主入口
// ============================================================================

function main() {
  const stateName = process.argv[2];
  if (!stateName || !STATES[stateName]) {
    console.error(`Usage: node apply-state.js <v0|v1|v2>`);
    console.error(`  Available states:`);
    for (const [name, state] of Object.entries(STATES)) {
      console.error(`    ${name}: ${state.description}`);
    }
    process.exit(1);
  }

  if (!fs.existsSync(ORIGINAL)) {
    console.error(`ERROR: Original snapshot not found at ${ORIGINAL}`);
    process.exit(1);
  }

  const state = STATES[stateName];
  const original = fs.readFileSync(ORIGINAL, 'utf-8');
  const { content, removed } = stripContent(original, state.strip);

  fs.writeFileSync(TARGET, content);

  const origLines = original.split('\n').length;
  const finalLines = content.split('\n').length;

  console.log(`✓ Applied state ${stateName}: ${state.description}`);
  console.log(`  Topics stripped: ${state.strip.length === 0 ? '(none)' : state.strip.join(', ')}`);
  console.log(`  Lines removed: ${removed.bySection} by section, ${removed.byPattern} by pattern`);
  console.log(`  Total lines: ${origLines} → ${finalLines} (${origLines - finalLines} removed)`);
  console.log(`  Target: ${TARGET}`);
}

main();
