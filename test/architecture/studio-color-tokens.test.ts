/**
 * Studio 配色 token 的防漂移门禁。
 *
 * 为什么要有这条：`src/studio/web/app/studio.css` 是压缩成单行的手写样式，`theme.tsx` 又把
 * 同一批值交给 Ant Design 派生，DESIGN.md 的 frontmatter 是第三份。三处各自漂移时，编译器、
 * lint 与渲染断言都不会变红——它们看的是结构与文字，不是「链接到底用哪个紫」。Issue #1060
 * 的规范把品牌紫拆成「填充／文字」两个角色，正是因为实测 `#7753FF` 只在纯白达标（4.70:1），
 * 落在应用底色只有 4.43:1、落在选中底只有 4.13:1，都不够小字的 4.5:1。这个区分一旦被人顺手
 * 改回一个值，无障碍结论就悄悄失效了，所以锁在门禁里而不是锁在 PR 描述里。
 *
 * 本门禁只查四件事：
 *  1. 语义 token 在 `:root` 一处定义，且取值就是规范登记的那批；
 *  2. 主题主色与 `--studio-action` 同源，Ant Design 派生不出第二个品牌紫；
 *  3. 旧的品牌紫 `#5145cd` 不再出现在样式里——出现即说明有人绕过 token 写死；
 *  4. 「导航选中底」与「人类消息气泡底」是两个角色，历史上它们同值，容易被一次替换合并。
 *
 * 口径边界（刻意不查）：
 *  - 不查 `#657085` 这类尚未收敛到 token 的散落色值。它们仍是有意的现状，收敛是后续任务，
 *    由 DESIGN.md 的「待收敛」标注跟踪，不由这条门禁冒充已完成。
 *  - 不查悬停档与选中档是否该合并：现网多处悬停仍复用选中底 `#eef0f6`，这是规范里挂着的
 *    待评审项，本门禁只保证它被显式命名，不替评审者改值。
 *  - 不做像素或对比度计算。数值达标与否由 `design/studio/` 的取证脚本在真实渲染上量，
 *    这里只保证被量过的那批值没有被悄悄换掉。
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const CSS_FILE = join(REPO_ROOT, 'src', 'studio', 'web', 'app', 'studio.css');
const THEME_FILE = join(REPO_ROOT, 'src', 'studio', 'web', 'components', 'layout', 'theme.tsx');
const DESIGN_FILE = join(REPO_ROOT, 'DESIGN.md');

/** 规范登记的目标值：改这里必须同时改 DESIGN.md 与 design/studio/tokens.css。 */
const TARGET_TOKENS: Record<string, string> = {
  '--studio-action': '#7753ff',
  '--studio-action-hover': '#6745eb',
  '--studio-action-ink': '#5a3cdb',
  '--studio-selection-fill': '#f2eeff',
  '--tone-success-ink': '#14795a',
  '--tone-warning-ink': '#a1560b',
  '--tone-error-ink': '#b42318',
  '--tone-neutral-ink': '#5f6b7f',
};

const css = readFileSync(CSS_FILE, 'utf8');
const theme = readFileSync(THEME_FILE, 'utf8');
const design = readFileSync(DESIGN_FILE, 'utf8');

