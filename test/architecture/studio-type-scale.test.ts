/**
 * Studio 排版尺度的防漂移门禁。
 *
 * 为什么钉这条：Issue #1060 之前，页级标题在 `studio.css` 里散成 8 条规则、四种字号
 * （22／20／18／17）外加两处窄屏降档（18→16、20→17），Agent 页还是 18px/26px。
 * 结果是同一个应用里「这一页的标题」有四种视觉重量，读者无法靠字号判断层级。
 * 收敛后统一为 20px/28px，本门禁保证它不再被单页特例重新拉开——加一条 `font-size:18px`
 * 的 h1 规则在 lint、tsc 和渲染断言里都不会有反应。
 *
 * 口径边界（刻意不查）：
 *  - 只查页级 h1。区段标题（h2、`measure-section h2` 18px）与统计数字（`health-stat-value`
 *    20px）是不同角色，规范没有把它们并进页标题尺度。
 *  - 不查字体族与字重：现状是系统字体栈，字重仍随组件，未收敛成规范。
 *  - 不查具体像素以外的排版（间距、圆角、断点），那几条尚未接入运行时。
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const css = readFileSync(join(REPO_ROOT, 'src', 'studio', 'web', 'app', 'studio.css'), 'utf8');

/** 抽出所有命中 h1 的规则块（含媒体查询内的窄屏档）。 */
function h1Rules(source: string): string[] {
  return [...source.matchAll(/[^{}]*h1[^{}]*\{[^{}]*\}/g)].map((match) => match[0].trim());
}

/**
 * 按「一条声明一条」解析 `:root` 里的自定义属性，返回名字到取值的映射。
 * 不用子串匹配：#1085 漏掉一个分号，`--studio-space-1:2px` 被吞进前一条
 * `--managed-tone-muted` 的值里，`toContain` 照样命中，浏览器却认为它从未声明。
 */
