import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import yaml from 'js-yaml';
import type { Sample } from '../types/index.js';
import type { DependencyRequirements } from '../eval-core/dependency-checker.js';

interface YamlErrorLike {
  mark?: { line: number };
  reason?: string;
  message?: string;
}

export function parseYaml(text: string): unknown {
  try {
    return yaml.load(text);
  } catch (err: unknown) {
    const yamlError = (typeof err === 'object' && err !== null ? err : {}) as YamlErrorLike;
    const line = yamlError.mark ? ` at line ${yamlError.mark.line + 1}` : '';
    throw new Error(`YAML parse error${line}: ${yamlError.reason || yamlError.message || 'unknown error'}`);
  }
}

export interface LoadSamplesResult {
  samples: Sample[];
  requires?: DependencyRequirements;
  /** Samples bundle 的根目录,后续相对路径(mock.return_file / custom assertion fn /
   *  test set hash 等)都该锚到这里:
   *  - 单文件模式(samplesPath 指 .json/.yaml):baseDir = 文件所在目录
   *  - 目录模式(samplesPath 指目录):baseDir = 目录自身
   *  之前下游代码用 dirname(samplesPath) 算 baseDir,目录模式下得到的是上层目录(<skill>/),
   *  导致 .omk/fixtures/*.json 这种自然布局找不到。 */
  baseDir: string;
  /** 当 baseDir 是目录模式(用户传的是目录而不是单文件),目录里参与合并的所有 sample 文件
   *  绝对路径列表(已按文件名排序)。computeTestSetHash 用它枚举,不再对目录 readFileSync 抛 EISDIR。
   *  单文件模式下是 [samplesPath]。 */
  sourceFiles: string[];
  /** sample_id → source file。Authoring 命令需要把目录模式下的修复写回原文件。 */
  sampleSourceById: Record<string, string>;
}

/**
 * Load samples from a single file OR a directory of sample files.
 *
 * File mode (.json / .yaml / .yml):
 * - Array: `[ { sample_id, prompt, ... } ]` (legacy)
 * - Object wrapper: `{ requires?: { tools, files, env }, samples: [...] }`
 *
 * Directory mode (e.g. `<skill>/.omk/`):
 * - Glob `*.{json,yaml,yml}` minus reserved prefixes (report*, health*, _*)
 * - Concat samples in deterministic name-sorted order
 * - Cross-file `sample_id` must be unique
 * - `requires` from each file unioned together
 */
export function loadSamples(samplesPath: string): LoadSamplesResult {
  const abs = resolve(samplesPath);
  if (statSync(abs).isDirectory()) {
    return loadSamplesFromDir(abs);
  }
  const inner = loadSampleFile(abs);
  return {
    ...inner,
    baseDir: dirname(abs),
    sourceFiles: [abs],
    sampleSourceById: Object.fromEntries(inner.samples.map((s) => [s.sample_id, abs])),
  };
}

/** Pull `.json/.yaml/.yml` siblings out of a directory, skipping omk's own report/health
 *  artifacts and any underscore-prefixed file (the convention for "not a sample").
 *  Exported so `omk sample --append` picks its target with the same sorted/filtered order
 *  that directory-mode loading merges by (deterministic, predictable). */
export function listSampleFilesInDir(dir: string): string[] {
  const RESERVED = /^(report|health|_)/i;
  return readdirSync(dir)
    .filter((f) => /\.(json|ya?ml)$/i.test(f))
    .filter((f) => !RESERVED.test(f))
    .sort();  // deterministic merge order
}

function loadSamplesFromDir(dir: string): LoadSamplesResult {
  const files = listSampleFilesInDir(dir);
  if (files.length === 0) {
    throw new Error(
      `no sample files found in directory: ${dir} ` +
      `(looking for *.json/*.yaml/*.yml, excluding report*/health*/_* names)`,
    );
  }

  const allSamples: Sample[] = [];
  const seenIds = new Map<string, string>();  // sample_id → first file that defined it
  let mergedRequires: DependencyRequirements | undefined;
  const sourceFiles: string[] = [];
  const sampleSourceById: Record<string, string> = {};

  for (const f of files) {
    const path = join(dir, f);
    sourceFiles.push(path);
    const single = loadSampleFile(path);
    for (const s of single.samples) {
      const prev = seenIds.get(s.sample_id);
      if (prev) {
        throw new Error(
          `duplicate sample_id "${s.sample_id}" in ${dir}: ` +
          `defined in both "${prev}" and "${f}"`,
        );
      }
      seenIds.set(s.sample_id, f);
      sampleSourceById[s.sample_id] = path;
    }
    allSamples.push(...single.samples);
    mergedRequires = mergeRequires(mergedRequires, single.requires);
  }
  return { samples: allSamples, requires: mergedRequires, baseDir: dir, sourceFiles, sampleSourceById };
}

