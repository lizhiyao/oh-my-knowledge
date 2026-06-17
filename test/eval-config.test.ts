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

function withYaml<T>(content: string, fn: (path: string, dir: string) => T): T {
  const dir = makeTmpDir();
  try {
    const path = writeYaml(dir, 'eval.yaml', content.trim());
    return fn(path, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertYamlThrows(content: string, expected: RegExp, message: string): void {
  withYaml(content, (path) => {
    assert.throws(() => loadEvalConfig(path), expected, message);
  });
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

  const invalidRequiredConfigCases = [
    {
      name: 'samples field missing',
      yaml: `
variants:
  - name: v1
    role: control
    artifact: baseline
        `,
      error: /'samples' is required/,
    },
    {
      name: 'variants array is empty',
      yaml: `
samples: ./samples.json
variants: []
        `,
      error: /'variants' is required/,
    },
    {
      name: 'variant role is invalid',
      yaml: `
samples: ./samples.json
variants:
  - name: v1
    role: baseline
    artifact: ./v1.md
        `,
      error: /role must be 'control' or 'treatment'/,
    },
    {
      name: 'variant names are duplicated',
      yaml: `
samples: ./samples.json
variants:
  - name: v1
    role: control
    artifact: baseline
  - name: v1
    role: treatment
    artifact: ./v1.md
        `,
      error: /"v1" is duplicated/,
    },
  ];

  it.each(invalidRequiredConfigCases)('rejects invalid required config shape: $name', ({ yaml, error, name }) => {
    assertYamlThrows(yaml, error, name);
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
  it('carries cwd structurally (expr stays pure, no @cwd encoding)', () => {
    const specs = configVariantsToSpecs([
      { name: 'v1', role: 'control', artifact: 'baseline' },
      { name: 'v2', role: 'treatment', artifact: './skill.md', cwd: '/tmp/project' },
    ]);
    assert.deepEqual(specs, [
      { name: 'v1', role: 'control', expr: 'baseline' },
      { name: 'v2', role: 'treatment', expr: './skill.md', cwd: '/tmp/project' },
    ]);
  });

  it('leaves expr untouched when cwd is absent', () => {
    const specs = configVariantsToSpecs([
      { name: 'git', role: 'treatment', artifact: 'git:my-skill' },
    ]);
    assert.equal(specs[0].expr, 'git:my-skill');
  });

  it('远端 git variant:结构化 spec.git + 规范身份 expr(url/ref/spec 不拼回字符串再 split)', () => {
    const specs = configVariantsToSpecs([
      { name: 'remote', role: 'treatment', git: { url: 'git@github.com:o/r.git', ref: 'v1', spec: 'skills/review' }, cwd: '/proj' },
    ]);
    assert.deepEqual(specs[0].git, { url: 'git@github.com:o/r.git', ref: 'v1', spec: 'skills/review' });
    assert.equal(specs[0].expr, 'git+git@github.com:o/r.git@v1:skills/review', 'expr 仅作 variantIdentity 去重身份');
    assert.equal(specs[0].cwd, '/proj', 'cwd 独立字段,URL 的 @/: 不串台');
  });
});

describe('loadEvalConfig — 远端 git variant', () => {
  it('接受结构化 git: { url, spec }(ref 可省)', () => {
    withYaml(`
samples: ./s.json
variants:
  - name: remote
    role: treatment
    git:
      url: https://github.com/o/r.git
      spec: skills/review
`, (path) => {
      const cfg = loadEvalConfig(path);
      assert.deepEqual(cfg.variants[0].git, { url: 'https://github.com/o/r.git', spec: 'skills/review' });
      assert.equal(cfg.variants[0].artifact, undefined);
    });
  });

  it('artifact 与 git 二选一:都给 → 报错', () => {
    assertYamlThrows(`
samples: ./s.json
variants:
  - name: x
    role: control
    artifact: ./a.md
    git:
      url: https://h/r.git
      spec: skills/x
`, /exactly one of 'artifact' or 'git'/, '兼有 artifact 与 git 应拒');
  });

  it('artifact 与 git 二选一:都不给 → 报错', () => {
    assertYamlThrows(`
samples: ./s.json
variants:
  - name: x
    role: control
`, /exactly one of 'artifact' or 'git'/, '都缺应拒');
  });

  it('git 缺 url / spec → 报错', () => {
    assertYamlThrows(`
samples: ./s.json
variants:
  - name: x
    role: control
    git:
      url: https://h/r.git
`, /git\.spec is required/, '缺 spec 应拒');
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

  const invalidBudgetCases = [
    {
      name: 'negative budget value',
      yaml: `
samples: ./s.json
${minimalVariants}
budget:
  totalUSD: -1
        `,
      error: /totalUSD/,
    },
    {
      name: 'non-numeric budget value',
      yaml: `
samples: ./s.json
${minimalVariants}
budget:
  totalUSD: "five"
        `,
      error: /totalUSD/,
    },
    {
      name: 'non-object budget value',
      yaml: `
samples: ./s.json
${minimalVariants}
budget: 5
        `,
      error: /budget must be an object/,
    },
  ];

  it.each(invalidBudgetCases)('rejects invalid budget value: $name', ({ yaml, error, name }) => {
    assertYamlThrows(yaml, error, name);
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

  const invalidExperimentDesignCases = [
    {
      name: 'repeat non-integer',
      yaml: `samples: ./s.json\n${minimalVariants}\nrepeat: 1.5`,
      error: /repeat must be a positive integer/,
    },
    {
      name: 'repeat <= 0',
      yaml: `samples: ./s.json\n${minimalVariants}\nrepeat: 0`,
      error: /repeat must be a positive integer/,
    },
    {
      name: 'bootstrapSamples < 100',
      yaml: `samples: ./s.json\n${minimalVariants}\nbootstrapSamples: 50`,
      error: /bootstrapSamples must be a number ≥ 100/,
    },
    {
      name: 'judgeModels non-array',
      yaml: `samples: ./s.json\n${minimalVariants}\njudgeModels: "claude:opus"`,
      error: /judgeModels must be an array/,
    },
    {
      name: 'judgeModels entry missing model',
      yaml: `samples: ./s.json\n${minimalVariants}\njudgeModels:\n  - executor: claude`,
      error: /judgeModels\[0\]\.model must be a non-empty string/,
    },
    {
      name: 'judgeModels empty array',
      yaml: `samples: ./s.json\n${minimalVariants}\njudgeModels: []`,
      error: /judgeModels must have ≥ 1 entry/,
    },
    {
      name: 'judgeModels duplicate entry',
      yaml: `samples: ./s.json\n${minimalVariants}\njudgeModels:\n  - executor: claude\n    model: haiku\n  - executor: claude\n    model: haiku`,
      error: /duplicate entry "claude:haiku"/,
    },
    {
      name: 'legacy judgeModel field',
      yaml: `samples: ./s.json\n${minimalVariants}\njudgeModel: haiku`,
      error: /judgeModel.*were removed in v0\.25/,
    },
    {
      name: 'legacy judgeExecutor field',
      yaml: `samples: ./s.json\n${minimalVariants}\njudgeExecutor: claude`,
      error: /judgeExecutor.*were removed in v0\.25/,
    },
    {
      name: 'removed blind field',
      yaml: `samples: ./s.json\n${minimalVariants}\nblind: true`,
      error: /`blind`.*was removed/,
    },
  ];

  it.each(invalidExperimentDesignCases)('rejects invalid v0.2 experiment-design field: $name', ({ yaml, error, name }) => {
    assertYamlThrows(yaml, error, name);
  });

  it('judgeModels 单条 = single judge (合法, 不进 ensemble)', () => {
    const dir = makeTmpDir();
    try {
      const path = writeYaml(dir, 'eval.yaml', `samples: ./s.json\n${minimalVariants}\njudgeModels:\n  - executor: claude\n    model: haiku`);
      const cfg = loadEvalConfig(path);
      assert.deepEqual(cfg.judgeModels, [{ executor: 'claude', model: 'haiku' }]);
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

  it('拒绝非空 allowedSkills 白名单(已移除,只允许 [] 或省略)', () => {
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
      assert.throws(() => loadEvalConfig(path), /non-empty skill whitelist is no longer supported/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('接受 allowedSkills: [](严格隔离)', () => {
    const dir = makeTmpDir();
    try {
      const path = writeYaml(dir, 'eval.yaml', `
samples: ./s.json
variants:
  - name: skill-clean
    role: control
    artifact: baseline
    allowedSkills: []
`.trim());
      const cfg = loadEvalConfig(path);
      assert.deepEqual(cfg.variants[0].allowedSkills, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const invalidAllowedSkillsCases = [
    {
      name: 'empty YAML value parses as null',
      yaml: `
samples: ./s.json
variants:
  - name: baseline
    role: control
    artifact: baseline
    allowedSkills:
        `,
      error: /allowedSkills must be an array/,
    },
    {
      name: 'string instead of array',
      yaml: `
samples: ./s.json
variants:
  - name: baseline
    role: control
    artifact: baseline
    allowedSkills: "react"
        `,
      error: /allowedSkills must be an array/,
    },
    {
      name: 'array contains non-string element',
      yaml: `
samples: ./s.json
variants:
  - name: baseline
    role: control
    artifact: baseline
    allowedSkills:
      - react
      - 123
        `,
      error: /allowedSkills\[1\]/,
    },
  ];

  it.each(invalidAllowedSkillsCases)('rejects invalid allowedSkills shape: $name', ({ yaml, error, name }) => {
    assertYamlThrows(yaml, error, name);
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
