import { createInterface } from 'node:readline';

let seq = 0;

function write(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function event(sessionId, type, data) {
  write({
    jsonrpc: '2.0',
    method: 'session.event',
    params: {
      sessionId,
      event: { type, seq: ++seq, time: Date.now(), data },
    },
  });
}

function assistantMessage(id, text) {
  return {
    id,
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: 'fixture', model: 'fixture-model' },
  };
}

function emitRun(params, messageId) {
  const root = params.sessionId;
  const child = `${root}-child`;
  const prompt = params.contentBlocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  const finalText = [
    process.env.DSH_SYSTEM_PROMPT ?? '',
    prompt,
    process.env.DSH_HOME ?? '',
    process.env.DSH_SESSION_ROOT ?? '',
    process.env.DSH_CORDIS_CONFIG ?? '',
  ].join('|');

  event(root, 'agent/inbox/spliced', {
    inserted: [{ id: messageId, role: 'user', content: params.contentBlocks }],
  });
  write({
    jsonrpc: '2.0',
    method: 'session.status',
    params: { sessionId: root, status: 'running' },
  });
  event(root, 'turn/start', { turn: 1 });
  event(root, 'user/message', {
    id: messageId,
    role: 'user',
    content: params.contentBlocks,
    source: { kind: 'human' },
  });
  event(root, 'tool/call', {
    turn: 1,
    step: 1,
    callId: 'call-1',
    name: 'read',
    arguments: '{"path":"README.md"}',
  });
  event(root, 'tool/result', {
    turn: 1,
    step: 1,
    message: {
      id: 'tool-result-1',
      role: 'user',
      source: { kind: 'tool' },
      content: [{
        type: 'tool-result',
        toolCallId: 'call-1',
        content: [{ type: 'text', text: 'fixture file' }],
      }],
    },
  });
  write({
    jsonrpc: '2.0',
    method: 'subagent.started',
    params: { parentSessionId: root, childSessionId: child },
  });
  event(child, 'assistant/message', {
    turn: 1,
    step: 1,
    message: assistantMessage('child-assistant-1', 'child answer'),
    usage: { inputTokens: 3, outputTokens: 2 },
  });
  event(child, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  write({
    jsonrpc: '2.0',
    method: 'subagent.finished',
    params: {
      provider: 'fixture',
      agentId: child,
      parentSessionId: root,
      childSessionId: child,
      status: 'ok',
      stopReason: 'stop',
    },
  });
  event(root, 'assistant/message', {
    turn: 1,
    step: 1,
    message: assistantMessage('root-assistant-1', finalText),
    usage: {
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    },
  });
  event(root, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  write({
    jsonrpc: '2.0',
    method: 'session.status',
    params: { sessionId: root, status: 'idle' },
  });
}

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        serverInfo: { name: 'deepseek-harness-sdk-runtime', version: 'fixture' },
      },
    });
    return;
  }
  if (request.method === 'session/prompt') {
    const messageId = `fixture-message-${request.id}`;
    write({ jsonrpc: '2.0', id: request.id, result: { messageId } });
    const prompt = request.params.contentBlocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    if (prompt === '__hang__') return;
    setImmediate(() => emitRun(request.params, messageId));
    return;
  }
  if (request.method === 'shutdown') {
    write({ jsonrpc: '2.0', id: request.id, result: {} });
    setImmediate(() => process.exit(0));
  }
});
