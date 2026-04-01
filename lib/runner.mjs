import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createExecutor, DEFAULT_MODEL, JUDGE_MODEL } from './executor.mjs';
import { grade } from './grader.mjs';
import { parseYaml } from './yaml-parser.mjs';
import { analyzeResults } from './analyzer.mjs';
import { confidenceInterval, tTest } from './statistics.mjs';
import { buildVariantResult, buildVariantSummary } from './schema.mjs';
import { resolveUrls } from './url-fetcher.mjs';
import { loadMcpConfig, resolveMcpUrls, stopAllServers } from './mcp-resolver.mjs';
import { createCache, cacheKey } from './cache.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

function hashString(str) {
  return createHash('sha256').update(str).digest('hex').slice(0, 12);
}

const DEFAULT_OUTPUT_DIR = join(homedir(), '.oh-my-knowledge', 'reports');

function gitShowFile(ref, filePath) {
  try {
    return execFileSync('git', ['show', `${ref}:${filePath}`], { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

function getGitRelativePath(absolutePath) {
  const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim();
  return relative(gitRoot, absolutePath);
}

function getGitInfo() {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf-8' }).trim().length > 0;
    return { commit, commitShort: commit.slice(0, 7), branch, dirty };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Phase 1: Load samples
// ---------------------------------------------------------------------------

export function loadSamples(samplesPath) {
  const rawContent = readFileSync(resolve(samplesPath), 'utf-8');
  const samples = samplesPath.endsWith('.yaml') || samplesPath.endsWith('.yml')
    ? parseYaml(rawContent)
    : JSON.parse(rawContent);
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error(`invalid samples file: ${samplesPath}`);
  }
  for (const [i, s] of samples.entries()) {
    if (!s.sample_id) throw new Error(`samples[${i}] missing required field: sample_id`);
    if (!s.prompt) throw new Error(`samples[${i}] (${s.sample_id}) missing required field: prompt`);
  }
  return samples;
}

// ---------------------------------------------------------------------------
// Phase 2a: Discover variants from skill directory
// ---------------------------------------------------------------------------

export function discoverVariants(skillDir) {
  if (!existsSync(skillDir)) return [];
  const entries = readdirSync(skillDir);
  const variants = [];
  for (const entry of entries) {
    if (entry.endsWith('.md')) {
      variants.push(entry.slice(0, -3));
    } else {
      const skillMd = join(skillDir, entry, 'SKILL.md');
      if (statSync(join(skillDir, entry)).isDirectory() && existsSync(skillMd)) {
        variants.push(entry);
      }
    }
  }
  variants.sort();
  if (variants.length === 1) {
    variants.unshift('baseline');
  }
  return variants;
}

// ---------------------------------------------------------------------------
// Phase 2a-2: Discover independent skills with paired eval-samples (--each mode)
// ---------------------------------------------------------------------------

export function discoverEachSkills(skillDir) {
  if (!existsSync(skillDir)) return [];
  const entries = readdirSync(skillDir);
  const skills = [];
  const warned = [];

  for (const entry of entries) {
    const mdMatch = entry.endsWith('.md') && !entry.endsWith('.eval-samples.json');
    if (mdMatch) {
      const name = entry.slice(0, -3);
      const samplesPath = join(skillDir, `${name}.eval-samples.json`);
      if (existsSync(samplesPath)) {
        skills.push({ name, skillPath: join(skillDir, entry), samplesPath });
      } else {
        warned.push(name);
      }
    } else if (statSync(join(skillDir, entry)).isDirectory()) {
      const skillMd = join(skillDir, entry, 'SKILL.md');
      const samplesPath = join(skillDir, entry, 'eval-samples.json');
      if (existsSync(skillMd) && existsSync(samplesPath)) {
        skills.push({ name: entry, skillPath: skillMd, samplesPath });
      } else if (existsSync(skillMd)) {
        warned.push(entry);
      }
    }
  }

  for (const name of warned) {
    process.stderr.write(`⚠️  跳过 ${name}：未找到配对的 eval-samples\n`);
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

// ---------------------------------------------------------------------------
// Phase 2b: Load skills
// ---------------------------------------------------------------------------

export function loadSkills(skillDir, variants) {
  const skills = {};
  let gitRelDir = null;

  for (const v of variants) {
    if (v === 'baseline') {
      skills[v] = null;
      continue;
    }

    if (v.startsWith('git:')) {
      const parts = v.slice(4).split(':');
      let ref, name;
      if (parts.length === 1) {
        ref = 'HEAD';
        name = parts[0];
      } else {
        ref = parts[0];
        name = parts.slice(1).join(':');
      }
      if (!gitRelDir) gitRelDir = getGitRelativePath(skillDir);
      const content = gitShowFile(ref, join(gitRelDir, name + '.md'))
                   || gitShowFile(ref, join(gitRelDir, name, 'SKILL.md'));
      if (!content) {
        throw new Error(`skill not found in git ${ref}: ${name}.md or ${name}/SKILL.md`);
      }
      skills[v] = content;
      continue;
    }

    if (v.includes('/')) {
      const filePath = resolve(v);
      if (!existsSync(filePath)) {
        throw new Error(`skill file not found: ${filePath}`);
      }
      skills[v] = readFileSync(filePath, 'utf-8').trim();
      continue;
    }

    const mdPath = join(skillDir, v + '.md');
    const dirSkillPath = join(skillDir, v, 'SKILL.md');
    if (existsSync(mdPath)) {
      skills[v] = readFileSync(mdPath, 'utf-8').trim();
    } else if (existsSync(dirSkillPath)) {
      skills[v] = readFileSync(dirSkillPath, 'utf-8').trim();
    } else {
      throw new Error(`skill not found: ${mdPath} or ${dirSkillPath}`);
    }
  }

  return skills;
}

// ---------------------------------------------------------------------------
// Phase 3: Build tasks
// ---------------------------------------------------------------------------

export function buildTasks(samples, variants, skills) {
  const tasks = [];
  for (const sample of samples) {
    for (const variant of variants) {
      const userPrompt = sample.context
        ? `${sample.prompt}\n\n\`\`\`\n${sample.context}\n\`\`\``
        : sample.prompt;
      tasks.push({
        sample_id: sample.sample_id,
        variant,
        prompt: userPrompt,
        rubric: sample.rubric || null,
        assertions: sample.assertions || null,
        dimensions: sample.dimensions || null,
        skillContent: skills[variant] || null,
        cwd: sample.cwd || null,
        _sample: sample,
      });
    }
  }
  return tasks;
}

// ---------------------------------------------------------------------------
// Phase 4: Execute tasks
// ---------------------------------------------------------------------------

async function executeTasks({ tasks, executor, judgeExecutor, model, judgeModel, noJudge, samplesPath, concurrency, timeoutMs, noCache, onProgress }) {
  const results = {};
  let started = 0;
  let completed = 0;
  let totalCostUSD = 0;

  const cacheDir = join(homedir(), '.oh-my-knowledge', 'cache');
  const cache = noCache ? null : createCache(cacheDir);

  async function executeTask(task) {
    started++;
    if (onProgress) {
      onProgress({ phase: 'start', completed: started, total: tasks.length, sample_id: task.sample_id, variant: task.variant });
    }

    // Check cache
    let execResult;
    const key = cacheKey(model, task.skillContent, task.prompt);
    const cached = cache?.get(key);
    if (cached) {
      execResult = { ...cached, cached: true };
    } else {
      execResult = await executor({ model, system: task.skillContent, prompt: task.prompt, cwd: task.cwd, timeoutMs });
      if (cache && execResult.ok) cache.set(key, execResult);
    }
    totalCostUSD += execResult.costUSD;

    let gradeResult = null;
    if (execResult.ok && !noJudge) {
      const hasGradingCriteria = task.rubric || task.assertions?.length || (task.dimensions && Object.keys(task.dimensions).length);
      if (hasGradingCriteria) {
        gradeResult = await grade({
          output: execResult.output,
          sample: task._sample,
          executor: judgeExecutor,
          judgeModel,
          execMetrics: { costUSD: execResult.costUSD, durationMs: execResult.durationMs, numTurns: execResult.numTurns },
          samplesDir: dirname(resolve(samplesPath)),
        });
        if (gradeResult.judgeCostUSD) totalCostUSD += gradeResult.judgeCostUSD;
      }
    }

    completed++;
    if (onProgress) {
      onProgress({
        phase: 'done', completed, total: tasks.length,
        sample_id: task.sample_id, variant: task.variant,
        durationMs: execResult.durationMs, inputTokens: execResult.inputTokens,
        outputTokens: execResult.outputTokens, costUSD: execResult.costUSD,
        score: gradeResult?.compositeScore,
      });
    }

    if (!results[task.sample_id]) results[task.sample_id] = {};
    results[task.sample_id][task.variant] = buildVariantResult(execResult, gradeResult);
  }

  await runWithConcurrency(tasks, concurrency, executeTask);

  if (cache) cache.save();

  return { results, totalCostUSD };
}

// ---------------------------------------------------------------------------
// Phase 5: Aggregate report
// ---------------------------------------------------------------------------

function aggregateReport({ runId, variants, model, judgeModel, noJudge, executorName, samples, tasks, results, totalCostUSD, skills }) {
  const summary = {};
  for (const variant of variants) {
    const entries = Object.values(results).map((r) => r[variant]).filter(Boolean);
    summary[variant] = buildVariantSummary(entries);
  }

  return {
    id: runId,
    meta: {
      variants,
      model,
      judgeModel: noJudge ? null : judgeModel,
      executor: executorName,
      sampleCount: samples.length,
      taskCount: tasks.length,
      totalCostUSD: Number(totalCostUSD.toFixed(6)),
      timestamp: new Date().toISOString(),
      cliVersion: PKG.version,
      nodeVersion: process.version,
      skillHashes: Object.fromEntries(
        Object.entries(skills).map(([name, content]) => [name, content ? hashString(content) : 'no-skill']),
      ),
      gitInfo: getGitInfo(),
    },
    summary,
    results: Object.entries(results).map(([sample_id, variantData]) => ({
      sample_id,
      variants: variantData,
    })),
  };
}

// ---------------------------------------------------------------------------
// Phase 6: Blind relabeling
// ---------------------------------------------------------------------------

function applyBlindMode(report, variants, blindSeed) {
  const labels = variants.map((_, i) => String.fromCharCode(65 + i));
  // Seed from deterministic input (variants + user-provided seed or samplesPath)
  // so same experiment setup always produces the same blind mapping
  let s = parseInt(hashString(blindSeed).slice(0, 8), 16) | 0;
  const seededRandom = () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const shuffled = [...variants];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(seededRandom() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const blindMap = Object.fromEntries(shuffled.map((v, i) => [labels[i], v]));
  const reverseMap = Object.fromEntries(Object.entries(blindMap).map(([label, v]) => [v, label]));

  report.meta.blind = true;
  report.meta.blindMap = blindMap;
  report.meta.variants = labels;

  const newSummary = {};
  for (const [v, stats] of Object.entries(report.summary)) {
    newSummary[reverseMap[v]] = stats;
  }
  report.summary = newSummary;

  for (const r of report.results) {
    const newVariants = {};
    for (const [v, data] of Object.entries(r.variants)) {
      newVariants[reverseMap[v]] = data;
    }
    r.variants = newVariants;
  }
}

// ---------------------------------------------------------------------------
// Phase 7: Persist
// ---------------------------------------------------------------------------

function persistReport(report, outputDir) {
  if (!outputDir) return null;
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  const filePath = join(outputDir, `${report.id}.json`);
  writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

function generateRunId(variants) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}`;
  const vs = variants.join('-vs-');
  return `${vs}-${date}-${time}`;
}

async function preflight(executor, model, timeoutMs = 15000) {
  const result = await executor({
    model, system: '', prompt: 'hi', cwd: process.cwd(), timeoutMs,
  });
  if (!result.ok) {
    throw new Error(`预检失败 [${model}]: ${result.error}`);
  }
}

export async function runEvaluation({
  samplesPath,
  skillDir,
  variants = ['v1', 'v2'],
  model = DEFAULT_MODEL,
  judgeModel = JUDGE_MODEL,
  outputDir = DEFAULT_OUTPUT_DIR,
  noJudge = false,
  dryRun = false,
  blind = false,
  concurrency = 1,
  timeoutMs,
  noCache = false,
  executorName = 'claude',
  judgeExecutorName,
  onProgress = null,
  skipPreflight = false,
  mcpConfig,
}) {
  // 1. Load
  const samples = loadSamples(samplesPath);
  const skills = dryRun ? {} : loadSkills(resolve(skillDir), variants);

  // 2. Resolve URLs in prompts/contexts
  if (!dryRun) {
    const mcpServers = loadMcpConfig(mcpConfig);
    if (mcpServers) {
      await resolveMcpUrls(samples, mcpServers);
    }
    await resolveUrls(samples);
  }

  // 3. Build tasks
  if (variants.length === 0) {
    throw new Error(
      `未发现任何 skill 变体。请检查：\n` +
      `  1. skill 目录是否存在：${resolve(skillDir)}\n` +
      `  2. 目录下是否有 .md 文件或含 SKILL.md 的子目录\n` +
      `  3. 或通过 --variants 显式指定变体`
    );
  }
  const tasks = buildTasks(samples, variants, skills);

  // 4. Dry-run early return
  if (dryRun) {
    return {
      report: {
        dryRun: true,
        model,
        judgeModel,
        variants,
        executor: executorName,
        samplesPath,
        skillDir,
        totalTasks: tasks.length,
        tasks: tasks.map((t) => ({
          sample_id: t.sample_id,
          variant: t.variant,
          promptPreview: t.prompt.slice(0, 100),
          hasRubric: Boolean(t.rubric),
          hasAssertions: Boolean(t.assertions?.length),
          hasDimensions: Boolean(t.dimensions && Object.keys(t.dimensions).length),
          hasSystem: Boolean(t.skillContent),
        })),
      },
      filePath: null,
    };
  }

  // 4. Preflight check
  const executor = createExecutor(executorName);
  const judgeExecutor = createExecutor(judgeExecutorName || executorName);
  if (!skipPreflight) {
    if (onProgress) onProgress({ phase: 'preflight' });
    await preflight(executor, model);
    if (!noJudge) await preflight(judgeExecutor, judgeModel);
  }

  // 5. Execute
  const { results, totalCostUSD } = await executeTasks({
    tasks, executor, judgeExecutor, model, judgeModel, noJudge, samplesPath, concurrency, timeoutMs, noCache, onProgress,
  });

  // 6. Aggregate
  const runId = generateRunId(variants);
  const report = aggregateReport({ runId, variants, model, judgeModel, noJudge, executorName, samples, tasks, results, totalCostUSD, skills });

  // 7. Analysis
  report.analysis = analyzeResults(report);

  // 8. Blind
  // Blind seed is deterministic: same variants + same samples = same mapping
  if (blind) applyBlindMode(report, variants, variants.join(',') + ':' + samplesPath);

  // 9. Cleanup MCP connections
  await stopAllServers();

  // 10. Persist
  const filePath = persistReport(report, outputDir);

  return { report, filePath };
}

// ---------------------------------------------------------------------------
// --each orchestrator
// ---------------------------------------------------------------------------

export async function runEachEvaluation({
  skillDir,
  model = DEFAULT_MODEL,
  judgeModel = JUDGE_MODEL,
  outputDir = DEFAULT_OUTPUT_DIR,
  noJudge = false,
  dryRun = false,
  concurrency = 1,
  timeoutMs,
  executorName = 'claude',
  judgeExecutorName,
  onProgress = null,
  onSkillProgress = null,
  skipPreflight = false,
  mcpConfig,
}) {
  const skillEntries = discoverEachSkills(resolve(skillDir));
  if (skillEntries.length === 0) {
    throw new Error('No skills with paired eval-samples found in: ' + skillDir);
  }

  if (dryRun) {
    const drySkills = [];
    for (const entry of skillEntries) {
      const samples = loadSamples(entry.samplesPath);
      drySkills.push({
        name: entry.name,
        samplesPath: entry.samplesPath,
        sampleCount: samples.length,
        taskCount: samples.length * 2, // baseline + skill
      });
    }
    return {
      report: {
        dryRun: true,
        each: true,
        model,
        judgeModel,
        executor: executorName,
        skillDir,
        totalSkills: drySkills.length,
        totalTasks: drySkills.reduce((s, sk) => s + sk.taskCount, 0),
        skills: drySkills,
      },
      filePath: null,
    };
  }

  const skillResults = [];
  let totalCostUSD = 0;

  for (let i = 0; i < skillEntries.length; i++) {
    const entry = skillEntries[i];
    if (onSkillProgress) {
      onSkillProgress({ phase: 'start', skill: entry.name, current: i + 1, total: skillEntries.length });
    }

    const { report } = await runEvaluation({
      samplesPath: entry.samplesPath,
      skillDir,
      variants: ['baseline', entry.skillPath],
      model,
      judgeModel,
      outputDir: null, // don't persist individual reports
      noJudge,
      concurrency,
      timeoutMs,
      executorName,
      judgeExecutorName,
      onProgress,
      skipPreflight: skipPreflight || i > 0, // 只在第一个 skill 时预检
      mcpConfig,
    });

    // Remap variant key from file path to skill name
    const variantKey = entry.skillPath;
    const skillSummary = report.summary[variantKey] || {};
    const skillHash = report.meta?.skillHashes?.[variantKey] || '';

    skillResults.push({
      name: entry.name,
      skillHash,
      samplesPath: entry.samplesPath,
      sampleCount: report.meta.sampleCount,
      summary: {
        baseline: report.summary.baseline || {},
        skill: skillSummary,
      },
      results: report.results.map((r) => ({
        sample_id: r.sample_id,
        variants: {
          baseline: r.variants.baseline || r.variants['baseline'],
          skill: r.variants[variantKey],
        },
      })),
    });

    totalCostUSD += report.meta.totalCostUSD;

    if (onSkillProgress) {
      onSkillProgress({ phase: 'done', skill: entry.name, current: i + 1, total: skillEntries.length });
    }
  }

  // Build overview
  const overview = {
    totalSkills: skillResults.length,
    totalSamples: skillResults.reduce((s, sk) => s + sk.sampleCount, 0),
    totalCostUSD: Number(totalCostUSD.toFixed(6)),
    skills: skillResults.map((sk) => {
      const bs = sk.summary.baseline?.avgCompositeScore ?? sk.summary.baseline?.avgLlmScore ?? null;
      const ss = sk.summary.skill?.avgCompositeScore ?? sk.summary.skill?.avgLlmScore ?? null;
      let improvement = null;
      if (typeof bs === 'number' && typeof ss === 'number' && bs > 0) {
        improvement = `${((ss - bs) / bs * 100).toFixed(0)}%`;
        if (ss >= bs) improvement = '+' + improvement;
      }
      return { name: sk.name, baselineScore: bs, skillScore: ss, improvement };
    }),
  };

  // Build combined report
  const runId = generateRunId(['each']);
  const combinedReport = {
    id: runId,
    each: true,
    meta: {
      model,
      judgeModel: noJudge ? null : judgeModel,
      executor: executorName,
      totalCostUSD: Number(totalCostUSD.toFixed(6)),
      timestamp: new Date().toISOString(),
      cliVersion: PKG.version,
      nodeVersion: process.version,
    },
    overview,
    skills: skillResults,
  };

  const filePath = persistReport(combinedReport, outputDir);
  return { report: combinedReport, filePath };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

async function runWithConcurrency(tasks, concurrency, fn) {
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      await fn(tasks[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
}

export async function runMultiple({ repeat = 1, onRepeatProgress, ...config }) {
  const runs = [];
  for (let i = 0; i < repeat; i++) {
    if (onRepeatProgress) onRepeatProgress({ run: i + 1, total: repeat });
    const { report } = await runEvaluation(config);
    runs.push(report);
  }

  if (runs.length === 1) {
    return { report: runs[0], aggregated: null, filePath: null };
  }

  const variants = runs[0].meta?.variants || [];
  const perVariant = {};
  for (const v of variants) {
    const scores = runs.map((r) => r.summary?.[v]?.avgCompositeScore).filter((s) => typeof s === 'number');
    perVariant[v] = { scores, ...confidenceInterval(scores) };
  }

  const comparisons = [];
  for (let i = 0; i < variants.length; i++) {
    for (let j = i + 1; j < variants.length; j++) {
      comparisons.push({
        a: variants[i],
        b: variants[j],
        ...tTest(perVariant[variants[i]].scores, perVariant[variants[j]].scores),
      });
    }
  }

  const report = runs[runs.length - 1];
  report.variance = { runs: repeat, perVariant, comparisons };

  return { report, aggregated: report.variance, filePath: null };
}
