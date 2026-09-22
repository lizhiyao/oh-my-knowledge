/*
 * 窄屏侧栏抽屉的开关：≤859 时侧栏收成覆盖层，没有开关就等于分区导航不可达，
 * 所以原型必须把它做出来，才能让「窄屏布局与导航可达性」这项验证是真的量过，而不是声明。
 * Esc 关闭、点击遮罩关闭、关闭后焦点回到触发按钮。
 */
(function () {
  function ready() {
    var sidebar = document.querySelector('.sidebar');
    var toggle = document.querySelector('[data-drawer-toggle]');
    if (!sidebar || !toggle) return;

    var scrim = document.createElement('div');
    scrim.className = 'drawer-scrim';
    scrim.setAttribute('data-drawer-scrim', '');
    scrim.hidden = true;
    document.body.appendChild(scrim);

    function setOpen(open) {
      sidebar.setAttribute('data-open', open ? 'true' : 'false');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      scrim.hidden = !open;
    }

    toggle.addEventListener('click', function () {
      setOpen(toggle.getAttribute('aria-expanded') !== 'true');
    });

    scrim.addEventListener('click', function () {
      setOpen(false);
      toggle.focus();
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
        setOpen(false);
        toggle.focus();
      }
    });

    setOpen(false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ready);
  } else {
    ready();
  }
})();