describe('Studio 配色 token 单一来源', () => {
  it('语义 token 在 :root 一处定义，取值与规范一致', () => {
    const rootBlock = css.match(/:root\{[^}]*--studio-action[^}]*\}/);
    expect(rootBlock, 'studio.css 里找不到定义 --studio-* 的 :root 块').not.toBeNull();
    for (const [token, value] of Object.entries(TARGET_TOKENS)) {
      expect(rootBlock![0], `${token} 应取 ${value}`).toContain(`${token}:${value}`);
    }
  });

  it('主题主色与 --studio-action 同源，DESIGN.md 也记同一个值', () => {
    const primary = theme.match(/colorPrimary:\s*'([^']+)'/);
    expect(primary, 'theme.tsx 未声明 colorPrimary').not.toBeNull();
    expect(primary![1]).toBe(TARGET_TOKENS['--studio-action']);
    expect(design, 'DESIGN.md frontmatter 的 primary 与主题不同源').toContain(
      `primary: "${primary![1]}"`,
    );
  });

  it('旧品牌紫不再被写死在样式或主题里', () => {
    expect(css, 'studio.css 仍出现 #5145cd：应改为引用 --studio-* token').not.toMatch(/#5145cd/i);
    expect(theme, 'theme.tsx 仍出现 #5145cd').not.toMatch(/#5145cd/i);
  });

  it('导航选中底与人类消息气泡底是两个角色，没有被一次替换合并', () => {
    expect(css).toContain('--studio-selection-fill:#f2eeff');
    expect(css).toContain('--studio-message-human-fill:#eef0f6');
    const bubble = css.match(/\.observe-reading-message\.human\{[^}]*\}/);
    expect(bubble, '找不到人类消息气泡规则').not.toBeNull();
    expect(bubble![0]).toContain('var(--studio-message-human-fill)');
    expect(bubble![0], '气泡底被并进了选中底').not.toContain('--studio-selection-fill');
    const nav = css.match(/\.studio-sidebar nav a\[aria-current\]\{[^}]*\}/);
    expect(nav, '找不到一级导航当前项规则').not.toBeNull();
    expect(nav![0]).toContain('var(--studio-selection-fill)');
  });

  it('四处选中态统一到同一底色与指示条，运行中行仍是独立角色', () => {
    // 历史上它们是浅紫、浅蓝、灰蓝三种值；分散会让读者把「选中」读成三种状态。
    const selectedRules = [
      /\.observe-session-link\.selected\{[^}]*\}/,
      /\.candidate-list>button\.selected\{[^}]*\}/,
      /\.measure-sidebar-link\.selected\{[^}]*\}/,
    ];
    for (const pattern of selectedRules) {
      const rule = css.match(pattern);
      expect(rule, `找不到选中规则 ${pattern}`).not.toBeNull();
      expect(rule![0]).toContain('var(--studio-selection-fill)');
    }
    const candidate = css.match(/\.candidate-list>button\.selected\{[^}]*\}/);
    expect(candidate![0], '选中指示条应统一到 2px 品牌紫').toContain('inset 2px 0 0 var(--studio-action)');
    // 「运行中」表达活动性而不是选中，收成独立 token，值保持原蓝。
    expect(css).toContain('--studio-running-indicator:#2563eb');
    expect(css, '运行中行指示条被并进了选中角色').toContain(
      'tr.studio-running-row>td:first-child{box-shadow:inset 3px 0 var(--studio-running-indicator)}',
    );
  });

  it('链接悬停走 hover token，样式与主题里不再有旧品牌紫', () => {
    const hover = css.match(/\.studio-content :where\(a:hover\)[^{]*\{[^}]*\}/);
    expect(hover, '找不到正文链接悬停规则').not.toBeNull();
    expect(hover![0]).toContain('var(--studio-action-hover)');
    expect(css, '仍出现旧 hover 值 #4235b5').not.toMatch(/#4235b5/i);
    expect(design, 'DESIGN.md 的 primary-hover 与样式不同源').toContain(
      `primary-hover: "${TARGET_TOKENS['--studio-action-hover']}"`,
    );
  });

  it('分页选中态被显式收回墨色，且特异性高于 Ant Design 的派生规则', () => {
    // 主色换成品牌紫后，antd 会把同一个值用作页码文字色。它的规则是
    // `.ant-pagination .ant-pagination-item-active a`，且样式运行时注入、排在静态样式之后，
    // 所以覆写必须多带一层祖先选择器，否则同特异性会被它压过——这一点已被实测抓到过一次。
    const fill = css.match(/\.studio-content \.ant-pagination \.ant-pagination-item-active\{[^}]*\}/);
    expect(fill, '找不到分页选中项底色覆写（需带 .ant-pagination 祖先以保证特异性）').not.toBeNull();
    expect(fill![0]).toContain('var(--studio-selection-fill)');
    const text = css.match(/\.studio-content \.ant-pagination \.ant-pagination-item-active a[^{]*\{[^}]*\}/);
    expect(text, '找不到分页选中项文字色覆写（需带 .ant-pagination 祖先）').not.toBeNull();
    expect(text![0]).toContain('color:var(--studio-ink)');
    expect(text![0], '分页选中文字仍引用品牌紫').not.toContain('var(--studio-action)');
  });

  it('Ant Design 主题 token 与本目录 token 同源，页面不再出现 antd 默认蓝与默认灰', () => {
    // 未达 AA 的文字里，多数不是本仓库写的颜色，而是 antd 的默认值：
    // colorLink #1677ff（3.86:1）、次要文字 #88888a（3.32:1）、空态 #8c8c8c（3.35:1）。
    // 只有把它们在主题层对齐，才不用给每个组件补 CSS 覆写。
    const themeToken = (name: string) => theme.match(new RegExp(`${name}:\\s*'([^']+)'`))?.[1];
    expect(themeToken('colorLink'), 'colorLink 应与文字紫同源').toBe(TARGET_TOKENS['--studio-action-ink']);
    expect(themeToken('colorTextTertiary'), '次要文字应与 --studio-ink-muted 同源').toBe('#5f6b7f');
    expect(themeToken('colorSuccess')).toBe(TARGET_TOKENS['--tone-success-ink']);
    expect(themeToken('colorWarning')).toBe(TARGET_TOKENS['--tone-warning-ink']);
    expect(themeToken('colorError')).toBe(TARGET_TOKENS['--tone-error-ink']);
    // 中性灰小字必须走 token；样式里再出现 #8893a5 就说明有人又写死了一个灰。
    expect(css, 'studio.css 仍写死 #8893a5').not.toMatch(/:#8893a5/i);
    expect(css).toContain('--studio-ink-muted:#5f6b7f');
  });

  it('状态色的浅底与边框被显式给出，不由暗基色派生', () => {
    // antd 的 Tag／Alert 底色是从 colorSuccess 这类基色「派生」出来的。
    // 把基色换成规范要求的深色后，派生结果落在灰绿 #adb8b2、土黄 #e0d9ca 上，
    // 12px 文字实测只有 2.63 与 3.88:1——比换色前更差。浅底必须一起显式给出。
    const themeToken = (name: string) => theme.match(new RegExp(`${name}:\\s*'([^']+)'`))?.[1];
    expect(themeToken('colorSuccessBg'), 'colorSuccessBg 需显式声明，不能让 antd 派生').toBe('#e6f4ee');
    expect(themeToken('colorWarningBg')).toBe('#fdf1e3');
    expect(themeToken('colorErrorBg')).toBe('#fbeae8');
    // 页签选中文字：antd 默认把 colorPrimary 当选中文字色，压在应用底色上实测 4.43:1。
    // components 必须与 token 平级——放进 token 里会被当成无效 token 名而静默失效。
    const tabs = theme.match(/components:\s*\{\s*Tabs:\s*\{([^}]*)\}/);
    expect(tabs, 'theme.tsx 缺少 Tabs 组件 token（注意必须与 token 平级）').not.toBeNull();
    expect(tabs![1]).toContain("itemSelectedColor: '#5a3cdb'");
    expect(theme.indexOf('components:'), 'components 被放进了 token 对象内部')
      .toBeGreaterThan(theme.indexOf('sans-serif'));
  });
});
