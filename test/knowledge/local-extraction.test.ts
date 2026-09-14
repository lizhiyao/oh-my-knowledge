import { describe, expect, it } from 'vitest';
import { extractLocalProposals } from '../../src/observability/knowledge-extraction/local-extraction.js';
import { checkExtractionResponse } from '../../src/observability/knowledge-extraction/proposals.js';

const excerpt = (text: string, role = 'user') => ({ evidenceRef: 'r1', recordIndex: 0, eventKind: 'message', role, text });
describe('local rule extraction', () => {
  it('keeps exact UTF-16 citations, uncertainty, negation and conditions without rewriting', () => {
    const source = excerpt('说明😀\r\n- 经验：仅在网络错误时重试，权限拒绝不能重试。\r\nRule: Never overwrite changes.');
    const proposals = extractLocalProposals([source]);
    expect(proposals).toHaveLength(2);
    expect(checkExtractionResponse({ proposals }, [source]).rejected).toEqual([]);
    expect(proposals[0].draft.content.statements[0].relation).toBe('仅在网络错误时重试，权限拒绝不能重试。');
    expect(proposals[0].draft.evidence[0]).toMatchObject({ basis: 'source_assertion', relation: 'background' });
    expect(proposals[0].identityUncertainties).not.toHaveLength(0);
  });
  it('anchors the body after its label even when the text repeats the label', () => {
    const source = excerpt('规则：规则  ');
    const result = extractLocalProposals([source]);
    expect(result[0].citations[0].selection).toMatchObject({ start: 3, end: 5, quote: '规则' });
    expect(checkExtractionResponse({ proposals: result }, [source]).rejected).toEqual([]);
  });
  it('ignores ordinary messages, tool output, quoted blocks and fenced examples', () => {
    expect(extractLocalProposals([excerpt('执行命令完成。\n> 规则：引文\n```text\n经验：示例\n```\n~~~\nRule: example\n~~~'), excerpt('规则：工具输出', 'tool')])).toEqual([]);
  });
  it('keeps distinct source occurrences and bounds the output', () => {
    const proposals = extractLocalProposals([excerpt(Array.from({ length: 20 }, () => '规则：同名条目').join('\n'))]);
    expect(proposals).toHaveLength(12);
    expect(proposals[0].citations).not.toEqual(proposals[1].citations);
    expect(extractLocalProposals([excerpt(`规则：${'a'.repeat(4097)}`)])).toEqual([]);
  });
});