/** Union of string arrays for tools/files/env/preflight; undef when both sides empty. */
function mergeRequires(
  a: DependencyRequirements | undefined,
  b: DependencyRequirements | undefined,
): DependencyRequirements | undefined {
  if (!a) return b;
  if (!b) return a;
  const u = (xs?: string[], ys?: string[]): string[] | undefined => {
    if (!xs && !ys) return undefined;
    return [...new Set([...(xs ?? []), ...(ys ?? [])])];
  };
  const out: DependencyRequirements = {};
  const tools = u(a.tools, b.tools);
  const files = u(a.files, b.files);
  const env = u(a.env, b.env);
  const preflight = u(a.preflight, b.preflight);
  if (tools) out.tools = tools;
  if (files) out.files = files;
  if (env) out.env = env;
  if (preflight) out.preflight = preflight;
  return out;
}

interface LoadSamplesInner { samples: Sample[]; requires?: DependencyRequirements }

export function validateSamples(samples: Sample[]): void {
  // sample design metadata enums (capability/difficulty/construct/provenance).
  // Pure documentation/diagnostic fields; do NOT participate in grading/judge/verdict.
  const VALID_DIFFICULTY: ReadonlySet<string> = new Set(['easy', 'medium', 'hard']);
  const VALID_PROVENANCE: ReadonlySet<string> = new Set(['human', 'llm-generated', 'production-trace']);

  for (const [i, sample] of samples.entries()) {
    if (!sample.sample_id || typeof sample.sample_id !== 'string') {
      throw new Error(`samples[${i}] missing or invalid required field: sample_id (must be a non-empty string)`);
    }
    if (!sample.prompt || typeof sample.prompt !== 'string') {
      throw new Error(`samples[${i}] (${sample.sample_id}) missing or invalid required field: prompt (must be a non-empty string)`);
    }

    // validate optional metadata enums; help users typo-check (`'easy?'` etc).
    if (sample.difficulty !== undefined && !VALID_DIFFICULTY.has(sample.difficulty)) {
      throw new Error(
        `samples[${i}] (${sample.sample_id}) invalid difficulty: ${JSON.stringify(sample.difficulty)}, expected one of [easy, medium, hard]`,
      );
    }
    if (sample.provenance !== undefined && !VALID_PROVENANCE.has(sample.provenance)) {
      throw new Error(
        `samples[${i}] (${sample.sample_id}) invalid provenance: ${JSON.stringify(sample.provenance)}, expected one of [human, llm-generated, production-trace]`,
      );
    }
    if (sample.capability !== undefined) {
      if (!Array.isArray(sample.capability)) {
        throw new Error(
          `samples[${i}] (${sample.sample_id}) invalid capability: must be a string array (got ${typeof sample.capability})`,
        );
      }
      for (const [j, cap] of sample.capability.entries()) {
        if (typeof cap !== 'string' || !cap) {
          throw new Error(
            `samples[${i}] (${sample.sample_id}) capability[${j}] must be a non-empty string`,
          );
        }
      }
    }
    if (sample.construct !== undefined && typeof sample.construct !== 'string') {
      throw new Error(
        `samples[${i}] (${sample.sample_id}) invalid construct: must be a string (got ${typeof sample.construct})`,
      );
    }

    // tools_called / tools_not_called: values 必须非空。空 values 在 grader 里
    // 永远 passed=true 但 weight=0,是无意义占位,污染断言计数(N/M 看上去比真实
    // 通过率高)+ 让 generator 输出可观测的 garbage 沉淀到磁盘。直接拒掉,作者
    // 应改成具体字串名或删除这条断言。
    const assertions = Array.isArray(sample.assertions) ? sample.assertions : [];
    const TOOL_COLON_TYPES = new Set([
      'tool_input_contains', 'tool_input_not_contains', 'tool_output_contains', 'mock_hit',
    ]);
    // Rule A (loader-side mirror of sanitizeGeneratedSamples rule A): text-class
    // assertion values must not contain CJK / fullwidth punctuation / internal
    // whitespace, and length ∈ [2, 40]. Loader has no SKILL.md context here so
    // rule B (tool-name-must-exist-in-SKILL.md) is left to generator boundary.
    // Lenient escape hatch: OMK_LENIENT_ASSERTIONS=1 downgrades these violations
    // to stderr warnings for legacy sample files.
    const TEXT_VALUE_TYPES_LOADER = new Set([
      'contains', 'not_contains', 'contains_all', 'contains_any', 'equals', 'not_equals',
    ]);
    const LOADER_CJK = /[　-〿一-鿿㐀-䶿＀-￯]/;
    const isLenient = process.env.OMK_LENIENT_ASSERTIONS === '1';
    const checkAsciiTokenValue = (label: string, raw: unknown): string | null => {
      if (typeof raw !== 'string') return `${label} value 必须是字符串 (实际类型 ${typeof raw})`;
      const s = raw.trim();
      if (s.length < 2 || s.length > 40) return `${label} value 长度必须在 [2,40] 之间 (实际 ${s.length}): ${JSON.stringify(raw)}`;
      if (LOADER_CJK.test(s)) return `${label} value 含 CJK 字符或全角标点 — 文本字面匹配在 LLM 输出上不稳,应改用 sample.rubric → judge 评分: ${JSON.stringify(raw)}`;
      if (/\s/.test(s)) return `${label} value 含内部空白(短语),应只测单个 ASCII token,语义匹配走 rubric: ${JSON.stringify(raw)}`;
      return null;
    };
    const emitViolation = (msg: string): void => {
      if (isLenient) {
        process.stderr.write(`[omk loadSamples] ⚠ lenient mode: ${msg}\n`);
      } else {
        throw new Error(msg + '\n  (设 OMK_LENIENT_ASSERTIONS=1 改为 warning 给历史 sample 留迁移逃生口)');
      }
    };
    for (const [j, a] of assertions.entries()) {
      if (a?.type === 'tools_called' || a?.type === 'tools_not_called') {
        const vals = Array.isArray(a.values) ? a.values : [];
        if (vals.length === 0 || !vals.every((v) => typeof v === 'string' && v.length > 0)) {
          throw new Error(
            `samples[${i}] (${sample.sample_id}) assertions[${j}] ${a.type}: values 必须是非空字符串数组 — ` +
            `写出要检查的具体工具名(如 ["Bash", "Read"]),或删除这条断言`,
          );
        }
      }
      // tool_input_contains / tool_input_not_contains / tool_output_contains / mock_hit:
      // value 必须是 "Tool:needle" 格式(冒号分隔,左半工具名非空,右半子串非空)。
      // generator 偶发产 "--force" / "lastTaskPatrol" 这种裸 needle —
      // grader 拿不到工具上下文,_contains 会默默 false、_not_contains 现已 trivially
      // true,无论哪头都不是作者真实意图。loader 直接拒,逼作者写完整。
      if (TOOL_COLON_TYPES.has(a?.type)) {
        const v = a.value;
        if (typeof v !== 'string' || v.length === 0) {
          throw new Error(
            `samples[${i}] (${sample.sample_id}) assertions[${j}] ${a.type}: value 必须是非空字符串`,
          );
        }
        const sep = v.indexOf(':');
        if (sep <= 0 || sep === v.length - 1) {
          throw new Error(
            `samples[${i}] (${sample.sample_id}) assertions[${j}] ${a.type}: value 必须是 "Tool:needle" 格式 ` +
            `(冒号分隔工具名和子串,两侧均非空),实际: ${JSON.stringify(v)}`,
          );
        }
      }

      // Rule A: text-class assertion value content guard.
      const label = `samples[${i}] (${sample.sample_id}) assertions[${j}] ${a?.type}`;
      if (TEXT_VALUE_TYPES_LOADER.has(a?.type)) {
        const items: unknown[] = Array.isArray(a.values) ? a.values
          : a.value !== undefined ? [a.value]
          : [];
        if (items.length === 0) {
          emitViolation(`${label}: value/values 不能为空`);
          continue;
        }
        for (const item of items) {
          const err = checkAsciiTokenValue(label, item);
          if (err) {
            emitViolation(err);
            break;
          }
        }
      } else if (a?.type === 'regex' && typeof a.pattern === 'string' && LOADER_CJK.test(a.pattern)) {
        emitViolation(`${label}: regex pattern 含 CJK 字符 — 同样的语义匹配应走 rubric → judge,而不是字面正则: ${JSON.stringify(a.pattern)}`);
      }
    }
  }
}

function loadSampleFile(samplesPath: string): LoadSamplesInner {
  const rawContent = readFileSync(samplesPath, 'utf-8');
  const isYaml = samplesPath.endsWith('.yaml') || samplesPath.endsWith('.yml');
  const parsed: unknown = isYaml ? parseYaml(rawContent) : JSON.parse(rawContent);

  let samples: Sample[];
  let requires: DependencyRequirements | undefined;

  if (Array.isArray(parsed)) {
    // Legacy array format
    samples = parsed as Sample[];
  } else if (typeof parsed === 'object' && parsed !== null && 'samples' in parsed) {
    // Object wrapper format
    const wrapper = parsed as { samples: Sample[]; requires?: DependencyRequirements };
    samples = wrapper.samples;
    requires = wrapper.requires;
  } else {
    throw new Error(`invalid samples file shape: ${samplesPath} (expected an array or an object with a 'samples' field)`);
  }

  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error(`invalid samples file: ${samplesPath}`);
  }

  validateSamples(samples);

  return { samples, requires };
}
