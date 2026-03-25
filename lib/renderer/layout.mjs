import { I18N, DEFAULT_LANG, t } from './i18n.mjs';

function langToggleScript() {
  return `
  <script>
  var I18N = ${JSON.stringify(I18N)};
  function switchLang() {
    var cur = document.documentElement.dataset.lang || '${DEFAULT_LANG}';
    var next = cur === 'zh' ? 'en' : 'zh';
    document.documentElement.dataset.lang = next;
    document.querySelectorAll('[data-i18n]').forEach(function(el) {
      var key = el.dataset.i18n;
      if (I18N[next][key]) {
        if (el.tagName === 'INPUT') { el.placeholder = I18N[next][key]; }
        else { el.innerHTML = I18N[next][key]; }
      }
    });
    document.getElementById('lang-toggle').textContent = I18N[next].switchLang;
  }
  </script>`;
}

function langToggleButton(lang) {
  return `<button id="lang-toggle" onclick="switchLang()" style="position:fixed;top:16px;right:16px;padding:6px 14px;border:1px solid #e2e8f0;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;z-index:100">${t('switchLang', lang)}</button>`;
}

export function layout(title, body, lang = DEFAULT_LANG) {
  return `<!doctype html><html data-lang="${lang}"><head><meta charset="utf-8"><title>${title}</title>
<style>
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;padding:24px;background:#f8fafc;color:#1e293b}
h1{margin:0 0 4px;font-size:22px}
h2{margin:24px 0 12px;font-size:18px;color:#334155}
.subtitle{color:#64748b;font-size:14px;margin:0 0 20px}
a{color:#2563eb;text-decoration:none}
a:hover{text-decoration:underline}
.cards{display:flex;gap:16px;flex-wrap:wrap;margin:16px 0}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px 20px;min-width:180px;flex:1}
.card-label{font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px}
.card-value{font-size:28px;font-weight:700;margin:4px 0}
.card-sub{font-size:12px;color:#94a3b8}
table{border-collapse:collapse;width:100%;font-size:14px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden}
th{background:#f1f5f9;padding:10px 12px;text-align:left;font-weight:600;color:#475569;border-bottom:1px solid #e2e8f0}
td{padding:10px 12px;border-bottom:1px solid #f1f5f9}
tr:last-child td{border-bottom:none}
tr:hover td{background:#f8fafc}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600}
.badge-ok{background:#dcfce7;color:#166534}
.badge-err{background:#fee2e2;color:#991b1b}
.badge-pass{background:#dcfce7;color:#166534}
.badge-fail{background:#fee2e2;color:#991b1b}
.nav{margin-bottom:20px;font-size:14px}
.assertion-list{margin:4px 0;padding:0;list-style:none;font-size:12px}
.assertion-list li{margin:2px 0}
.dim-scores{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}
.dim-tag{font-size:11px;padding:2px 6px;border-radius:3px;background:#f1f5f9}
.dim-desc{font-size:13px;color:#94a3b8;font-weight:400;margin-left:8px}
</style></head><body>${langToggleButton(lang)}${body}${langToggleScript()}</body></html>`;
}
