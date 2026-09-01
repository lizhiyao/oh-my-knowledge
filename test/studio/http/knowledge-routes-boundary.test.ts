import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Studio knowledge route boundary', () => {
  it('keeps knowledge projections and rendering out of request composition', () => {
    const composition = readFileSync('src/studio/http/request-handler.ts', 'utf8');

    expect(composition).toContain('createKnowledgeRoutes');
    for (const forbidden of [
      'buildSkillIndex',
      'renderSkillList',
      'renderSkillDetail',
      'renderSkillHealthReport',
      'renderDoctorDetail',
      'renderManagedList',
      'querySkillTrend',
      'querySkillDiff',
      '/api/skills',
      '/api/managed',
      '/api/observe-health',
    ]) {
      expect(composition).not.toContain(forbidden);
    }
  });

  it('keeps the capability route independent from listener and global composition', () => {
    const routes = readFileSync('src/studio/http/routes/knowledge.ts', 'utf8');

    expect(routes).not.toContain('report-server');
    expect(routes).not.toContain('request-handler');
    expect(routes).not.toContain("from '../contracts.js'");
    expect(routes).not.toContain('createServer');
    expect(routes).not.toContain('.listen(');
    expect(routes).not.toContain('/api/shutdown');
    expect(routes).not.toContain("path === '/health'");
  });
});
