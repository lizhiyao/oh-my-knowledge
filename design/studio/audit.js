/**
 * 代表页原型的自测脚本：只在 ?audit=1 时运行，把量测结果写进 <pre id="audit-report">。
 * 用 headless Chrome --dump-dom 读取，因此证据来自浏览器实际计算样式，不是人工声明。
 */
(function () {
  if (!/[?&]audit=1/.test(location.search)) return;

  var PAGE_ID = document.documentElement.getAttribute('data-audit-page') || location.pathname;

  function rgbOf(color) {
    var m = String(color).match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)/);
    if (!m) return null;
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  }

  function blend(fg, bg) {
    if (fg.a >= 1) return fg;
    return {
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1
    };
  }

  function luminance(c) {
    var ch = [c.r, c.g, c.b].map(function (v) {
      var s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }

  function ratio(fg, bg) {
    var a = luminance(fg), b = luminance(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }

  function backdropOf(el) {
    for (var node = el; node && node.nodeType === 1; node = node.parentElement) {
      var bg = rgbOf(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) return blend(bg, { r: 255, g: 255, b: 255, a: 1 });
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  }

  function label(el) {
    var cls = (el.className || '').toString().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
    return (el.tagName.toLowerCase() + (cls ? '.' + cls : '')).slice(0, 60);
  }

  function textNodes(el) {
    var out = [];
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (var n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeValue.trim() && n.parentElement) out.push(n.parentElement);
    }
    return out;
  }

  function exemptionOf(el, fg) {
    if (fg.a === 0) return '文字被隐去（加载态由 spinner 或骨架条承载，无前景色可比）';
    if (el.closest('.sr-only,[aria-hidden="true"]')) return '仅供屏幕阅读器，不参与视觉对比度';
    if (el.closest(':disabled,[aria-disabled="true"],.skeleton')) return '禁用态或骨架，WCAG 不设对比度要求';
    return null;
  }

  function auditContrast() {
    var results = [];
    var seen = new Set();
    document.querySelectorAll('[data-audit-contrast]').forEach(function (scope) {
      textNodes(scope).forEach(function (el) {
        if (seen.has(el)) return;
        seen.add(el);
        var cs = getComputedStyle(el);
        var fg = rgbOf(cs.color);
        if (!fg) return;
        var bg = backdropOf(el);
        var r = ratio(blend(fg, bg), bg);
        var px = parseFloat(cs.fontSize);
        var bold = parseInt(cs.fontWeight, 10) >= 700;
        var large = px >= 24 || (px >= 18.66 && bold);
        var need = large ? 3 : 4.5;
        results.push({
          element: label(el),
          text: el.textContent.trim().slice(0, 24),
          fontSize: Math.round(px * 10) / 10,
          ratio: Math.round(r * 100) / 100,
          required: need,
          pass: r >= need,
          exempt: exemptionOf(el, cs.visibility === 'hidden' ? { a: 0 } : fg)
        });
      });
    });
    return results;
  }

  function auditPageScroll() {
    var de = document.documentElement, b = document.body;
    return {
      viewport: { w: de.clientWidth, h: de.clientHeight },
      documentOverflowX: Math.max(de.scrollWidth, b.scrollWidth) - de.clientWidth,
      documentOverflowY: Math.max(de.scrollHeight, b.scrollHeight) - de.clientHeight,
      htmlOverflowX: getComputedStyle(de).overflowX,
      htmlOverflowY: getComputedStyle(de).overflowY
    };
  }

  function auditRegions() {
    var out = [];
    document.querySelectorAll('[data-audit-region]').forEach(function (el) {
      var cs = getComputedStyle(el);
      var canScrollX = /auto|scroll/.test(cs.overflowX);
      var canScrollY = /auto|scroll/.test(cs.overflowY);
      out.push({
        region: el.getAttribute('data-audit-region'),
        element: label(el),
        box: { w: el.clientWidth, h: el.clientHeight },
        content: { w: el.scrollWidth, h: el.scrollHeight },
        overflowX: el.scrollWidth - el.clientWidth,
        overflowY: el.scrollHeight - el.clientHeight,
        scrollableX: canScrollX,
        scrollableY: canScrollY,
        clippedX: el.scrollWidth > el.clientWidth + 1 && !canScrollX,
        clippedY: el.scrollHeight > el.clientHeight + 1 && !canScrollY && cs.overflowY === 'hidden'
      });
    });
    return out;
  }

  function auditTruncation() {
    var out = [];
    document.querySelectorAll('[data-audit-truncate]').forEach(function (el) {
      var truncated = el.scrollWidth > el.clientWidth + 1;
      var hint = el.getAttribute('title') || el.getAttribute('aria-describedby') || el.getAttribute('data-audit-detail');
      out.push({
        element: label(el),
        text: el.textContent.trim().slice(0, 24),
        truncated: truncated,
        hasFullContentPath: !!hint,
        pass: !truncated || !!hint
      });
    });
    return out;
  }

  function auditFocus() {
    var sel = 'a[href],button,input,select,textarea,summary,[tabindex]:not([tabindex="-1"])';
    var items = Array.prototype.slice.call(document.querySelectorAll(sel));
    return {
      count: items.length,
      nonNativeInteractive: Array.prototype.slice
        .call(document.querySelectorAll('[data-audit-role]'))
        .filter(function (el) {
          return !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(el.tagName) &&
            el.getAttribute('tabindex') === null;
        })
        .map(function (el) {
          return { element: label(el), role: el.getAttribute('data-audit-role') };
        }),
      order: items.map(function (el, i) {
        return {
          i: i,
          element: label(el),
          name: (el.getAttribute('aria-label') || el.textContent || el.value || '').trim().slice(0, 24)
        };
      })
    };
  }

  function auditOffenders() {
    var h = document.documentElement.clientHeight;
    var out = [];
    document.querySelectorAll('body *').forEach(function (el) {
      var box = el.getBoundingClientRect();
      if (box.height === 0 || box.bottom <= h + 1) return;
      var node = el.parentElement;
      while (node && node !== document.body) {
        var cs = getComputedStyle(node);
        if (/auto|scroll|hidden/.test(cs.overflowY) && node.clientHeight < node.scrollHeight) return;
        if (/auto|scroll|hidden/.test(cs.overflowY) && cs.overflowY === 'hidden') return;
        node = node.parentElement;
      }
      out.push({
        element: label(el),
        bottom: Math.round(box.bottom),
        viewport: h,
        text: (el.textContent || '').trim().slice(0, 20)
      });
    });
    return out.slice(0, 12);
  }

  function report() {
    var payload = {
      page: PAGE_ID,
      scroll: auditPageScroll(),
      regions: auditRegions(),
      offenders: auditOffenders(),
      contrast: auditContrast(),
      truncation: auditTruncation(),
      focus: auditFocus()
    };
    payload.verdict = {
      pageScrollClean: payload.scroll.documentOverflowX <= 0 && payload.scroll.documentOverflowY <= 0,
      clippedRegions: payload.regions.filter(function (r) { return r.clippedX || r.clippedY; }).map(function (r) { return r.region; }),
      contrastFails: payload.contrast.filter(function (c) { return !c.pass && !c.exempt; }).map(function (c) { return c.element + ' ' + c.ratio; }),
      contrastExempt: payload.contrast.filter(function (c) { return !c.pass && c.exempt; }).length,
      truncationFails: payload.truncation.filter(function (t) { return !t.pass; }).map(function (t) { return t.element; }),
      nonNativeInteractive: payload.focus.nonNativeInteractive
    };
    var slot = document.getElementById('audit-report');
    if (!slot) {
      slot = document.createElement('pre');
      slot.id = 'audit-report';
      document.body.appendChild(slot);
    }
    slot.textContent = JSON.stringify(payload, null, 2);
  }

  if (document.readyState === 'complete') report();
  else window.addEventListener('load', report);
})();