function declaredCustomProperties(source: string): Map<string, string> {
  const declared = new Map<string, string>();
  for (const block of source.matchAll(/:root[^{]*\{([^{}]*)\}/g)) {
    for (const declaration of block[1].split(';')) {
      const pair = /^\s*(--[\w-]+)\s*:\s*(.+)$/.exec(declaration);
      if (pair) declared.set(pair[1], pair[2].trim());
    }
  }
  return declared;
}

describe('Studio 页级标题尺度', () => {
  it('每一条 h1 规则都取 20px/28px，不留单页特例', () => {
    const rules = h1Rules(css);
    expect(rules.length, '没读到任何 h1 规则，检查抽取方式').toBeGreaterThan(3);
    const offenders = rules.filter((rule) =>
      /font-size:(?!20px\b)[^;}]+/.test(rule) || (/line-height:/.test(rule) && !/line-height:28px/.test(rule)));
    expect(offenders, 'h1 字号或行高出现了非 20px/28px 的特例').toEqual([]);
  });

  it("圆角只有控件与容器两档，且都走 token", () => {
    // 现状本来就是 6px（控件）与 8px（容器）两档，外加 50% 圆形品牌标记；
    // 这里不新增形状，只是把已有两档钉成变量，防止后来者随手写第三个圆角。
    expect(css).toContain("--studio-radius-control:6px");
    expect(css).toContain("--studio-radius-container:8px");
    const raw = [...css.matchAll(/border-radius:(?!var|50%)[^;}]+/g)].map((m) => m[0]);
    expect(raw, "出现了未走 token 的圆角").toEqual([]);
  });

  it('间距走 token：布局声明里不再出现任何字面 px', () => {
    // 规范 §3.2 的阶梯是 4/8/12/16/20/24/32，另加两个不属阶梯的档位：`--studio-space-1`
    //（2px 发丝档，图标与文字基线之间，抬到 4px 会把紧凑堆叠撑开）与
    // `--studio-collapsed-rail-offset`（折叠栏内容避让量，与 44px 轨道宽度绑定，是布局偏移不是间距）。
    // 第八批把现网 80 条一次性值就近归档（同距向上），这条门禁随之从「阶梯值必须走 token」
    // 收紧成「padding／margin／gap 里不许出现任何字面 px」——归档会挪动整站元素，
    // 收紧才有意义；前后几何由真实页面逐元素对量，不是靠这条门禁自证。
    const declared = declaredCustomProperties(css);
    expect(declared.size, '没解析出任何 :root 自定义属性，检查抽取方式').toBeGreaterThan(20);
    const swallowed = [...declared].filter(([, value]) => /--[\w-]+\s*:/.test(value));
    expect(swallowed, '这些声明的值里嵌着另一条声明：前一条缺分号，后一条在浏览器里从未生效').toEqual([]);
    for (const [n, px] of [['1', 2], ['2', 4], ['3', 8], ['4', 12], ['5', 16], ['6', 20], ['7', 24], ['9', 32]] as const) {
      expect(declared.get(`--studio-space-${n}`), `缺少 --studio-space-${n}（${px}px）`).toBe(`${px}px`);
    }
    expect(declared.get('--studio-collapsed-rail-offset'), '折叠栏避让量应作为布局偏移单独命名').toBe('52px');
    const offenders: string[] = [];
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (rule[1].includes(':root')) continue;
      for (const d of rule[2].matchAll(/(padding|margin|gap|row-gap|column-gap)(?:-[a-z]+)?\s*:\s*([^;}]+)/g)) {
        // clamp()／max()／min() 里的 px 是视口派生的边界，不是间距档位
        if (/calc\(|max\(|min\(/.test(d[2])) continue;
        if (/\d+(?:\.\d+)?px/.test(d[2])) offenders.push(`${d[1]}:${d[2].trim()}`);
      }
    }
    expect(offenders, '这些布局声明又把长度写成了字面量').toEqual([]);
  });

  it('长表的数字列保持等宽', () => {
    // 数字列不等宽时，耗时与用量的位数对不齐，跨行比较要逐字看。这条在真实页面上量得到
    // （knowledge／measure 的表格单元格计算值为 tabular-nums），单元格不换行由同一条规则钉住。
    const cell = css.match(/\.ant-table-cell\{[^}]*\}/);
    expect(cell, '找不到表格单元格规则').not.toBeNull();
    expect(cell![0], '表格单元格未启用等宽数字').toContain('font-variant-numeric:tabular-nums');
    expect(cell![0], '表格单元格又允许换行').toContain('white-space:nowrap');
    // 省略号与出口刻意不钉在这条全局规则上：实测给 `.ant-table-cell` 加 `overflow:hidden`
    // 会让被裁单元格不再贡献固有宽度，整张表从「比容器宽、可横向滚」塌成容器宽，
    // 长标识就只能逐个悬停看 title，反而不如原来可达（配 `tableLayout:fixed` 也救不回来，
    // 列会被拉伸填满，同样没有横向滚动）。因此按列给 `ellipsis: true`——省略号与自动 title
    // 由它一起给，表体仍保持可横向滚动；这条全局规则只管不换行与等宽数字。
    // 吸顶表头的锚点：卡片必须用 `overflow:clip`，不能用 `hidden`。真实页面上逐个清祖先的
    // overflow 量过：`.studio-table`（圆角裁切）与 `.ant-table-content`（横向滚动）任一存在，
    // 该层就变成滚动容器，sticky 的锚点被截到卡片内部——计算值是 sticky，滚动时表头照样走。
    // `clip` 保留圆角裁切又不建立滚动容器；而让表头脱离横向滚动容器的是 antd 的 `sticky` 属性
    // （它把表头拆成独立一层），由 test/studio/web/measure-react.test.tsx 钉住。
    const card = css.match(/\.studio-table\{[^}]*\}/);
    expect(card, '找不到表格卡片规则').not.toBeNull();
    expect(card![0], '卡片用回 overflow:hidden：吸顶表头的锚点会被这一层截走').toContain('overflow:clip');
    expect(css, '样式里又出现靠 th 自身吸顶的写法：它出不了横向滚动容器，是条量不到效果的死规则')
      .not.toMatch(/ant-table-thead>tr>th\{[^}]*position:sticky/);
  });

  it('响应式断点只有阶梯上的三个宽度档', () => {
    // 第九批把 600／700／760／1000／1100 五个宽度值收到 1280／1024／860 三档，
    // 与 #1060 原型评审定下的退化决定逐档对齐（当时的原型稿已随该 Issue 关闭退场）：
    // 1280 管「候选三栏→两栏」，1024 管「侧栏收窄、阅读页头紧凑、候选两栏→单栏」，
    // 860 管「整个应用切抽屉导航，页头、工具条与时间轴一起退到窄屏形态」。
    // 同一档保留多个块是刻意的：块与块之间有先后，合并成一个块会改变层叠顺序。
    // 高度档不参与宽度阶梯——它管候选起始页在矮窗口里的纵向紧凑。
    const widths = [...new Set([...css.matchAll(/@media\(max-width:(\d+)px\)/g)].map((m) => Number(m[1])))];
    expect([...widths].sort((a, b) => a - b), '断点又长出了阶梯外的宽度档').toEqual([860, 1024, 1280]);
    const heights = [...new Set([...css.matchAll(/@media\(max-height:(\d+)px\)/g)].map((m) => Number(m[1])))];
    expect(heights, '高度档应只有一个，且明确不参与宽度阶梯').toEqual([700]);
    // 860 档把侧栏变成盖在内容上的抽屉，那它必须自带两条关闭路径：Esc 与遮罩点击。
    // 真实页面上量过：接这两条之前，抽屉点开只能再点页头那个按钮收回去，Esc 按了没反应。
    // 同一档有多个块（见上），因此按块收集而不是只取第一个。
    const blocksOf = (condition: string) =>
      [...css.matchAll(new RegExp(`@media\\(${condition}\\)\\{`, 'g'))].map((m) => {
        let depth = 1;
        let i = m.index + m[0].length;
        while (i < css.length && depth > 0) {
          if (css[i] === '{') depth += 1;
          else if (css[i] === '}') depth -= 1;
          i += 1;
        }
        return css.slice(m.index + m[0].length, i - 1);
      });
    const step860 = blocksOf('max-width:860px');
    expect(step860.length, '一个 860 档的块都没量到，扫描口径失效').toBeGreaterThan(0);
    expect(step860.join('\n'), '抽屉没有遮罩层：点内容区收不掉它').toContain('.studio-app.sidebar-open .studio-scrim{');
    expect(css, '遮罩在宽屏上也会显示：桌面态会被盖住').toContain('.studio-scrim{display:none}');
  });

  it('对话阅读正文取 16px 与 1.85 倍行高', () => {
    const reader = css.match(/\.observe-reading-message\{[^}]*\}/);
    expect(reader, '找不到对话阅读正文规则').not.toBeNull();
    expect(reader![0]).toContain('font-size:16px');
    expect(reader![0]).toContain('line-height:1.85');
  });
});
