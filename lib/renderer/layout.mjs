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
  return `<button id="lang-toggle" onclick="switchLang()" style="position:fixed;top:16px;right:16px;padding:6px 14px;border:1px solid rgba(148,163,184,0.2);border-radius:8px;background:rgba(30,41,59,0.9);backdrop-filter:blur(8px);cursor:pointer;font-size:13px;z-index:100;color:#94a3b8">${t('switchLang', lang)}</button>`;
}

export function layout(title, body, lang = DEFAULT_LANG) {
  return `<!doctype html><html data-lang="${lang}"><head><meta charset="utf-8"><title>${title}</title>
<style>
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;padding:32px;background:#0f172a;color:#e2e8f0;min-height:100vh}
body::before{content:'';position:fixed;top:0;left:0;right:0;height:400px;background:linear-gradient(135deg,rgba(99,102,241,0.15),rgba(168,85,247,0.1),rgba(59,130,246,0.08));pointer-events:none;z-index:0}
h1{margin:0 0 4px;font-size:24px;font-weight:700;color:#f1f5f9;position:relative;z-index:1}
h2{margin:28px 0 12px;font-size:18px;color:#94a3b8;font-weight:600;position:relative;z-index:1}
.subtitle{color:#64748b;font-size:14px;margin:0 0 24px;position:relative;z-index:1}
a{color:#818cf8;text-decoration:none;transition:color 0.2s}
a:hover{color:#a5b4fc;text-decoration:underline}
.cards{display:flex;gap:16px;flex-wrap:wrap;margin:16px 0;position:relative;z-index:1}
.card{background:rgba(30,41,59,0.8);backdrop-filter:blur(12px);border:1px solid rgba(148,163,184,0.1);border-radius:12px;padding:20px 24px;min-width:180px;flex:1;transition:border-color 0.2s,box-shadow 0.2s}
.card:hover{border-color:rgba(129,140,248,0.3);box-shadow:0 0 20px rgba(99,102,241,0.1)}
.card-label{font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px}
.card-value{font-size:28px;font-weight:700;margin:4px 0;background:linear-gradient(135deg,#818cf8,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.card-sub{font-size:12px;color:#64748b}
table{border-collapse:collapse;width:100%;font-size:14px;background:rgba(30,41,59,0.6);backdrop-filter:blur(12px);border:1px solid rgba(148,163,184,0.1);border-radius:12px;overflow:hidden;position:relative;z-index:1}
th{background:rgba(15,23,42,0.6);padding:12px 14px;text-align:left;font-weight:600;color:#94a3b8;border-bottom:1px solid rgba(148,163,184,0.1);font-size:13px;text-transform:uppercase;letter-spacing:0.3px}
td{padding:12px 14px;border-bottom:1px solid rgba(148,163,184,0.06);color:#cbd5e1}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(99,102,241,0.04)}
.badge{display:inline-block;padding:3px 10px;border-radius:6px;font-size:12px;font-weight:600}
.badge-ok{background:rgba(34,197,94,0.15);color:#4ade80}
.badge-err{background:rgba(239,68,68,0.15);color:#f87171}
.badge-pass{background:rgba(34,197,94,0.15);color:#4ade80}
.badge-fail{background:rgba(239,68,68,0.15);color:#f87171}
.nav{margin-bottom:24px;font-size:14px;position:relative;z-index:1}
.assertion-list{margin:4px 0;padding:0;list-style:none;font-size:12px}
.assertion-list li{margin:2px 0;color:#94a3b8}
.dim-scores{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}
.dim-tag{font-size:11px;padding:3px 8px;border-radius:4px;background:rgba(99,102,241,0.1);color:#a5b4fc}
.dim-desc{font-size:13px;color:#64748b;font-weight:400;margin-left:8px}
input[type="text"]{background:rgba(30,41,59,0.8);border:1px solid rgba(148,163,184,0.2);color:#e2e8f0;border-radius:6px;padding:4px 8px}
input[type="text"]:focus{outline:none;border-color:rgba(129,140,248,0.5);box-shadow:0 0 0 2px rgba(99,102,241,0.15)}
button{background:rgba(30,41,59,0.8);border:1px solid rgba(148,163,184,0.2);color:#cbd5e1;border-radius:6px;cursor:pointer;transition:all 0.2s}
button:hover{border-color:rgba(129,140,248,0.4);background:rgba(99,102,241,0.1);color:#e2e8f0}
</style></head><body>${langToggleButton(lang)}${body}${langToggleScript()}</body></html>`;
}
