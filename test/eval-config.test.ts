import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEvalConfig, configVariantsToSpecs } from '../src/inputs/eval-config.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'omk-eval-config-'));
}

function writeYaml(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe('loadEvalConfig', () => {
  it('parses a valid yaml config with control + treatment variants', () => {
    const dir = makeTmpDir();
    try {
      const path = writeYaml(dir, 'eval.yaml', `
samples: ./samples.json
executor: claude-sdk
model: sonnet
variants:
  - name: v1
    role: control
    artifact: ./v1.md
  - name: v2
    role: treatment
    artifact: ./v2.md
  - name: v3
    role: treatment
    artifact: git:my-skill
    cwd: ./project
      `.trim());

      const config = loadEvalConfig(path);

      assert.equal(config.executor, 'claude-sdk');
      assert.equal(config.model, 'sonnet');
      assert.equal(config.variants.length, 3);
      assert.equal(config.variants[0].name, 'v1');
      assert.equal(config.variants[0].role, 'control');
      // samples path resolved relative to config directory
      assert.equal(config.samples, join(dir, 'samples.json'));
      // ./v1.md resolved against config dir
      assert.equal(config.variants[0].artifact, join(dir, 'v1.md'));
      // git: prefix kept as-is
      assert.equal(config.variants[2].artifact, 'git:my-skill');
      // cwd resolved against config dir
      assert.equal(config.variants[2].cwd, join(dir, 'project'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when samples field missing', () => {
    const dir = makeTmpDir();
    try {
      const path = writeYaml(dir, 'eval.yaml', `
variants:
  - name: v1
    role: control
    artifact: baseline
      `.trim());
      assert.throws(() => loadEvalConfig(path), /'samples' is required/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when variants array is empty', () => {
    const dir = makeTmpDir();
    try {
      const path = writeYaml(dir, 'eval.yaml', `
samples: ./samples.json
variants: []
      `.trim());
      assert.throws(() => loadEvalConfig(path), /'variants' is required/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when variant role is invalid', () => {
    const dir = makeTmpDir();
    try {
      const path = writeYaml(dir, 'eval.yaml', `
samples: ./samples.json
variants:
  - name: v1
    role: baseline
    artifact: ./v1.md
      `.trim());
      assert.throws(() => loadEvalConfig(path), /role must be 'control' or 'treatment'/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when variant names are duplicated', () => {
    const dir = makeTmpDir();
    try {
      const path = writeYaml(dir, 'eval.yaml', `
samples: ./samples.json
variants:
  - name: v1
    role: control
    artifact: baseline
  - name: v1
    role: treatment
    artifact: ./v1.md
      `.trim());
      assert.throws(() => loadEvalConfig(path), /"v1" is duplicated/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when --config file does not exist', () => {
    assert.throws(
      () => loadEvalConfig('/tmp/omk-nonexistent-config-xyz.yaml'),
      /--config file does not exist/,
    );
  });

  it('parses a .json config with the same schema as yaml', () => {
    const dir = makeTmpDir();
    try {
      const path = writeYaml(dir, 'eval.json', JSON.stringify({
        samples: './samples.json',
        executor: 'claude-sdk',
        model: 'sonnet',
        variants: [
          { name: 'v1', role: 'control', artifact: 'baseline' },
          { name: 'v2', role: 'treatment', artifact: './v2.md', cwd: './project' },
        ],
      }, null, 2));
      const config = loadEvalConfig(path);
      assert.equal(config.executor, 'claude-sdk');
      assert.equal(config.variants.length, 2);
      assert.equal(config.variants[0].artifact, 'baseline');
      assert.equal(config.variants[1].artifact, join(dir, 'v2.md'));
      assert.equal(config.variants[1].cwd, join(dir, 'project'));
      assert.equal(config.samples, join(dir, 'samples.json'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts baseline and git: artifact exprs without resolving as paths', () => {
    const dir = makeTmpDir();
    try {
      const path = writeYaml(dir, 'eval.yaml', `
samples: ./samples.json
variants:
  - name: bare
    role: control
    artifact: baseline
  - name: pinned
    role: treatment
    artifact: git:HEAD:my-skill
      `.trim());
      const config = loadEvalConfig(path);
      assert.equal(config.variants[0].artifact, 'baseline');
      assert.equal(config.variants[1].artifact, 'git:HEAD:my-skill');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('configVariantsToSpecs', () => {
  it('merges cwd into expr as name@cwd', () => {
    const specs = configVariantsToSpecs([
      { name: 'v1', role: 'control', artifact: 'baseline' },
      { name: 'v2', role: 'treatment', artifact: './skill.md', cwd: '/tmp/project' },
    ]);
    assert.deepEqual(specs, [
      { name: 'v1', role: 'control', expr: 'baseline' },
      { name: 'v2', role: 'treatment', expr: './skill.md@/tmp/project' },
    ]);
  });

  it('leaves expr untouched when cwd is absent', () => {
    const specs = configVariantsToSpecs([
      { name: 'git', role: 'treatment', artifact: 'git:my-skill' },
    ]);
    assert.equal(specs[0].expr, 'git:my-skill');
  });
});

describe('loadEvalConfig — budget', () => {
  const minimalVariants = `
variants:
  - name: v1
    role: control
    artifact: ./v1.md
`;

  it('parses budget block with all three caps', () => {
    const dir = makeTmpDir();
    try {
      const path = writeYaml(dir, 'eval.yaml', `
samples: ./s.json
${minimalVariants}
budget:
  totalUSD: 5
  perSampleUSD: 0.5
  perSampleMs: 30000
`.trim());
      const cfg = loadEvalConfig(path);
      assert.equal(cfg.budget?.totalUSD, 5);
      assert.equal(cfg.budget?.perSampleUSD, 0.5);
      assert.equal(cfg.budget?.perSampleMs, 30000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('absent budget block stays undefined', () => {
    const dir = makeTmpDir();
    try {
      const path = writeYaml(dir, 'eval.yaml', `samples: ./s.json\n${minimalVariants}`);
      const cfg = loadEvalConfig(path);
      assert.equal(cfg.budget, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects negative budget values', () => {
    const dir = makeTmpDir();
    try {
      const path = writeYaml(dir, 'eval.yaml', `
samples: ./s.json
${minimalVariants}
budget:
  totalUSD: -1
`.trim());
      assert.throws(() => loadEvalConfig(path), /totalUSD/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects non-numeric budget values', () => {
    const dir = makeTmpDir();
    try {
      const path = writeYaml(dir, 'eval.yaml', `
samples: ./s.json
${minimalVariants}
budget:
  totalUSD: "five"
`.trim());
      assert.throws(() => loadEvalConfig(path), /totalUSD/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects non-object budget value', () => {
    const dir = makeTmpDir();
    try {
      const path = writeYaml(dir, 'eval.yaml', `
samples: ./s.json
${minimalVariants}
budget: 5
`.trim());
      assert.throws(() => loadEvalConfig(path), /budget must be an object/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('partial budget (only totalUSD) parses cleanly', () => {
    const dir = makeTmpDir();
    try {
      const path = writeYaml(dir, 'eval.yaml', `
samples: ./s.json
${minimalVariants}
budget:
  totalUSD: 1.5
`.trim());
      const cfg = loadEvalConfig(path);
      assert.equal(cfg.budget?.totalUSD, 1.5);
      assert.equal(cfg.budget?.perSampleUSD, undefined);
      assert.equal(cfg.budget?.perSampleMs, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('loadEvalConfig — experiment-design fields (v0.2)', () => {
  const minimalVariants = `
variants:
  - name: v1
    role: control
    artifact: ./v1.md
`;

  it('解析完整 v0.2 字段', () => {
    const dir = makeTmpDir();
    try {
      const path = writeYaml(dir, 'eval.yaml', `
samples: ./s.json
${minimalVariants}
repeat: 5
judgeRepeat: 3
bootstrap: true
bootstrapSamples: 2000
goldDir: ./gold
lengthDebias: false
strictBaseline: false
noJudge: true
judgeModels:
  - executor: claude
    model: opus
  - executor: openai-api
    model: gpt-4o
`.trim());
      const cfg = loadEvalConfig(path);
      assert.equal(cfg.repeat, 5);
      assert.equal(cfg.judgeRepeat, 3);
      assert.equal(cfg.bootstrap, true);
      assert.equal(cfg.bootstrapSamples, 2000);
      assert.equal(cfg.goldDir, join(dir, 'gold'));  // 相对路径解析为绝对
      assert.equal(cfg.lengthDebias, false);
      assert.equal(cfg.strictBaseline, false);
      assert.equal(cfg.noJudge, true);
      assert.deepEqual(cfg.judgeModels, [
        { executor: 'claude', model: 'opus' },
        { executor: 'openai-api', model: 'gpt-4o' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('absent v0.2 字段全部 undefined', () => {
    const dir = makeTmpDir();
    try {
      const path = writeYaml(dir, 'eval.yaml', `samples: ./s.json\n${minimalVariants}`);
      const cfg = loadEvalConfig(path);
      assert.equal(cfg.repeat, undefined);
      assert.equal(cfg.judgeRepeat, undefined);
      assert.equal(cfg.bootstrap, undefined);
      assert.equal(cfg.bootstrapSamples, undefined);
      assert.equal(cfg.goldDir, undefined);
      assert.equal(cfg.lengthDebias, undefined);
      assert.equal(cfg.strictBaseline, undefined);
      assert.equal(cfg.noJudge, undefined);
      assert.equal(cfg.judgeModels, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reject repeat 非整数', () => {
    const dir = makeTmpDir();
    try {
      const path = writeYaml(dir, 'eval.yaml', `samples: ./s.json\n${minimalVariants}\nrepeat: 1.5`);
      assert.throws(() => loadEvalConfig(path), /repeat must be a positive integer/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reject repeat ≤ 0', () => {
    const dir = makeTmpDir();
    try {
      const path = writeYaml(dir, 'eval.yaml', `samples: ./s.json\n${minimalVariants}\nrepeat: 0`);
      assert.throws(() => loadEvalConfig(path), /repeat must be a positive integer/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reject bootstrapSamples < 100', () => {
    const dir = makeTmpDir();
    try {
      const path = writeYaml(dir, 'eval.yaml', `samples: ./s.json\n${minimalVariants}\nbootstrapSamples: 50`);
      assert.throws(() => loadEvalConfig(path), /bootstrapSamples must be a number ≥ 100/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reject judgeModels 非数组', () => {
    const dir = makeTmpDir();
    try {
      const path = writeYaml(dir, 'eval.yaml', `samples: ./s.json\n${minimalVariants}\njudgeModels: "claude:opus"`);
      assert.throws(() => loadEvalConfig(path), /judgeModels must be an array/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reject judgeModels[i] 缺 executor 或 model', () => {
    const dir = makeTmpDir();
    try {
      const path = writeYaml(dir, 'eval.yaml', `samples: ./s.json\n${minimalVariants}\njudgeModels:\n  - executor: claude`);
      assert.throws(() => loadEvalConfig(path), /judgeModels\[0\]\.model must be a non-empty string/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reject judgeModels 单条 (ensemble 至少 2 条, 单 judge 用顶层 judgeExecutor+judgeModel)', () => {
    const dir = makeTmpDir();
    try {
      const path = writeYaml(dir, 'eval.yaml', `samples: ./s.json\n${minimalVariants}\njudgeModels:\n  - executor: claude\n    model: opus`);
      assert.throws(() => loadEvalConfig(path), /judgeModels must have ≥ 2 entries/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('goldDir 绝对路径保持不变', () => {
    const dir = makeTmpDir();
    try {
      const path = writeYaml(dir, 'eval.yaml', `samples: ./s.json\n${minimalVariants}\ngoldDir: /tmp/abs-gold`);
      const cfg = loadEvalConfig(path);
      assert.equal(cfg.goldDir, '/tmp/abs-gold');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('loadEvalConfig — allowedSkills', () => {
  it('解析 allowedSkills: [] 表示完全隔离', () => {
    const dir = makeTmpDir();
    try {
      const path = writeYaml(dir, 'eval.yaml', `
samples: ./s.json
variants:
  - name: baseline
    role: control
    artifact: baseline
    allowedSkills: []
  - name: v1
    role: treatment
    artifact: ./v1.md
`.trim());
      const cfg = loadEvalConfig(path);
      assert.deepEqual(cfg.variants[0].allowedSkills, []);
      assert.equal(cfg.variants[1].allowedSkills, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('解析 allowedSkills 白名单', () => {
    const dir = makeTmpDir();
    try {
      const path = writeYaml(dir, 'eval.yaml', `
samples: ./s.json
variants:
  - name: skill-clean
    role: control
    artifact: baseline
    allowedSkills:
      - react-skill
      - typescript-skill
`.trim());
      const cfg = loadEvalConfig(path);
      assert.deepEqual(cfg.variants[0].allowedSkills, ['react-skill', 'typescript-skill']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reject `allowedSkills:` 不写值(parse 成 null,语义不清)', () => {
    const dir = makeTmpDir();
    try {
      const path = writeYaml(dir, 'eval.yaml', `
samples: ./s.json
variants:
  - name: baseline
    role: control
    artifact: baseline
    allowedSkills:
`.trim());
      assert.throws(() => loadEvalConfig(path), /allowedSkills must be an array/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reject 非数组(string)', () => {
    const dir = makeTmpDir();
    try {
      const path = writeYaml(dir, 'eval.yaml', `
samples: ./s.json
variants:
  - name: baseline
    role: control
    artifact: baseline
    allowedSkills: "react"
`.trim());
      assert.throws(() => loadEvalConfig(path), /allowedSkills must be an array/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reject 数组里有非字符串元素', () => {
    const dir = makeTmpDir();
    try {
      const path = writeYaml(dir, 'eval.yaml', `
samples: ./s.json
variants:
  - name: baseline
    role: control
    artifact: baseline
    allowedSkills:
      - react
      - 123
`.trim());
      assert.throws(() => loadEvalConfig(path), /allowedSkills\[1\]/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('absent allowedSkills 字段:variant.allowedSkills === undefined', () => {
    const dir = makeTmpDir();
    try {
      const path = writeYaml(dir, 'eval.yaml', `
samples: ./s.json
variants:
  - name: baseline
    role: control
    artifact: baseline
`.trim());
      const cfg = loadEvalConfig(path);
      assert.equal(cfg.variants[0].allowedSkills, undefined,
        'absent vs explicit [] 必须区分');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
