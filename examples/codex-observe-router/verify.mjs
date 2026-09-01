#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const caseDir = dirname(fileURLToPath(import.meta.url));
const traceDir = join(caseDir, 'trace');

function executableOnPath(name) {
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    if (!entry) continue;
    const candidate = join(entry, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching.
    }
  }
  return null;
}

function resolveRuntime() {
  const explicit = process.env.OMK_BIN
    ? resolve(process.env.OMK_BIN)
    : executableOnPath(process.platform === 'win32' ? 'omk.cmd' : 'omk');
  const localCli = resolve(caseDir, '../../dist/cli/index.js');
  const cli = explicit ?? (existsSync(localCli) ? localCli : null);
  assert.ok(
    cli,
    'omk was not found. Run through npm exec --package=oh-my-knowledge@0.49.0 or set OMK_BIN.',
  );

  const realCli = realpathSync(cli);
  const packageRoot = process.env.OMK_PACKAGE_ROOT
    ? resolve(process.env.OMK_PACKAGE_ROOT)
    : resolve(dirname(realCli), '../..');
  const isJavaScriptCli = realCli.endsWith('.js');

  return {
    command: isJavaScriptCli ? process.execPath : cli,
    prefixArgs: isJavaScriptCli ? [realCli] : [],
    packageRoot,
  };
}

function run(runtime, args, cwd) {
  const result = spawnSync(runtime.command, [...runtime.prefixArgs, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  assert.equal(
    result.status,
    0,
    `omk command failed:\n${result.stderr || result.stdout}`,
  );
  return result.stdout;
}

const runtime = resolveRuntime();
const packageJson = JSON.parse(readFileSync(join(runtime.packageRoot, 'package.json'), 'utf8'));
const workspace = mkdtempSync(join(tmpdir(), 'omk-codex-observe-case-'));
const outputDir = join(workspace, '.omk', 'observe-inbox');
const keepOutput = process.env.OMK_KEEP_OUTPUT === '1';

try {
  const ingestOutput = run(runtime, [
    'observe',
    'ingest',
    traceDir,
    '--lang',
    'en',
    '--output-dir',
    outputDir,
  ], workspace);
  assert.match(ingestOutput, /2 sessions/i);

  const queryOutput = run(runtime, [
    'observe',
    'inbox',
    '--input-dir',
    outputDir,
    '--lang',
    'en',
    '--json',
  ], workspace);
  const query = JSON.parse(queryOutput);

  const loaderUrl = pathToFileURL(
    join(runtime.packageRoot, 'dist/observability/inbox/index.js'),
  ).href;
  const { loadObservationInboxReports } = await import(loaderUrl);
  const reports = loadObservationInboxReports(outputDir);
  assert.equal(reports.length, 1);

  const report = reports[0];
  const experience = report.experience;
  assert.ok(experience);
  assert.equal(experience.sessions.length, 1);
  assert.equal(experience.storyContexts.length, 1);
  assert.deepEqual(
    [...new Set(experience.sessions.map((session) => session.sourceKind))],
    ['codex'],
  );

  const episodes = experience.storyContexts.flatMap((context) => context.episodes);
  const edges = episodes.flatMap((episode) => episode.orchestrationEdges);
  const externalEdges = edges.filter((edge) => edge.edgeKind === 'external_child_session');
  const routerDownstreamCompleted = experience.sessions.reduce(
    (total, session) => total + session.indicators.routerDownstreamCompleted,
    0,
  );
  const edgeEndpointsClosed = episodes.every((episode) => {
    const segmentIds = new Set(episode.skillSegments.map((segment) => segment.id));
    return episode.orchestrationEdges.every((edge) =>
      (!edge.parentSkillSegmentId || segmentIds.has(edge.parentSkillSegmentId))
      && (!edge.executorSkillSegmentId || segmentIds.has(edge.executorSkillSegmentId)));
  });

  assert.equal(readdirSync(traceDir).filter((file) => file.endsWith('.jsonl')).length, 2);
  assert.equal(externalEdges.length, 1);
  assert.equal(externalEdges[0].childSessionId, 'codex-case-review-child');
  assert.equal(edgeEndpointsClosed, true);
  assert.equal(routerDownstreamCompleted, 1);
  assert.equal(query.kind, 'observe-inbox-query');
  assert.equal(query.items.length, 1);
  assert.equal(query.items[0].sourceKind, 'codex');
  assert.equal(query.items[0].signalType, 'failed_search');

  const summary = {
    omkVersion: packageJson.version,
    physicalTraceFiles: 2,
    logicalSessions: experience.storyContexts.length,
    observedSkills: experience.sessions.map((session) => session.skillName).sort(),
    sourceKind: experience.sessions[0].sourceKind,
    externalChildEdges: externalEdges.length,
    edgeEndpointsClosed,
    routerDownstreamCompleted,
    inboxSignals: query.items.length,
    inboxSignalTypes: query.items.map((item) => item.signalType),
    compactReportRoundTrip: true,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

  if (keepOutput) {
    process.stderr.write(`Kept report output at ${outputDir}\n`);
  }
} finally {
  if (!keepOutput) {
    rmSync(workspace, { recursive: true, force: true });
  }
}
