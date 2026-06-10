// 由 omk-landing/index.html 的 <script> 抽取,包进 initLanding() 在 onMounted 调用。
// lang: 'zh' | 'en' —— 文案随站点 locale 切换(rail 说明、复制反馈)。
export function initLanding(lang) {
  const isZh = lang !== 'en';
  const COPIED = isZh ? '已复制 ✓' : 'Copied ✓';

  // 复制(兼容 http 局域网:clipboard API 不可用时用 execCommand 兜底)
  function omkCopy(text, el){
    const ok=()=>{ if(!el)return; const o=el.dataset.o||el.textContent; el.dataset.o=o; el.textContent=COPIED; setTimeout(()=>{el.textContent=o;},1500); };
    if(navigator.clipboard&&window.isSecureContext){
      navigator.clipboard.writeText(text).then(ok).catch(()=>fb(text,ok));
    } else { fb(text,ok); }
  }
  function fb(text,cb){
    const ta=document.createElement('textarea');
    ta.value=text; ta.style.position='fixed'; ta.style.top='-9999px'; ta.style.opacity='0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    try{ document.execCommand('copy'); }catch(e){}
    document.body.removeChild(ta); cb&&cb();
  }
  window.omkCopy=omkCopy;

  const order=['doctor','eval','observe'];
  const caps = isZh ? {
    doctor:'上线前体检 —— <b>这个 skill 本身写得健康吗？</b>',
    eval:'发布时 A/B —— <b>v2 真的比 v1 好吗？</b>',
    observe:'上线后观测 —— <b>线上跑得怎么样？哪里有缺口？</b>'
  } : {
    doctor:'Pre-ship checkup —— <b>is the skill itself written healthily?</b>',
    eval:'A/B on release —— <b>is v2 really better than v1?</b>',
    observe:'In-prod observation —— <b>how is it doing? where are the gaps?</b>'
  };
  const segs = document.querySelectorAll('.seg');
  const panels = document.querySelectorAll('.panel');
  const stTitle = document.getElementById('stTitle');
  const thumb = document.getElementById('thumb');
  const railCap = document.getElementById('railCap');
  function select(k){
    const active = order.indexOf(k);
    segs.forEach(n=>{
      const i = +n.dataset.i;
      n.setAttribute('aria-selected', i===active);
      n.classList.toggle('active', i===active);
      n.classList.toggle('done', i<active);
    });
    panels.forEach(p=>p.classList.toggle('on', p.dataset.p===k));
    stTitle.textContent = k;
    thumb.style.transform = `translateX(${active*100}%)`;
    thumb.classList.remove('liq'); void thumb.offsetWidth; thumb.classList.add('liq'); // 重触发液态回弹
    railCap.innerHTML = caps[k];
  }
  segs.forEach(n=>{
    n.addEventListener('click',()=>select(n.dataset.k));
    n.addEventListener('mouseenter',()=>select(n.dataset.k));
    n.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select(n.dataset.k)}});
  });
  select('eval');

  // gentle auto-rotate until first interaction;尊重 prefers-reduced-motion(不自动轮播)
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  let auto=true, i=1, t=null;
  if(!reduceMotion){
    t=setInterval(()=>{ if(!auto){clearInterval(t);t=null;return;} i=(i+1)%3; select(order[i]); },3200);
    const stage=document.querySelector('.stage');
    if(stage) stage.addEventListener('mouseenter',()=>auto=false,{once:true});
  }

  // 能力卡片滚动入场(逐张错峰);reduce-motion 时直接全部就位
  const grid = document.querySelector('.cap-grid');
  let io=null;
  if(grid){
    if(reduceMotion){
      grid.querySelectorAll('.cap').forEach(c=>c.classList.add('in'));
    } else {
      io = new IntersectionObserver((entries)=>{
        entries.forEach(e=>{
          if(e.isIntersecting){
            e.target.querySelectorAll('.cap').forEach((c,idx)=>setTimeout(()=>c.classList.add('in'), idx*110));
            io.unobserve(e.target);
          }
        });
      }, {threshold:.2});
      io.observe(grid);
    }
  }

  // 信任条:实时填 npm 周下载量(npm 官方 API,支持 CORS、无需 key);失败回退占位。
  (function(){
    var el = document.getElementById('npmDl');
    if(!el || !window.fetch) return;
    fetch('https://api.npmjs.org/downloads/point/last-week/oh-my-knowledge')
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(d){
        if(d && typeof d.downloads === 'number'){
          var n = d.downloads;
          el.textContent = n >= 1000
            ? (n/1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k'
            : String(n);
        } else { el.textContent = '↑'; }
      })
      .catch(function(){ el.textContent = '↑'; });
  })();

  // 卸载 / locale 切换时由 Landing.vue 调用,清理定时器与 observer,防泄漏。
  return function dispose(){ if(t){ clearInterval(t); t=null; } if(io){ io.disconnect(); io=null; } };
}
