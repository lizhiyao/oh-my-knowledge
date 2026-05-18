import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { isAssistantProtocolReplyText } from '../../src/observability/text-signals.js';

describe('isAssistantProtocolReplyText', () => {
  it('classifies bare protocol tokens as protocol reply', () => {
    for (const text of ['OK', 'OK\n', '  OK  ', 'PONG', 'ACK', 'HEARTBEAT_OK', 'HEARTBEAT', 'PING_OK', '::FORWARD-OK::']) {
      assert.equal(isAssistantProtocolReplyText(text), true, `should classify as protocol: ${JSON.stringify(text)}`);
    }
  });

  it('accepts protocol token with trailing punctuation', () => {
    for (const text of ['OK.', 'OK!', 'PONG.', 'ACK!\n']) {
      assert.equal(isAssistantProtocolReplyText(text), true, `should classify as protocol: ${JSON.stringify(text)}`);
    }
  });

  it('rejects conversational messages that start with a protocol token', () => {
    // 这一组是 v0.30 之前的回归 trap。旧 `(?:\s|\n|$)` 形态把这种正常对话开头
    // 误分类为协议消息,assistantDeliverySignal 会被错误抑制,污染测量信号。
    for (const text of [
      'OK 我来帮你查一下',
      'OK 我看一下',
      'ACK 已收到任务',
      'OK done!',
      'OK, here is the result',
      'OK 没问题',
      'PONG 我准备好了',
    ]) {
      assert.equal(isAssistantProtocolReplyText(text), false, `should NOT classify as protocol: ${JSON.stringify(text)}`);
    }
  });

  it('rejects empty / whitespace-only input', () => {
    for (const text of ['', '   ', '\n', '\t']) {
      assert.equal(isAssistantProtocolReplyText(text), false, `should reject blank: ${JSON.stringify(text)}`);
    }
  });
});
