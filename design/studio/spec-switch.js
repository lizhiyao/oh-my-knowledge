/* 原型工具条：切换目标规范与基线规范，选择记在 localStorage，仅供评审对照。 */
(function () {
  var fromUrl = new URLSearchParams(location.search).get('spec');
  var saved = null;
  try {
    saved = localStorage.getItem('omk-proto-spec');
  } catch (e) {
    saved = null;
  }
  /* URL 参数优先，命令行取证才能对同一页面分别跑两套规范档。 */
  var chosen = fromUrl === 'baseline' || fromUrl === 'target' ? fromUrl : saved;
  if (chosen === 'baseline' || chosen === 'target') {
    document.documentElement.setAttribute('data-spec', chosen);
  }

  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-spec-switch]');
    if (!button) return;
    var spec = button.getAttribute('data-spec-switch');
    document.documentElement.setAttribute('data-spec', spec);
    try {
      localStorage.setItem('omk-proto-spec', spec);
    } catch (e) {
      /* 隐私模式下不持久化，切换仍然生效 */
    }
  });
})();
