import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'vitest';
import { layout } from '../../../src/studio/presentation/layout.js';

describe('HTML 外壳语言切换', () => {
  it('navigates to a complete language render even when storage is blocked', () => {
    const html = layout('test', '<main>test</main>');
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).find((value) => value.includes('function switchLang'))!;
    let destination = '';
    const context = {
      URL, document: { documentElement: { dataset: { lang: 'zh' } } },
      window: { location: { href: 'http://localhost/observe/inbox?skill=a%26b&turnId=t#evidence', assign: (url: string) => { destination = url; } } },
      localStorage: { getItem: () => null, setItem: () => { throw new Error('blocked'); } },
    };
    runInNewContext(`${script}\nswitchLang();`, context);
    const target = new URL(destination);
    assert.equal(target.pathname, '/observe/inbox');
    assert.equal(target.searchParams.get('skill'), 'a&b');
    assert.equal(target.searchParams.get('turnId'), 't');
    assert.equal(target.searchParams.get('lang'), 'en');
    assert.equal(target.hash, '#evidence');
  });
});
