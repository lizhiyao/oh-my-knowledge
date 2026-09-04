import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const STYLE_ROOT = resolve('src/studio/presentation/observation-inbox');
const SECTION_ROOT = resolve(STYLE_ROOT, 'styles');
const SECTIONS = ['experience.ts', 'metrics.ts', 'review.ts', 'shell.ts', 'trajectory.ts'];

describe('Studio observation inbox presentation layout', () => {
  it('keeps the public style module as a composition-only facade', () => {
    const facade = readFileSync(resolve(STYLE_ROOT, 'styles.ts'), 'utf8');

    expect(facade.split('\n').length).toBeLessThanOrEqual(20);
    expect(facade).not.toMatch(/\{\s*(?:display|color|margin|padding|position):/);
    for (const section of SECTIONS) {
      expect(facade).toContain(`./styles/${section.replace(/\.ts$/, '.js')}`);
    }
  });

  it('keeps the stylesheet split into bounded, explicitly owned sections', () => {
    expect(readdirSync(SECTION_ROOT).sort()).toEqual(SECTIONS);
    for (const section of SECTIONS) {
      const lines = readFileSync(resolve(SECTION_ROOT, section), 'utf8').split('\n').length;
      expect(lines, section).toBeLessThanOrEqual(1_600);
    }
  });
});
