import type { Lang } from '../../../shared/language.js';

export function observationInboxClientScript(lang: Lang): string {
  return `
        var observeSeverityFilter = 'all';
        var inboxCurrentFilter = 'all';
        function selectInboxCard(id, el) {
          if (window.closeInboxSessionFlowPopover) window.closeInboxSessionFlowPopover();
          var cards = document.querySelectorAll('[data-inbox-card]');
          for (var i = 0; i < cards.length; i++) cards[i].classList.remove('is-active');
          if (el) el.classList.add('is-active');
          var panes = document.querySelectorAll('[data-inbox-detail]');
          var activePane = null;
          for (var j = 0; j < panes.length; j++) {
            var pane = panes[j];
            if (pane.getAttribute('data-inbox-detail') === id) {
              pane.classList.add('is-active');
              activePane = pane;
            } else {
              pane.classList.remove('is-active');
            }
          }
          if (activePane) applyInboxSessionSearchForPane(activePane);
          var right = document.querySelector('.inbox-right');
          if (right) right.scrollTop = 0;
        }
        function selectInboxCardById(id, sessionId) {
          var card = document.querySelector('[data-inbox-card="' + id + '"]');
          if (card) {
            selectInboxCard(id, card);
            if (sessionId) selectInboxSessionTab(id, sessionId);
            if (card.scrollIntoView) card.scrollIntoView({ block: 'nearest' });
          }
        }
        window.selectInboxCardById = selectInboxCardById;
        function closeInboxSessionFlowPopover() {
          var old = document.querySelector('.inbox-flow-popover');
          if (old) old.remove();
        }
        function openInboxSessionFlowPopover(templateId, btn, event) {
          if (event) {
            event.preventDefault();
            event.stopPropagation();
          }
          closeInboxSessionFlowPopover();
          var template = document.getElementById(templateId);
          if (!template) return;
          var popover = document.createElement('div');
          popover.className = 'inbox-flow-popover';
          popover.setAttribute('role', 'dialog');
          popover.innerHTML = '<button type="button" class="inbox-flow-popover-close" onclick="closeInboxSessionFlowPopover()">关闭</button>' + template.innerHTML;
          document.body.appendChild(popover);
          var rect = btn && btn.getBoundingClientRect ? btn.getBoundingClientRect() : { left: 16, bottom: 48, right: 16 };
          var width = Math.min(560, window.innerWidth - 32);
          var left = Math.min(Math.max(16, rect.right - width), window.innerWidth - width - 16);
          var top = Math.min(rect.bottom + 8, window.innerHeight - Math.min(popover.offsetHeight || 620, 620) - 16);
          popover.style.left = left + 'px';
          popover.style.top = Math.max(16, top) + 'px';
        }
        window.closeInboxSessionFlowPopover = closeInboxSessionFlowPopover;
        window.openInboxSessionFlowPopover = openInboxSessionFlowPopover;
        function toggleInboxSection(btn) {
          var sec = btn.closest('.inbox-section');
          if (!sec) return;
          var collapsed = sec.classList.toggle('is-collapsed');
          var label = sec.querySelector('.inbox-section-toggle');
          if (label) label.textContent = collapsed ? '展开' : '收起';
        }
        function toggleInboxSectionHead(head) {
          var sec = head && head.closest ? head.closest('.inbox-section') : null;
          if (!sec) return;
          var collapsed = sec.classList.toggle('is-collapsed');
          var label = sec.querySelector('.inbox-section-toggle');
          if (label) label.textContent = collapsed ? '展开' : '收起';
        }
        function findInboxSectionById(id) {
          var activePane = document.querySelector('.inbox-detail-pane.is-active .inbox-session-pane.is-active');
          if (activePane) {
            var nodes = activePane.querySelectorAll('[id]');
            for (var i = 0; i < nodes.length; i++) {
              if (nodes[i].getAttribute('id') === id) return nodes[i];
            }
          }
          return document.getElementById(id);
        }
        function scrollInboxSectionIntoView(id, event) {
          if (event) event.preventDefault();
          var sec = findInboxSectionById(id);
          if (!sec) return;
          if (sec.tagName === 'DETAILS' && !sec.open) sec.open = true;
          var parentSection = sec.classList && sec.classList.contains('inbox-section') ? sec : (sec.closest ? sec.closest('.inbox-section') : null);
          if (parentSection && parentSection.classList.contains('is-collapsed')) {
            parentSection.classList.remove('is-collapsed');
            var toggle = parentSection.querySelector('.inbox-section-toggle');
            if (toggle) toggle.textContent = '收起';
          }
          var parentDetails = sec.closest ? sec.closest('details') : null;
          if (parentDetails && !parentDetails.open) parentDetails.open = true;
          var right = sec.closest ? sec.closest('.inbox-right') : document.querySelector('.inbox-right');
          var canScrollRight = right && right.scrollHeight > right.clientHeight + 8 && window.getComputedStyle(right).overflowY !== 'visible';
          if (canScrollRight) {
            var rect = sec.getBoundingClientRect();
            var rightRect = right.getBoundingClientRect();
            right.scrollTop += rect.top - rightRect.top - 8;
          } else {
            var top = sec.getBoundingClientRect().top + (window.pageYOffset || document.documentElement.scrollTop || 0) - 88;
            window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
          }
          var activeDetail = sec.closest ? sec.closest('.inbox-detail-pane') : null;
          var navs = activeDetail ? activeDetail.querySelectorAll('[data-inbox-nav]') : document.querySelectorAll('[data-inbox-nav]');
          for (var i = 0; i < navs.length; i++) {
            var match = navs[i].getAttribute('href') === '#' + id;
            if (match) navs[i].classList.add('is-active');
            else navs[i].classList.remove('is-active');
          }
        }
        function inboxJumpToEvidence(btn) {
          var pane = btn && btn.closest ? btn.closest('.inbox-detail-pane') : null;
          if (!pane) return;
          var sessionPane = btn.closest ? btn.closest('[data-session-pane]') : null;
          var sid = sessionPane ? sessionPane.getAttribute('data-session-pane') : pane.getAttribute('data-inbox-detail');
          if (sid) scrollInboxSectionIntoView('inbox-sec-evidence-' + sid);
          var messageUuid = btn.getAttribute('data-jump-message-uuid') || '';
          var messageIndex = btn.getAttribute('data-jump-message-index') || '';
          if (!messageUuid && !messageIndex) return;
          window.setTimeout(function () {
            var rows = pane.querySelectorAll('[data-message-uuid]');
            for (var i = 0; i < rows.length; i++) {
              var row = rows[i];
              if (messageUuid && row.getAttribute('data-message-uuid') === messageUuid) {
                row.scrollIntoView({ block: 'center' });
                row.classList.add('is-flash');
                window.setTimeout(function () { row.classList.remove('is-flash'); }, 1600);
                return;
              }
              if (!messageUuid && messageIndex && row.getAttribute('data-message-index') === messageIndex) {
                row.scrollIntoView({ block: 'center' });
                row.classList.add('is-flash');
                window.setTimeout(function () { row.classList.remove('is-flash'); }, 1600);
                return;
              }
            }
          }, 240);
        }
        window.toggleInboxSection = toggleInboxSection;
        window.toggleInboxSectionHead = toggleInboxSectionHead;
        window.scrollInboxSectionIntoView = scrollInboxSectionIntoView;
        window.inboxJumpToEvidence = inboxJumpToEvidence;
        function selectInboxSessionTab(skillName, sessionId, btn) {
          if (window.closeInboxSessionFlowPopover) window.closeInboxSessionFlowPopover();
          var pane = document.querySelector('[data-inbox-detail="' + skillName + '"]');
          if (!pane) return;
          var tabs = pane.querySelectorAll('[data-session-tab]');
          for (var i = 0; i < tabs.length; i++) {
            if (tabs[i].getAttribute('data-session-tab') === sessionId) tabs[i].classList.add('is-active');
            else tabs[i].classList.remove('is-active');
          }
          var panes = pane.querySelectorAll('[data-session-pane]');
          for (var j = 0; j < panes.length; j++) {
            if (panes[j].getAttribute('data-session-pane') === sessionId) panes[j].classList.add('is-active');
            else panes[j].classList.remove('is-active');
          }
        }
        window.selectInboxSessionTab = selectInboxSessionTab;
        function openInboxMetricPopover(card) {
          var popover = document.getElementById('inbox-metric-popover');
          if (!popover) return;
          var label = card.getAttribute('data-metric-label') || '';
          var value = card.getAttribute('data-metric-value') || '0';
          var note = card.getAttribute('data-metric-note') || '';
          var anomaly = card.getAttribute('data-metric-anomaly') === '1';
          var jumpId = card.getAttribute('data-metric-jump') || '';
          var detail = [];
          try { detail = JSON.parse(card.getAttribute('data-metric-detail') || '[]'); } catch (err) { detail = []; }
          var html = '<header class="inbox-metric-popover-head"><strong></strong><button type="button" class="inbox-metric-popover-close" aria-label="关闭">关闭</button></header>';
          html += '<div class="inbox-metric-popover-body">';
          html += '<div class="inbox-metric-popover-value' + (anomaly ? ' is-anomaly' : '') + '"></div>';
          html += '<p class="inbox-metric-popover-note"></p>';
          if (detail && detail.length > 0) {
            html += '<ul class="inbox-metric-popover-list"></ul>';
          }
          if (anomaly && jumpId) {
            html += '<button type="button" class="inbox-metric-popover-jump" data-jump-target="' + jumpId + '">跳转原文回溯</button>';
          }
          html += '</div>';
          popover.innerHTML = html;
          popover.querySelector('.inbox-metric-popover-head strong').textContent = label;
          popover.querySelector('.inbox-metric-popover-value').textContent = value;
          popover.querySelector('.inbox-metric-popover-note').textContent = note;
          var list = popover.querySelector('.inbox-metric-popover-list');
          if (list && detail.length > 0) {
            for (var i = 0; i < detail.length; i++) {
              var li = document.createElement('li');
              var n = document.createElement('span');
              n.textContent = detail[i].name;
              var c = document.createElement('span');
              c.textContent = detail[i].count;
              li.appendChild(n);
              li.appendChild(c);
              list.appendChild(li);
            }
          }
          popover.classList.add('is-open');
          popover.setAttribute('aria-hidden', 'false');
          var closeBtn = popover.querySelector('.inbox-metric-popover-close');
          if (closeBtn) closeBtn.addEventListener('click', closeInboxMetricPopover);
          var jumpBtn = popover.querySelector('.inbox-metric-popover-jump');
          if (jumpBtn) jumpBtn.addEventListener('click', function () {
            var id = jumpBtn.getAttribute('data-jump-target');
            if (id) scrollInboxSectionIntoView(id);
            closeInboxMetricPopover();
          });
        }
        function closeInboxMetricPopover() {
          var popover = document.getElementById('inbox-metric-popover');
          if (!popover) return;
          popover.classList.remove('is-open');
          popover.setAttribute('aria-hidden', 'true');
          popover.innerHTML = '';
        }
        document.addEventListener('click', function (event) {
          var target = event.target;
          if (target && target.closest && (target.closest('.inbox-metric-card') || target.closest('#inbox-metric-popover'))) return;
          var popover = document.getElementById('inbox-metric-popover');
          if (popover && popover.classList.contains('is-open')) closeInboxMetricPopover();
        });
        document.addEventListener('keydown', function (event) {
          if (event.key === 'Escape') closeInboxMetricPopover();
        });
        window.openInboxMetricPopover = openInboxMetricPopover;
        window.closeInboxMetricPopover = closeInboxMetricPopover;
        function inboxNormalizeSearch(value) {
          return String(value || '').trim().toLowerCase();
        }
        function inboxSearchInput(selector) {
          var input = document.querySelector(selector);
          return input ? inboxNormalizeSearch(input.value) : '';
        }
        function inboxTextMatches(text, query) {
          if (!query) return true;
          return inboxNormalizeSearch(text).indexOf(query) >= 0;
        }
        function activeInboxSearch() {
          return {
            skill: inboxSearchInput('[data-inbox-skill-search-input]'),
            session: inboxSearchInput('[data-inbox-session-search-input]')
          };
        }
        function inboxCardMatchesCurrentSearch(card, search) {
          var filters = (card.getAttribute('data-inbox-filters') || '').split(/\\s+/);
          var filterMatch = filters.indexOf(inboxCurrentFilter) >= 0;
          var skillMatch = inboxTextMatches(card.getAttribute('data-inbox-skill-search') || card.getAttribute('data-inbox-card') || '', search.skill);
          var sessionMatch = inboxTextMatches(card.getAttribute('data-inbox-session-search') || '', search.session);
          return filterMatch && skillMatch && sessionMatch;
        }
        function setInboxNoResultVisible(visible) {
          var empty = document.querySelector('[data-inbox-no-results]');
          if (empty) empty.style.display = visible ? '' : 'none';
        }
        function updateInboxSearchCount(visibleCount, totalCount) {
          var el = document.querySelector('[data-inbox-search-count]');
          if (!el) return;
          var search = activeInboxSearch();
          var searching = Boolean(search.skill || search.session || inboxCurrentFilter !== 'all');
          el.textContent = searching ? visibleCount + ' / ' + totalCount + ' 条复盘' : totalCount + ' 条复盘';
        }
        function clearInboxActiveSelection() {
          var cards = document.querySelectorAll('[data-inbox-card]');
          for (var i = 0; i < cards.length; i++) cards[i].classList.remove('is-active');
          var panes = document.querySelectorAll('[data-inbox-detail]');
          for (var j = 0; j < panes.length; j++) panes[j].classList.remove('is-active');
        }
        function applyInboxSessionSearchForPane(pane) {
          if (!pane) return;
          var query = inboxSearchInput('[data-inbox-session-search-input]');
          var tabItems = pane.querySelectorAll('[data-session-tab-item]');
          var sessionPanes = pane.querySelectorAll('[data-session-pane]');
          var firstVisibleTab = null;
          var activeVisible = null;
          for (var i = 0; i < tabItems.length; i++) {
            var item = tabItems[i];
            var text = item.getAttribute('data-session-search') || '';
            var visible = inboxTextMatches(text, query);
            item.style.display = visible ? '' : 'none';
            var tab = item.querySelector('[data-session-tab]');
            if (visible && !firstVisibleTab) firstVisibleTab = tab;
            if (visible && tab && tab.classList.contains('is-active')) activeVisible = tab;
          }
          for (var j = 0; j < sessionPanes.length; j++) {
            var sessionPane = sessionPanes[j];
            var paneText = sessionPane.getAttribute('data-session-search') || '';
            var paneVisible = inboxTextMatches(paneText, query);
            sessionPane.style.display = paneVisible ? '' : 'none';
            if (!paneVisible) sessionPane.classList.remove('is-active');
          }
          var nextTab = activeVisible || firstVisibleTab;
          if (nextTab) {
            selectInboxSessionTab(pane.getAttribute('data-inbox-detail') || '', nextTab.getAttribute('data-session-tab'), nextTab);
          }
        }
        function applyInboxFilters() {
          var cards = document.querySelectorAll('[data-inbox-card]');
          var search = activeInboxSearch();
          var firstVisible = null;
          var activeVisible = null;
          var visibleCount = 0;
          for (var i = 0; i < cards.length; i++) {
            var card = cards[i];
            var visible = inboxCardMatchesCurrentSearch(card, search);
            card.style.display = visible ? '' : 'none';
            if (visible) {
              visibleCount += 1;
              if (!firstVisible) firstVisible = card;
              if (card.classList.contains('is-active')) activeVisible = card;
            }
          }
          updateInboxSearchCount(visibleCount, cards.length);
          setInboxNoResultVisible(visibleCount === 0);
          if (visibleCount === 0) {
            clearInboxActiveSelection();
            return;
          }
          selectInboxCard((activeVisible || firstVisible).getAttribute('data-inbox-card'), activeVisible || firstVisible);
        }
        function clearInboxSearch() {
          var skill = document.querySelector('[data-inbox-skill-search-input]');
          var session = document.querySelector('[data-inbox-session-search-input]');
          if (skill) skill.value = '';
          if (session) session.value = '';
          applyInboxFilters();
        }
        function setInboxFilter(filter, btn) {
          inboxCurrentFilter = filter;
          var chips = document.querySelectorAll('[data-inbox-filter]');
          for (var i = 0; i < chips.length; i++) {
            var active = chips[i].getAttribute('data-inbox-filter') === filter;
            if (active) chips[i].classList.add('is-active');
            else chips[i].classList.remove('is-active');
          }
          applyInboxFilters();
        }
        window.applyInboxFilters = applyInboxFilters;
        window.clearInboxSearch = clearInboxSearch;
        async function setInboxSessionReview(sessionId, verdict, btn) {
          var actionBlock = document.querySelector('[data-inbox-detail-actions][data-inbox-session-id="' + sessionId + '"]');
          var note = '';
          if (verdict === 'needs_more_context') {
            var input = document.querySelector('[data-inbox-note-input="' + sessionId + '"]');
            note = input ? input.value : '';
          }
          try {
            var payload = { targetType: 'experience_session', targetId: sessionId, verdict: verdict };
            if (note) payload.reason = note;
            var resp = await fetch('/api/observe-inbox/review-state', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
            if (!resp.ok) throw new Error('failed');
            if (actionBlock) {
              var buttons = actionBlock.querySelectorAll('.inbox-action-button');
              for (var i = 0; i < buttons.length; i++) {
                if (buttons[i].getAttribute('data-inbox-verdict') === verdict) buttons[i].classList.add('is-active');
                else buttons[i].classList.remove('is-active');
              }
              var summary = actionBlock.querySelector('.inbox-section-review-button');
              if (summary) summary.textContent = '人工标注(1)';
            }
            var currentPane = actionBlock && actionBlock.closest ? actionBlock.closest('[data-inbox-detail]') : null;
            var cardId = currentPane ? currentPane.getAttribute('data-inbox-detail') : sessionId;
            var card = document.querySelector('[data-inbox-card="' + cardId + '"]');
            if (card) {
              var filters = (card.getAttribute('data-inbox-filters') || '').split(/\\s+/);
              if (filters.indexOf('reviewed') < 0) filters.push('reviewed');
              card.setAttribute('data-inbox-filters', filters.join(' '));
              var existing = card.querySelector('.inbox-card-state');
              if (existing) existing.remove();
              var labels = { real_issue: { label: '已同意', cls: 'is-agree' }, not_issue: { label: '已否决', cls: 'is-reject' }, needs_more_context: { label: '留意见', cls: 'is-note' } };
              var meta = labels[verdict];
              if (meta) {
                var span = document.createElement('span');
                span.className = 'inbox-card-state ' + meta.cls;
                span.textContent = meta.label;
                var titleRow = card.querySelector('.inbox-card-row-title');
                if (titleRow) titleRow.appendChild(span);
              }
            }
          } catch (err) {
            if (window.console) console.error('inbox review failed', err);
          }
        }
        function toggleInboxNoteEditor(sessionId, btn) {
          var editor = document.querySelector('[data-inbox-note-editor="' + sessionId + '"]');
          if (!editor) return;
          editor.style.display = 'block';
          var input = editor.querySelector('textarea');
          if (input) input.focus();
        }
        function closeInboxNoteEditor(sessionId) {
          var editor = document.querySelector('[data-inbox-note-editor="' + sessionId + '"]');
          if (editor) editor.style.display = 'none';
        }
        function saveInboxSessionNote(sessionId, btn) {
          setInboxSessionReview(sessionId, 'needs_more_context', btn);
        }
        window.selectInboxCard = selectInboxCard;
        window.setInboxFilter = setInboxFilter;
        window.setInboxSessionReview = setInboxSessionReview;
        window.toggleInboxNoteEditor = toggleInboxNoteEditor;
        window.closeInboxNoteEditor = closeInboxNoteEditor;
        window.saveInboxSessionNote = saveInboxSessionNote;
        function showObservationTab(name) {
          var review = document.getElementById('observe-tab-review');
          var raw = document.getElementById('observe-tab-raw');
          if (review) review.style.display = name === 'review' ? '' : 'none';
          if (raw) raw.style.display = name === 'raw' ? '' : 'none';
          var buttons = document.querySelectorAll('[data-observe-tab-button]');
          for (var i = 0; i < buttons.length; i++) {
            var active = buttons[i].getAttribute('data-observe-tab-button') === name;
            buttons[i].style.background = active ? 'var(--bg-surface)' : 'var(--bg)';
            buttons[i].style.fontWeight = active ? '600' : '400';
          }
        }
        function toggleObservationDetail(id, btn) {
          var row = document.getElementById(id);
          if (!row) return;
          var open = row.style.display !== 'none';
          row.style.display = open ? 'none' : 'table-row';
          if (btn) btn.textContent = open ? '${lang === 'zh' ? '展开' : 'Details'}' : '${lang === 'zh' ? '收起' : 'Hide'}';
        }
        function closeExperienceDetailModal() {
          var modal = document.getElementById('experience-detail-modal');
          if (!modal) return;
          if (window.closeGoalSliceCorrectionPopovers) window.closeGoalSliceCorrectionPopovers();
          modal.classList.remove('is-open');
          modal.setAttribute('aria-hidden', 'true');
          modal.innerHTML = '';
        }
        function openExperienceDetailModal(id, btn, initialTab) {
          var row = document.getElementById(id);
          var modal = document.getElementById('experience-detail-modal');
          if (!row || !modal) return;
          var cell = row.querySelector('td');
          if (!cell) return;
          var title = 'Session 回溯详情';
          var sessionRow = btn && btn.closest ? btn.closest('tr') : null;
          var sessionCell = sessionRow ? sessionRow.children[1] : null;
          if (sessionCell) title = 'Session 回溯详情 · ' + (sessionCell.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 96);
          modal.innerHTML = '<div class="experience-detail-dialog" role="document"><div class="experience-detail-modal-header"><div class="experience-detail-modal-title"></div><button type="button" class="experience-detail-modal-close" data-experience-detail-close>关闭</button></div><div class="experience-detail-modal-body"></div></div>';
          modal.querySelector('.experience-detail-modal-title').textContent = title;
          modal.querySelector('.experience-detail-modal-body').innerHTML = cell.innerHTML;
          var close = modal.querySelector('[data-experience-detail-close]');
          if (close) close.addEventListener('click', function (event) {
            event.stopPropagation();
            closeExperienceDetailModal();
          });
          modal.classList.add('is-open');
          modal.setAttribute('aria-hidden', 'false');
          if (close && close.focus) close.focus();
          window.requestAnimationFrame(function () {
            if (initialTab) switchExperienceDetailTab(initialTab);
            var tabs = modal.querySelectorAll('[data-timeline-tabs]');
            for (var i = 0; i < tabs.length; i++) {
              var base = tabs[i].getAttribute('data-timeline-tabs');
              if (base) switchTimelineGoalTab(base, 0);
            }
            if (window.refreshTimelineFullTextState) window.refreshTimelineFullTextState();
          });
        }
        function openContextChainModal(id, btn) {
          var row = document.getElementById(id);
          var modal = document.getElementById('experience-detail-modal');
          if (!row || !modal) return;
          var cell = row.querySelector('td');
          if (!cell) return;
          var title = 'Context Chain';
          var skillRow = btn && btn.closest ? btn.closest('tr') : null;
          var skillCell = skillRow ? skillRow.children[0] : null;
          if (skillCell) title = 'Context Chain · ' + (skillCell.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 96);
          modal.innerHTML = '<div class="experience-detail-dialog" role="document"><div class="experience-detail-modal-header"><div class="experience-detail-modal-title"></div><button type="button" class="experience-detail-modal-close" data-experience-detail-close>关闭</button></div><div class="experience-detail-modal-body"></div></div>';
          modal.querySelector('.experience-detail-modal-title').textContent = title;
          modal.querySelector('.experience-detail-modal-body').innerHTML = cell.innerHTML;
          var close = modal.querySelector('[data-experience-detail-close]');
          if (close) close.addEventListener('click', function (event) {
            event.stopPropagation();
            closeExperienceDetailModal();
          });
          modal.classList.add('is-open');
          modal.setAttribute('aria-hidden', 'false');
          if (close && close.focus) close.focus();
        }
        function switchExperienceDetailTab(name) {
          var modal = document.getElementById('experience-detail-modal');
          if (!modal) return;
          var buttons = modal.querySelectorAll('[data-experience-detail-tab]');
          var panels = modal.querySelectorAll('[data-experience-detail-panel]');
          if (!buttons.length || !panels.length) return;
          for (var i = 0; i < buttons.length; i++) {
            var activeButton = buttons[i].getAttribute('data-experience-detail-tab') === name;
            buttons[i].classList.toggle('is-active', activeButton);
            buttons[i].setAttribute('aria-selected', activeButton ? 'true' : 'false');
          }
          for (var j = 0; j < panels.length; j++) {
            panels[j].classList.toggle('is-active', panels[j].getAttribute('data-experience-detail-panel') === name);
          }
          if (name === 'evidence') {
            window.requestAnimationFrame(function () {
              if (window.refreshTimelineFullTextState) window.refreshTimelineFullTextState();
            });
          }
        }
        function switchTimelineGoalTab(tabBaseId, index) {
          var selector = '[data-timeline-tabs="' + tabBaseId.replace(/"/g, '\\"') + '"]';
          var modal = document.getElementById('experience-detail-modal');
          var root = modal && modal.classList.contains('is-open') ? modal.querySelector(selector) : null;
          if (!root) root = document.querySelector(selector);
          if (!root) return;
          var buttons = root.querySelectorAll('[data-timeline-tab]');
          var panels = root.querySelectorAll('[data-timeline-panel]');
          var target = tabBaseId + '-' + index;
          for (var i = 0; i < buttons.length; i++) {
            var active = buttons[i].getAttribute('data-timeline-tab') === target;
            buttons[i].classList.toggle('is-active', active);
            buttons[i].setAttribute('aria-selected', active ? 'true' : 'false');
          }
          for (var j = 0; j < panels.length; j++) {
            panels[j].classList.toggle('is-active', panels[j].getAttribute('data-timeline-panel') === target);
          }
          var toolbar = root.closest ? root.closest('.experience-detail-right') : null;
          var select = toolbar ? toolbar.querySelector('[data-timeline-tag-filter]') : null;
          if (select) filterTimelineByTag(select);
        }
        function toggleFullSessionTimeline(btn) {
          var root = btn && btn.closest ? btn.closest('.experience-detail-right') : null;
          if (!root) return;
          var segment = root.querySelector('[data-timeline-view="segment"]');
          var full = root.querySelector('[data-timeline-view="full-session"]');
          if (!segment || !full) return;
          var showFull = full.style.display === 'none';
          full.style.display = showFull ? '' : 'none';
          segment.style.display = showFull ? 'none' : '';
          btn.textContent = showFull ? '返回 skill 窗口时间线' : '查看完整 session 时间线';
          window.requestAnimationFrame(function () {
            var tabs = root.querySelectorAll('[data-timeline-tabs]');
            for (var i = 0; i < tabs.length; i++) {
              var base = tabs[i].getAttribute('data-timeline-tabs');
              if (base) switchTimelineGoalTab(base, 0);
            }
            var select = root.querySelector('[data-timeline-tag-filter]');
            if (select) filterTimelineByTag(select);
            if (window.refreshTimelineFullTextState) window.refreshTimelineFullTextState();
          });
        }
        function filterTimelineByTag(select) {
          var root = select && select.closest ? select.closest('.experience-detail-right') : null;
          if (!root) root = document;
          var value = select ? String(select.value || '') : '';
          var rows = root.querySelectorAll('.timeline-row');
          var markers = root.querySelectorAll('.timeline-window-marker');
          var count = 0;
          for (var i = 0; i < rows.length; i++) {
            var tags = String(rows[i].getAttribute('data-timeline-tags') || '').split(/\\s+/);
            var match = !value || tags.indexOf(value) !== -1;
            rows[i].classList.toggle('is-filter-hidden', !match);
            rows[i].classList.toggle('is-filter-match', Boolean(value && match));
            if (match && value) count += 1;
          }
          for (var j = 0; j < markers.length; j++) {
            markers[j].style.display = value ? 'none' : '';
          }
          var text = root.querySelector('[data-timeline-filter-count]');
          if (text) text.textContent = value ? ('命中 ' + count + ' 条；只统计当前 skill 相关标签。') : '选择标签后，只显示当前回溯里的命中事件。';
        }
        function findExperienceTimelineRow(root, messageIndex, messageUuid) {
          if (!root) return null;
          var rows = root.querySelectorAll('.timeline-row');
          if (messageUuid) {
            for (var i = 0; i < rows.length; i++) {
              if (rows[i].getAttribute('data-message-uuid') === messageUuid) return rows[i];
            }
          }
          if (messageIndex !== '') {
            for (var j = 0; j < rows.length; j++) {
              if (rows[j].getAttribute('data-message-index') === String(messageIndex)) return rows[j];
            }
          }
          return null;
        }
        function focusExperienceTimelineRow(row) {
          if (!row) return;
          var fullView = row.closest ? row.closest('[data-timeline-view="full-session"]') : null;
          if (fullView && fullView.style.display === 'none') {
            var right = fullView.closest ? fullView.closest('.experience-detail-right') : null;
            var toggle = right ? right.querySelector('[data-full-session-toggle]') : null;
            if (toggle) toggleFullSessionTimeline(toggle);
          }
          var panel = row.closest ? row.closest('.timeline-tab-panel') : null;
          if (panel && !panel.classList.contains('is-active')) {
            var tabsRoot = panel.closest('[data-timeline-tabs]');
            var base = tabsRoot ? tabsRoot.getAttribute('data-timeline-tabs') : '';
            var panelId = panel.getAttribute('data-timeline-panel') || '';
            if (base && panelId.indexOf(base + '-') === 0) {
              var index = Number(panelId.slice(base.length + 1));
              if (!Number.isNaN(index)) switchTimelineGoalTab(base, index);
            }
          }
          window.requestAnimationFrame(function () {
            row.classList.add('is-cta-focus');
            if (row.scrollIntoView) row.scrollIntoView({ block: 'center', inline: 'nearest' });
            var scrollPanel = row.closest ? (row.closest('.timeline-tab-panel') || row.closest('.session-timeline-tree') || row.closest('.experience-detail-tab-panel')) : null;
            if (scrollPanel && typeof row.offsetTop === 'number') {
              scrollPanel.scrollTop = Math.max(0, row.offsetTop - 80);
            }
            window.setTimeout(function () { row.classList.remove('is-cta-focus'); }, 1800);
          });
        }
        function jumpToExperienceMessage(btn) {
          var modal = document.getElementById('experience-detail-modal');
          if (!modal || !btn) return;
          switchExperienceDetailTab('evidence');
          window.requestAnimationFrame(function () {
            var evidencePanel = modal.querySelector('[data-experience-detail-panel="evidence"]') || modal;
            var messageIndex = btn.getAttribute('data-jump-message-index') || '';
            var messageUuid = btn.getAttribute('data-jump-message-uuid') || '';
            var segmentView = evidencePanel.querySelector('[data-timeline-view="segment"]');
            var row = findExperienceTimelineRow(segmentView, messageIndex, messageUuid) || findExperienceTimelineRow(evidencePanel, messageIndex, messageUuid);
            focusExperienceTimelineRow(row);
          });
        }
        function openExperienceSessionById(sessionId, tag) {
          if (!sessionId) return;
          var rows = document.querySelectorAll('[data-observe-experience-session]');
          var row = null;
          for (var i = 0; i < rows.length; i++) {
            if (rows[i].getAttribute('data-experience-session-id') === sessionId) {
              row = rows[i];
              break;
            }
          }
          if (!row) return;
          var details = row.closest ? row.closest('details') : null;
          if (details) details.open = true;
          var top = row.getBoundingClientRect().top + window.pageYOffset - 90;
          window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
          var button = row.querySelector('[data-open-experience-detail]');
          if (button) button.click();
          window.setTimeout(function () {
            var modal = document.getElementById('experience-detail-modal');
            if (!modal || !modal.classList.contains('is-open')) return;
            if (tag) switchExperienceDetailTab('evidence');
            var evidencePanel = modal.querySelector('[data-experience-detail-panel="evidence"]') || modal;
            var select = evidencePanel.querySelector('[data-timeline-tag-filter]');
            if (select && tag) {
              select.value = tag;
              filterTimelineByTag(select);
            }
            var target = tag ? evidencePanel.querySelector('.timeline-row.is-filter-match') : evidencePanel.querySelector('.timeline-row');
            if (!target) return;
            focusExperienceTimelineRow(target);
          }, 160);
        }
        window.openExperienceDetailModal = openExperienceDetailModal;
        window.openContextChainModal = openContextChainModal;
        window.closeExperienceDetailModal = closeExperienceDetailModal;
        window.switchExperienceDetailTab = switchExperienceDetailTab;
        window.setReviewerJudgmentReview = setReviewerJudgmentReview;
        window.openReviewerJudgmentNote = openReviewerJudgmentNote;
        window.setSoftStandardStatus = setSoftStandardStatus;
        window.switchTimelineGoalTab = switchTimelineGoalTab;
        window.toggleFullSessionTimeline = toggleFullSessionTimeline;
        window.filterTimelineByTag = filterTimelineByTag;
        window.jumpToExperienceMessage = jumpToExperienceMessage;
        window.openExperienceSessionById = openExperienceSessionById;
        (function setupExperienceDetailModal() {
          var modal = document.getElementById('experience-detail-modal');
          if (!modal) return;
          modal.addEventListener('click', function (event) {
            if (event.target === modal) closeExperienceDetailModal();
          });
          document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && modal.classList.contains('is-open')) closeExperienceDetailModal();
          });
        })();
        document.addEventListener('click', function (event) {
          var target = event.target;
          var trigger = target && target.closest ? target.closest('[data-open-experience-session]') : null;
          if (!trigger) return;
          event.preventDefault();
          event.stopPropagation();
          openExperienceSessionById(trigger.getAttribute('data-open-experience-session'), trigger.getAttribute('data-open-timeline-tag') || '');
        });
        // 复制 advisory 命令到剪贴板：data-copy-source 上挂命令文本。
        document.addEventListener('click', function (event) {
          var target = event.target;
          var btn = target && target.closest ? target.closest('[data-copy-source]') : null;
          if (!btn) return;
          event.preventDefault();
          event.stopPropagation();
          var cmd = btn.getAttribute('data-copy-source') || '';
          var done = function () {
            var prev = btn.textContent;
            btn.classList.add('is-copied');
            btn.textContent = '已复制';
            setTimeout(function () {
              btn.classList.remove('is-copied');
              btn.textContent = prev;
            }, 1500);
          };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(cmd).then(done).catch(function () {
              fallbackCopy(cmd); done();
            });
          } else {
            fallbackCopy(cmd); done();
          }
        });
        function fallbackCopy(text) {
          try {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
          } catch (err) {}
        }
        function toggleScoringGuide(btn) {
          var guide = document.getElementById('observe-scoring-guide');
          if (!guide) return;
          var open = guide.style.display !== 'none';
          guide.style.display = open ? 'none' : 'block';
          if (btn) btn.textContent = open ? '查看判断标准' : '收起判断标准';
        }
        window.toggleMetricGuide = function toggleMetricGuide() {
          var panel = document.getElementById('metric-guide-panel');
          if (!panel) return;
          panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
        };
        window.closeMetricGuide = function closeMetricGuide() {
          var panel = document.getElementById('metric-guide-panel');
          if (panel) panel.style.display = 'none';
        };
        window.openMetricGuide = function openMetricGuide(key) {
          var panel = document.getElementById('metric-guide-panel');
          if (!panel) return;
          panel.style.display = 'block';
          var items = panel.querySelectorAll('[data-metric-guide-key]');
          var target = null;
          for (var i = 0; i < items.length; i++) {
            var active = items[i].getAttribute('data-metric-guide-key') === key;
            items[i].classList.toggle('is-active', active);
            if (active) target = items[i];
          }
          if (target && target.scrollIntoView) target.scrollIntoView({ block: 'nearest' });
        };
        async function openObservationTrace(id, btn) {
          var target = document.getElementById('trace-' + id);
          if (!target) return;
          var open = target.style.display !== 'none';
          if (open) {
            target.style.display = 'none';
            if (btn) btn.textContent = 'Open in trace';
            return;
          }
          target.style.display = 'block';
          target.textContent = 'Loading...';
          if (btn) btn.textContent = 'Hide trace';
          try {
            var res = await fetch('/api/observe-inbox/show?id=' + encodeURIComponent(id));
            var data = await res.json();
            target.textContent = data.text || data.error || '';
          } catch (err) {
            target.textContent = String(err && err.message ? err.message : err);
          }
        }
        function reviewVerdictClass(verdict) {
          if (verdict === 'real_issue') return 'review-real-issue';
          if (verdict === 'not_issue') return 'review-not-issue';
          if (verdict === 'needs_more_context') return 'review-needs-context';
          if (verdict === 'reviewed') return 'review-reviewed';
          return '';
        }
        async function setObservationReviewState(targetType, targetId, verdict, btn) {
          if (btn) btn.disabled = true;
          var current = btn && btn.closest('[data-review-state-key]')
            ? btn.closest('[data-review-state-key]').getAttribute('data-review-state-current')
            : '';
          var shouldDelete = current === verdict;
          try {
            var res = shouldDelete
              ? await fetch('/api/observe-inbox/review-state?targetType=' + encodeURIComponent(targetType) + '&targetId=' + encodeURIComponent(targetId), { method: 'DELETE' })
              : await fetch('/api/observe-inbox/review-state', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targetType: targetType, targetId: targetId, verdict: verdict })
              });
            if (!res.ok) throw new Error('review state update failed: ' + res.status);
            await res.json();
            var key = targetType + ':' + targetId;
            var nextVerdict = shouldDelete ? '' : verdict;
            var controls = document.querySelectorAll('[data-review-state-key="' + key.replace(/"/g, '\\"') + '"]');
            for (var i = 0; i < controls.length; i++) {
              controls[i].setAttribute('data-review-state-current', nextVerdict);
              var buttons = controls[i].querySelectorAll('[data-review-verdict]');
              for (var j = 0; j < buttons.length; j++) {
                var buttonVerdict = buttons[j].getAttribute('data-review-verdict');
                var active = buttonVerdict === nextVerdict;
                buttons[j].className = 'review-state-button' + (active ? ' is-active ' + reviewVerdictClass(buttonVerdict) : '');
              }
            }
          } catch (err) {
            alert(String(err && err.message ? err.message : err));
          } finally {
            if (btn) btn.disabled = false;
          }
        }
        function reviewerJudgmentLabel(verdict) {
          if (verdict === 'real_issue') return '已同意';
          if (verdict === 'not_issue') return '已否决';
          if (verdict === 'needs_more_context') return '已留意见';
          if (verdict === 'reviewed') return '已看过';
          return '未标注';
        }
        function updateReviewerJudgmentUi(targetId, verdict, reason) {
          var cards = document.querySelectorAll('[data-reviewer-judgment-id="' + targetId.replace(/"/g, '\\"') + '"]');
          for (var i = 0; i < cards.length; i++) {
            var review = cards[i].querySelector('[data-reviewer-judgment-current]');
            if (!review) continue;
            review.setAttribute('data-reviewer-judgment-current', verdict || '');
            var label = review.querySelector('[data-reviewer-judgment-label]');
            if (label) label.textContent = reviewerJudgmentLabel(verdict);
            var buttons = review.querySelectorAll('[data-reviewer-judgment-verdict]');
            for (var j = 0; j < buttons.length; j++) {
              var buttonVerdict = buttons[j].getAttribute('data-reviewer-judgment-verdict');
              buttons[j].classList.toggle('is-active', Boolean(verdict && buttonVerdict === verdict));
            }
            var note = review.querySelector('small');
            if (reason) {
              if (!note) {
                note = document.createElement('small');
                review.appendChild(note);
              }
              note.textContent = reason;
            } else if (note) {
              note.remove();
            }
          }
        }
        async function setReviewerJudgmentReview(targetId, verdict, btn, reason) {
          if (btn) btn.disabled = true;
          var review = btn && btn.closest ? btn.closest('[data-reviewer-judgment-current]') : null;
          var current = review ? review.getAttribute('data-reviewer-judgment-current') || '' : '';
          var shouldDelete = current === verdict && !reason;
          try {
            var res = shouldDelete
              ? await fetch('/api/observe-inbox/review-state?targetType=reviewer_judgment&targetId=' + encodeURIComponent(targetId), { method: 'DELETE' })
              : await fetch('/api/observe-inbox/review-state', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  targetType: 'reviewer_judgment',
                  targetId: targetId,
                  verdict: verdict,
                  reason: reason || undefined
                })
              });
            if (!res.ok) throw new Error('判断标注写入失败: ' + res.status);
            await res.json();
            updateReviewerJudgmentUi(targetId, shouldDelete ? '' : verdict, shouldDelete ? '' : reason);
          } catch (err) {
            alert(String(err && err.message ? err.message : err));
          } finally {
            if (btn) btn.disabled = false;
          }
        }
        function openReviewerJudgmentNote(targetId, btn) {
          var previous = btn && btn.closest ? btn.closest('[data-reviewer-judgment-current]') : null;
          var oldNote = previous && previous.querySelector('small') ? previous.querySelector('small').textContent || '' : '';
          closeManualCorrectionPopovers();
          if (btn) btn.classList.add('is-editing');
          var popover = document.createElement('div');
          popover.className = 'manual-correction-popover';
          var title = document.createElement('div');
          title.className = 'manual-correction-popover-title';
          title.textContent = '补充判断意见';
          var hint = document.createElement('div');
          hint.className = 'manual-correction-popover-hint';
          hint.textContent = '意见会写入 review-state.json，不修改原始 trace。';
          var input = document.createElement('textarea');
          input.className = 'metric-reason-input';
          input.value = oldNote;
          input.placeholder = '写下需要补充的判断依据';
          var footer = document.createElement('div');
          footer.className = 'manual-correction-popover-actions';
          var save = document.createElement('button');
          save.type = 'button';
          save.textContent = '保存';
          var cancel = document.createElement('button');
          cancel.type = 'button';
          cancel.textContent = '取消';
          footer.appendChild(save);
          footer.appendChild(cancel);
          popover.appendChild(title);
          popover.appendChild(hint);
          popover.appendChild(input);
          popover.appendChild(footer);
          positionManualCorrectionPopover(popover, btn);
          input.focus();
          input.select();
          var close = function () {
            popover.remove();
            if (btn) btn.classList.remove('is-editing');
          };
          save.addEventListener('click', function () {
            setReviewerJudgmentReview(targetId, 'needs_more_context', btn, input.value.trim());
            close();
          });
          cancel.addEventListener('click', close);
          setTimeout(function () {
            document.addEventListener('click', function closeOnOutsideClick(event) {
              if (popover.contains(event.target) || (btn && btn.contains(event.target))) return;
              close();
              document.removeEventListener('click', closeOnOutsideClick);
            });
          }, 0);
        }
        function softStandardStatusLabel(status) {
          if (status === 'author_confirmed') return '作者已确认';
          if (status === 'rejected') return '已否决';
          if (status === 'stale') return '已过期';
          return '待作者确认';
        }
        function softStandardStatusIcon(status) {
          if (status === 'author_confirmed') return '✅';
          if (status === 'rejected') return '❌';
          return '';
        }
        function softStandardReviewVerdict(status) {
          if (status === 'author_confirmed') return 'real_issue';
          if (status === 'rejected') return 'not_issue';
          return 'needs_more_context';
        }
        async function setSoftStandardStatus(skillName, standardId, status, btn) {
          if (btn) btn.disabled = true;
          try {
            var res = await fetch('/api/observe-inbox/review-state', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                targetType: 'soft_standard',
                targetId: skillName + ':' + standardId,
                verdict: softStandardReviewVerdict(status)
              })
            });
            if (!res.ok) throw new Error('标准候选人工判断写入失败: ' + res.status);
            await res.json();
            var cards = document.querySelectorAll('[data-soft-standard-id="' + standardId.replace(/"/g, '\\"') + '"][data-soft-standard-skill="' + skillName.replace(/"/g, '\\"') + '"]');
            for (var i = 0; i < cards.length; i++) {
              var label = cards[i].querySelector('[data-soft-standard-status]');
              if (label) {
                label.setAttribute('data-soft-standard-status', status);
                label.textContent = softStandardStatusLabel(status);
              }
              cards[i].classList.toggle('is-confirmed', status === 'author_confirmed');
              cards[i].classList.toggle('is-rejected', status === 'rejected');
              var icon = cards[i].querySelector('[data-soft-standard-icon]');
              if (icon) {
                icon.setAttribute('data-soft-standard-icon', status);
                icon.textContent = softStandardStatusIcon(status);
              }
            }
          } catch (err) {
            alert(String(err && err.message ? err.message : err));
          } finally {
            if (btn) btn.disabled = false;
          }
        }
        function closeManualCorrectionPopovers() {
          var popovers = document.querySelectorAll('.manual-correction-popover');
          for (var i = 0; i < popovers.length; i++) popovers[i].remove();
          var buttons = document.querySelectorAll('.manual-correction-button.is-editing');
          for (var j = 0; j < buttons.length; j++) buttons[j].classList.remove('is-editing');
        }
        function manualCorrectionNote(value, label) {
          return JSON.stringify({ value: value, label: label });
        }
        function updateManualCorrectionButtons(targetType, targetId, label) {
          var key = targetType + ':' + targetId;
          var buttons = document.querySelectorAll('[data-manual-correction-key="' + key.replace(/"/g, '\\"') + '"]');
          for (var i = 0; i < buttons.length; i++) {
            var baseLabel = buttons[i].getAttribute('data-manual-correction-label') || '人工纠正';
            buttons[i].setAttribute('data-manual-correction-current', label || '');
            buttons[i].classList.toggle('is-marked', Boolean(label));
            buttons[i].textContent = label ? baseLabel + '：' + label : baseLabel;
          }
        }
        async function submitManualCorrection(targetType, targetId, value, label, btn) {
          if (btn) btn.disabled = true;
          try {
            var res = value === ''
              ? await fetch('/api/observe-inbox/review-state?targetType=' + encodeURIComponent(targetType) + '&targetId=' + encodeURIComponent(targetId), { method: 'DELETE' })
              : await fetch('/api/observe-inbox/review-state', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  targetType: targetType,
                  targetId: targetId,
                  verdict: 'reviewed',
                  note: manualCorrectionNote(value, label)
                })
              });
            if (!res.ok) throw new Error('人工纠正写入失败: ' + res.status);
            await res.json();
            updateManualCorrectionButtons(targetType, targetId, value === '' ? '' : label);
            closeManualCorrectionPopovers();
          } catch (err) {
            alert(String(err && err.message ? err.message : err));
          } finally {
            if (btn) btn.disabled = false;
          }
        }
        function positionManualCorrectionPopover(popover, btn) {
          var rect = btn.getBoundingClientRect();
          var width = Math.min(320, Math.max(220, window.innerWidth - 24));
          popover.style.width = width + 'px';
          document.body.appendChild(popover);
          var left = Math.min(window.innerWidth - width - 12, Math.max(12, rect.right - width));
          var top = rect.bottom + 8;
          var popRect = popover.getBoundingClientRect();
          if (top + popRect.height > window.innerHeight - 12) {
            top = Math.max(12, rect.top - popRect.height - 8);
          }
          popover.style.left = left + 'px';
          popover.style.top = top + 'px';
        }
        function openManualCorrection(btn) {
          closeManualCorrectionPopovers();
          if (!btn) return;
          var targetType = btn.getAttribute('data-manual-correction-target-type') || '';
          var targetId = btn.getAttribute('data-manual-correction-target-id') || '';
          var label = btn.getAttribute('data-manual-correction-label') || '人工纠正';
          var kind = btn.getAttribute('data-manual-correction-kind') || 'choice';
          if (kind === 'text') {
            var current = btn.getAttribute('data-manual-correction-current') || '';
            btn.classList.add('is-editing');
            var textPopover = document.createElement('div');
            textPopover.className = 'manual-correction-popover';
            var textTitle = document.createElement('div');
            textTitle.className = 'manual-correction-popover-title';
            textTitle.textContent = label;
            var textHint = document.createElement('div');
            textHint.className = 'manual-correction-popover-hint';
            textHint.textContent = '填写人工纠正后的内容。结果写入 review-state.json，不修改原始 trace。';
            var input = document.createElement('textarea');
            input.className = 'metric-reason-input';
            input.value = current;
            input.placeholder = '例如：生成 Demo / PRD 评审 / 修复脚本';
            var footer = document.createElement('div');
            footer.className = 'manual-correction-popover-actions';
            var save = document.createElement('button');
            save.type = 'button';
            save.textContent = '保存';
            var clearText = document.createElement('button');
            clearText.type = 'button';
            clearText.textContent = '清除标注';
            var cancelText = document.createElement('button');
            cancelText.type = 'button';
            cancelText.textContent = '取消';
            footer.appendChild(save);
            footer.appendChild(clearText);
            footer.appendChild(cancelText);
            textPopover.appendChild(textTitle);
            textPopover.appendChild(textHint);
            textPopover.appendChild(input);
            textPopover.appendChild(footer);
            positionManualCorrectionPopover(textPopover, btn);
            input.focus();
            save.addEventListener('click', function () {
              var trimmed = input.value.trim();
              submitManualCorrection(targetType, targetId, trimmed, trimmed, btn);
            });
            clearText.addEventListener('click', function () { submitManualCorrection(targetType, targetId, '', '', btn); });
            cancelText.addEventListener('click', closeManualCorrectionPopovers);
            return;
          }
          btn.classList.add('is-editing');
          var options = [];
          try { options = JSON.parse(btn.getAttribute('data-manual-correction-options') || '[]'); } catch { options = []; }
          var popover = document.createElement('div');
          popover.className = 'manual-correction-popover';
          var title = document.createElement('div');
          title.className = 'manual-correction-popover-title';
          title.textContent = label;
          var hint = document.createElement('div');
          hint.className = 'manual-correction-popover-hint';
          hint.textContent = '选择人工判断。结果写入 review-state.json，不修改原始 trace。';
          var actions = document.createElement('div');
          actions.className = 'manual-correction-popover-actions';
          for (var i = 0; i < options.length; i++) {
            (function (option) {
              var choice = document.createElement('button');
              choice.type = 'button';
              choice.textContent = option.label || option.value;
              choice.addEventListener('click', function () {
                submitManualCorrection(targetType, targetId, option.value || '', option.label || option.value || '', btn);
              });
              actions.appendChild(choice);
            })(options[i]);
          }
          var clear = document.createElement('button');
          clear.type = 'button';
          clear.textContent = '清除标注';
          clear.addEventListener('click', function () { submitManualCorrection(targetType, targetId, '', '', btn); });
          actions.appendChild(clear);
          popover.appendChild(title);
          popover.appendChild(hint);
          popover.appendChild(actions);
          positionManualCorrectionPopover(popover, btn);
          setTimeout(function () {
            document.addEventListener('click', function closeOnOutsideClick(event) {
              if (popover.contains(event.target) || btn.contains(event.target)) return;
              closeManualCorrectionPopovers();
              document.removeEventListener('click', closeOnOutsideClick);
            });
          }, 0);
        }
        window.openManualCorrection = openManualCorrection;
        window.closeManualCorrectionPopovers = closeManualCorrectionPopovers;
        function closeGoalSliceCorrectionPopovers() {
          var popovers = document.querySelectorAll('.goal-slice-popover');
          for (var i = 0; i < popovers.length; i++) popovers[i].remove();
          var buttons = document.querySelectorAll('.goal-slice-correction-button.is-editing');
          for (var j = 0; j < buttons.length; j++) buttons[j].classList.remove('is-editing');
        }
        function updateGoalSliceCorrectionButtons(targetId, action) {
          var key = 'goal_slice_correction:' + targetId;
          var buttons = document.querySelectorAll('[data-goal-slice-correction-key="' + key.replace(/"/g, '\\"') + '"]');
          var label = action === 'split_goal_slice'
            ? '已标记：拆分'
            : action === 'add_to_current_skill_window'
              ? '已标记：加入窗口'
              : '人工标记';
          for (var i = 0; i < buttons.length; i++) {
            buttons[i].textContent = label;
            buttons[i].setAttribute('data-goal-slice-correction-action', action || '');
            buttons[i].classList.toggle('is-marked', Boolean(action));
          }
          var manualButtons = document.querySelectorAll('[data-manual-mark-goal-target="' + targetId.replace(/"/g, '\\"') + '"]');
          for (var j = 0; j < manualButtons.length; j++) {
            manualButtons[j].setAttribute('data-manual-mark-goal-action', action || '');
            var metrics = [];
            try { metrics = JSON.parse(manualButtons[j].getAttribute('data-manual-mark-metrics') || '[]'); } catch { metrics = []; }
            var activeCount = (action ? 1 : 0) + metrics.filter(function (item) {
              return item.verdict === 'confirmed' || item.verdict === 'rejected';
            }).length;
            manualButtons[j].classList.toggle('is-marked', activeCount > 0);
            var mode = manualButtons[j].getAttribute('data-manual-mark-mode') || 'metrics';
            if (mode === 'window_only') {
              manualButtons[j].textContent = action === 'add_to_current_skill_window' ? '已加入窗口' : '加入窗口';
            } else {
              manualButtons[j].textContent = '人工标记' + (activeCount > 0 ? '(' + activeCount + ')' : '');
            }
          }
        }
        async function submitGoalSliceCorrection(targetId, action, btn) {
          if (btn) btn.disabled = true;
          try {
            var res;
            if (!action) {
              res = await fetch('/api/observe-inbox/review-state?targetType=goal_slice_correction&targetId=' + encodeURIComponent(targetId), { method: 'DELETE' });
            } else {
              res = await fetch('/api/observe-inbox/review-state', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  targetType: 'goal_slice_correction',
                  targetId: targetId,
                  verdict: 'reviewed',
                  note: action,
                  traceId: btn ? btn.getAttribute('data-trace-id') || undefined : undefined,
                  sourceTrace: btn ? btn.getAttribute('data-source-trace') || undefined : undefined,
                  sessionId: btn ? btn.getAttribute('data-session-id') || undefined : undefined,
                  messageIndex: btn && btn.getAttribute('data-message-index') ? Number(btn.getAttribute('data-message-index')) : undefined,
                  messageUuid: btn ? btn.getAttribute('data-message-uuid') || undefined : undefined,
                  callInstanceId: btn ? btn.getAttribute('data-call-instance-id') || undefined : undefined,
                  toolUseId: btn ? btn.getAttribute('data-tool-use-id') || undefined : undefined,
                  snippet: btn ? btn.getAttribute('data-snippet') || undefined : undefined
                })
              });
            }
            if (!res.ok) throw new Error('goal slice correction update failed: ' + res.status);
            await res.json();
            updateGoalSliceCorrectionButtons(targetId, action);
            closeGoalSliceCorrectionPopovers();
          } catch (err) {
            alert(String(err && err.message ? err.message : err));
          } finally {
            if (btn) btn.disabled = false;
          }
        }
        function positionGoalSlicePopover(popover, btn) {
          var rect = btn.getBoundingClientRect();
          var isTimelineManual = popover.classList && popover.classList.contains('timeline-manual-popover');
          var preferredWidth = isTimelineManual ? 380 : 320;
          var width = Math.min(preferredWidth, Math.max(220, window.innerWidth - 32));
          popover.style.width = width + 'px';
          var left = Math.min(window.innerWidth - width - 12, Math.max(12, rect.right - width));
          var top = rect.bottom + 8;
          document.body.appendChild(popover);
          if (isTimelineManual) {
            popover.style.maxHeight = Math.max(180, window.innerHeight - 24) + 'px';
            popover.style.overflowY = 'auto';
          }
          var popRect = popover.getBoundingClientRect();
          if (top + popRect.height > window.innerHeight - 12) {
            top = Math.max(12, rect.top - popRect.height - 8);
          }
          if (isTimelineManual && top + popRect.height > window.innerHeight - 12) {
            top = 12;
            popover.style.maxHeight = Math.max(180, window.innerHeight - 24) + 'px';
          }
          popover.style.left = left + 'px';
          popover.style.top = top + 'px';
        }
        function openGoalSliceCorrectionPopover(targetId, btn) {
          closeGoalSliceCorrectionPopovers();
          if (!btn) return;
          btn.classList.add('is-editing');
          var popover = document.createElement('div');
          popover.className = 'goal-slice-popover';
          var title = document.createElement('div');
          title.className = 'goal-slice-popover-title';
          title.textContent = '人工标记';
          var hint = document.createElement('div');
          hint.className = 'goal-slice-popover-hint';
          hint.textContent = '这个标记会写入 review-state.json。修改后需要重新执行脚本，报告才会按新切片或新窗口重算。';
          var actions = document.createElement('div');
          actions.className = 'goal-slice-popover-actions';
          var split = document.createElement('button');
          split.type = 'button';
          split.textContent = '拆分目标切片';
          split.title = '把这条 message 作为新的目标片段起点候选。';
          var clear = document.createElement('button');
          clear.type = 'button';
          clear.textContent = '取消打标';
          clear.title = '删除这条 message 的人工切片/窗口标记。';
          var add = document.createElement('button');
          add.type = 'button';
          add.textContent = '添加至当前 skill 窗口';
          add.title = '把这条 message 作为当前 skill 的上下文候选。';
          actions.appendChild(split);
          actions.appendChild(clear);
          actions.appendChild(add);
          popover.appendChild(title);
          popover.appendChild(hint);
          popover.appendChild(actions);
          positionGoalSlicePopover(popover, btn);
          setTimeout(function () {
            document.addEventListener('click', function closeOnOutsideClick(event) {
              if (popover.contains(event.target) || btn.contains(event.target)) return;
              closeGoalSliceCorrectionPopovers();
              document.removeEventListener('click', closeOnOutsideClick);
            });
          }, 0);
          split.addEventListener('click', function () { submitGoalSliceCorrection(targetId, 'split_goal_slice', btn); });
          clear.addEventListener('click', function () { submitGoalSliceCorrection(targetId, '', btn); });
          add.addEventListener('click', function () { submitGoalSliceCorrection(targetId, 'add_to_current_skill_window', btn); });
        }
        window.closeGoalSliceCorrectionPopovers = closeGoalSliceCorrectionPopovers;
        window.openGoalSliceCorrectionPopover = openGoalSliceCorrectionPopover;
        function closeTimelineManualMarkPopovers() {
          var popovers = document.querySelectorAll('.timeline-manual-popover');
          for (var i = 0; i < popovers.length; i++) popovers[i].remove();
          var buttons = document.querySelectorAll('.timeline-manual-mark-button.is-editing');
          for (var j = 0; j < buttons.length; j++) buttons[j].classList.remove('is-editing');
        }
        function metricStateLabel(verdict, ruleDetected) {
          if (verdict === 'confirmed') return '人工同意';
          if (verdict === 'rejected') return '人工反对';
          return ruleDetected ? '规则命中' : '未命中';
        }
        function updateTimelineManualMarkButton(btn, metric, next) {
          var metrics = [];
          try { metrics = JSON.parse(btn.getAttribute('data-manual-mark-metrics') || '[]'); } catch { metrics = []; }
          for (var i = 0; i < metrics.length; i++) {
            if (metrics[i].targetId === metric.targetId) {
              metrics[i].verdict = next;
              break;
            }
          }
          btn.setAttribute('data-manual-mark-metrics', JSON.stringify(metrics));
          var goalAction = btn.getAttribute('data-manual-mark-goal-action') || '';
          var activeCount = (goalAction ? 1 : 0) + metrics.filter(function (item) {
            return item.verdict === 'confirmed' || item.verdict === 'rejected';
          }).length;
          btn.classList.toggle('is-marked', activeCount > 0);
          var mode = btn.getAttribute('data-manual-mark-mode') || 'metrics';
          if (mode === 'window_only') {
            btn.textContent = goalAction === 'add_to_current_skill_window' ? '已加入窗口' : '加入窗口';
          } else {
            btn.textContent = '人工标记' + (activeCount > 0 ? '(' + activeCount + ')' : '');
          }
        }
        async function submitTimelineMetricAnnotation(metric, next, btn) {
          var source = {};
          try { source = JSON.parse(btn.getAttribute('data-manual-mark-source') || '{}'); } catch { source = {}; }
          var res = next === ''
            ? await fetch('/api/observe-inbox/review-state?targetType=evidence_metric&targetId=' + encodeURIComponent(metric.targetId), { method: 'DELETE' })
            : await fetch('/api/observe-inbox/review-state', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                targetType: 'evidence_metric',
                targetId: metric.targetId,
                verdict: next,
                metricKey: metric.metricKey,
                metricScopeId: metric.metricScopeId || undefined,
                traceId: source.traceId || undefined,
                sourceTrace: source.sourceTrace || undefined,
                sessionId: source.sessionId || undefined,
                messageIndex: source.messageIndex === undefined ? undefined : Number(source.messageIndex),
                messageUuid: source.messageUuid || undefined,
                callInstanceId: source.callInstanceId || undefined,
                toolUseId: source.toolUseId || undefined,
                snippet: source.snippet || undefined
              })
            });
          if (!res.ok) throw new Error('人工标记写入失败: ' + res.status);
          await res.json();
          metric.verdict = next;
          updateTimelineManualMarkButton(btn, metric, next);
        }
        function addTimelineMetricButton(actions, metric, value, text, btn, labelEl) {
          var button = document.createElement('button');
          button.type = 'button';
          button.textContent = text;
          button.className = value && metric.verdict === value ? 'is-active' : '';
          button.addEventListener('click', function () {
            submitTimelineMetricAnnotation(metric, value, btn).then(function () {
              var rowButtons = actions.querySelectorAll('button');
              for (var i = 0; i < rowButtons.length; i++) rowButtons[i].classList.remove('is-active');
              if (value) button.classList.add('is-active');
              if (labelEl) labelEl.textContent = metricStateLabel(value, metric.ruleDetected) + ' · ' + metric.label;
            }).catch(function (err) {
              alert(String(err && err.message ? err.message : err));
            });
          });
          actions.appendChild(button);
        }
        function openTimelineManualMark(btn) {
          closeTimelineManualMarkPopovers();
          closeGoalSliceCorrectionPopovers();
          if (!btn) return;
          btn.classList.add('is-editing');
          var metrics = [];
          try { metrics = JSON.parse(btn.getAttribute('data-manual-mark-metrics') || '[]'); } catch { metrics = []; }
          var mode = btn.getAttribute('data-manual-mark-mode') || 'metrics';
          var isWindowOnly = mode === 'window_only';
          var goalTargetId = btn.getAttribute('data-manual-mark-goal-target') || '';
          var goalAction = btn.getAttribute('data-manual-mark-goal-action') || '';
          var popover = document.createElement('div');
          popover.className = 'timeline-manual-popover';
          var title = document.createElement('div');
          title.className = 'goal-slice-popover-title';
          title.textContent = isWindowOnly ? '加入当前 skill 窗口' : '人工标记这条消息';
          var hint = document.createElement('div');
          hint.className = 'goal-slice-popover-hint';
          hint.textContent = isWindowOnly
            ? '这条消息不在当前 skill 窗口内，不能直接打指标标签。需要先加入当前 skill 窗口，重新执行脚本后再标注。'
            : '这里可以修正消息标签，也可以把这条消息标成目标切片点或加入当前 skill 窗口。消息标签包括纠正、中断、追问、正负反馈、硬性要求、目标切换、有结果、有产物、过程进展、自我纠正和重复执行。';
          var actions = document.createElement('div');
          actions.className = 'timeline-manual-actions';
          var goalSplit = document.createElement('button');
          goalSplit.type = 'button';
          goalSplit.textContent = goalAction === 'split_goal_slice' ? '已标：拆分目标' : '拆分目标切片';
          goalSplit.addEventListener('click', function () { submitGoalSliceCorrection(goalTargetId, 'split_goal_slice', btn); });
          var goalAdd = document.createElement('button');
          goalAdd.type = 'button';
          goalAdd.textContent = goalAction === 'add_to_current_skill_window' ? '已标：加入窗口' : '加入当前 skill 窗口';
          goalAdd.addEventListener('click', function () { submitGoalSliceCorrection(goalTargetId, 'add_to_current_skill_window', btn); });
          var goalClear = document.createElement('button');
          goalClear.type = 'button';
          goalClear.textContent = '清除切片/窗口';
          goalClear.addEventListener('click', function () { submitGoalSliceCorrection(goalTargetId, '', btn); });
          if (!isWindowOnly) actions.appendChild(goalSplit);
          actions.appendChild(goalAdd);
          if (!isWindowOnly || goalAction) actions.appendChild(goalClear);
          for (var i = 0; i < metrics.length; i++) {
            (function (metric) {
              var group = document.createElement('div');
              group.className = 'timeline-manual-metric-row';
              var label = document.createElement('span');
              label.textContent = metricStateLabel(metric.verdict, metric.ruleDetected) + ' · ' + metric.label;
              group.appendChild(label);
              addTimelineMetricButton(group, metric, 'confirmed', '同意', btn, label);
              addTimelineMetricButton(group, metric, 'rejected', '反对', btn, label);
              addTimelineMetricButton(group, metric, '', '清除', btn, label);
              actions.appendChild(group);
            })(metrics[i]);
          }
          popover.appendChild(title);
          popover.appendChild(hint);
          popover.appendChild(actions);
          positionGoalSlicePopover(popover, btn);
          setTimeout(function () {
            document.addEventListener('click', function closeOnOutsideClick(event) {
              if (popover.contains(event.target) || btn.contains(event.target)) return;
              closeTimelineManualMarkPopovers();
              document.removeEventListener('click', closeOnOutsideClick);
            });
          }, 0);
        }
        window.openTimelineManualMark = openTimelineManualMark;
        window.closeTimelineManualMarkPopovers = closeTimelineManualMarkPopovers;
	        function evidenceMetricText(label, annotation, ruleDetected) {
	          if (annotation === 'confirmed') return '人工同意 · ' + label;
	          if (annotation === 'rejected') return '人工反对 · ' + label;
	          return (ruleDetected ? '规则命中 · ' : '未命中 · ') + label;
	        }
        function evidenceMetricClass(annotation, ruleDetected) {
          if (annotation === 'confirmed') return 'metric-calibration-button is-confirmed';
          if (annotation === 'rejected') return 'metric-calibration-button is-rejected';
          return 'metric-calibration-button' + (ruleDetected ? ' is-rule-hit' : '');
        }
        function findEvidenceMetricButtons(targetId) {
          var all = document.querySelectorAll('[data-evidence-metric-target]');
          var buttons = [];
          for (var i = 0; i < all.length; i++) {
            if (all[i].getAttribute('data-evidence-metric-target') === targetId) buttons.push(all[i]);
          }
          return buttons;
        }
        function closeMetricReasonPopover() {
          var popovers = document.querySelectorAll('.metric-reason-popover');
          for (var i = 0; i < popovers.length; i++) popovers[i].remove();
          var buttons = document.querySelectorAll('.metric-calibration-button.is-editing-reason');
          for (var j = 0; j < buttons.length; j++) buttons[j].classList.remove('is-editing-reason');
        }
        async function submitEvidenceMetricAnnotation(targetId, metricKey, btn, next, reason) {
          var res = next === ''
            ? await fetch('/api/observe-inbox/review-state?targetType=evidence_metric&targetId=' + encodeURIComponent(targetId), { method: 'DELETE' })
            : await fetch('/api/observe-inbox/review-state', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                targetType: 'evidence_metric',
                targetId: targetId,
                verdict: next,
                metricKey: metricKey,
                traceId: btn.getAttribute('data-trace-id') || undefined,
                sourceTrace: btn.getAttribute('data-source-trace') || undefined,
                sessionId: btn.getAttribute('data-session-id') || undefined,
                messageIndex: btn.getAttribute('data-message-index') ? Number(btn.getAttribute('data-message-index')) : undefined,
                messageUuid: btn.getAttribute('data-message-uuid') || undefined,
                callInstanceId: btn.getAttribute('data-call-instance-id') || undefined,
                toolUseId: btn.getAttribute('data-tool-use-id') || undefined,
                snippet: btn.getAttribute('data-snippet') || undefined,
                reason: reason || undefined
              })
            });
          if (!res.ok) throw new Error('metric annotation update failed: ' + res.status);
          await res.json();
          var buttons = findEvidenceMetricButtons(targetId);
          for (var i = 0; i < buttons.length; i++) {
            var label = buttons[i].getAttribute('data-metric-label') || '';
	            var ruleDetected = buttons[i].getAttribute('data-rule-detected') === '1';
	            buttons[i].setAttribute('data-metric-annotation', next);
	            buttons[i].setAttribute('data-metric-reason', reason || '');
	            buttons[i].textContent = evidenceMetricText(label, next, ruleDetected);
	            buttons[i].className = evidenceMetricClass(next, ruleDetected);
	          }
	        }
	        function openMetricReasonPopover(targetId, metricKey, btn) {
	          closeMetricReasonPopover();
	          var actions = btn && btn.closest ? btn.closest('.metric-calibration-actions') : null;
	          if (!actions) return;
	          var label = btn.getAttribute('data-metric-label') || metricKey;
	          var selected = btn.getAttribute('data-metric-annotation') || '';
	          var previousReason = btn.getAttribute('data-metric-reason') || '';
	          var popover = document.createElement('div');
	          popover.className = 'metric-reason-popover';
	          var panel = document.createElement('div');
	          panel.className = 'metric-reason-panel';
	          var title = document.createElement('div');
	          title.className = 'metric-reason-title';
	          title.textContent = '人工校准：' + label;
	          var hint = document.createElement('div');
	          hint.className = 'metric-reason-hint';
	          hint.textContent = '先选择同意或反对，再填写原因。原因选填，会写入 review-state.json。';
	          var choices = document.createElement('div');
	          choices.className = 'metric-reason-choice-row';
	          var choiceLabel = document.createElement('span');
	          choiceLabel.className = 'metric-reason-choice-label';
	          choiceLabel.textContent = '判断';
	          var agree = document.createElement('button');
	          agree.type = 'button';
	          agree.className = 'metric-reason-choice';
	          agree.textContent = '同意';
	          var disagree = document.createElement('button');
	          disagree.type = 'button';
	          disagree.className = 'metric-reason-choice';
	          disagree.textContent = '反对';
	          choices.appendChild(choiceLabel);
	          choices.appendChild(agree);
	          choices.appendChild(disagree);
	          var input = document.createElement('textarea');
	          input.className = 'metric-reason-input';
	          input.value = previousReason;
	          input.placeholder = '选填：为什么这次要同意或反对这个判断';
	          var footer = document.createElement('div');
	          footer.className = 'metric-reason-actions';
	          var clear = document.createElement('button');
	          clear.type = 'button';
	          clear.className = 'metric-reason-action';
	          clear.textContent = '清除标注';
	          var cancel = document.createElement('button');
	          cancel.type = 'button';
	          cancel.className = 'metric-reason-action';
	          cancel.textContent = '取消';
          var save = document.createElement('button');
	          save.type = 'button';
	          save.className = 'metric-reason-action is-primary';
	          save.textContent = '保存';
	          footer.appendChild(clear);
	          footer.appendChild(cancel);
	          footer.appendChild(save);
	          function syncChoiceButtons() {
	            agree.classList.toggle('is-confirmed', selected === 'confirmed');
	            disagree.classList.toggle('is-rejected', selected === 'rejected');
	          }
	          agree.addEventListener('click', function () {
	            selected = 'confirmed';
	            syncChoiceButtons();
	            input.focus();
	          });
	          disagree.addEventListener('click', function () {
	            selected = 'rejected';
	            syncChoiceButtons();
	            input.focus();
	          });
	          syncChoiceButtons();
	          panel.appendChild(title);
	          panel.appendChild(hint);
	          panel.appendChild(choices);
	          panel.appendChild(input);
	          panel.appendChild(footer);
	          popover.appendChild(panel);
	          actions.appendChild(popover);
	          btn.classList.add('is-editing-reason');
	          cancel.addEventListener('click', closeMetricReasonPopover);
	          clear.addEventListener('click', async function () {
	            clear.disabled = true;
	            save.disabled = true;
	            cancel.disabled = true;
	            btn.disabled = true;
	            try {
	              await submitEvidenceMetricAnnotation(targetId, metricKey, btn, '', '');
	              closeMetricReasonPopover();
	            } catch (err) {
	              alert(String(err && err.message ? err.message : err));
	            } finally {
	              clear.disabled = false;
	              save.disabled = false;
	              cancel.disabled = false;
	              btn.disabled = false;
	            }
	          });
	          save.addEventListener('click', async function () {
	            if (selected !== 'confirmed' && selected !== 'rejected') {
	              alert('请先选择同意或反对。');
	              return;
	            }
	            save.disabled = true;
	            clear.disabled = true;
	            cancel.disabled = true;
	            btn.disabled = true;
	            try {
	              await submitEvidenceMetricAnnotation(targetId, metricKey, btn, selected, input.value.trim());
	              closeMetricReasonPopover();
	            } catch (err) {
	              alert(String(err && err.message ? err.message : err));
	            } finally {
	              save.disabled = false;
	              clear.disabled = false;
	              cancel.disabled = false;
	              btn.disabled = false;
	            }
          });
          input.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') closeMetricReasonPopover();
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') save.click();
          });
	          setTimeout(function () { input.focus(); }, 0);
	        }
	        function openEvidenceMetricAnnotation(targetId, metricKey, btn) {
	          openMetricReasonPopover(targetId, metricKey, btn);
	        }
        function setObserveSeverityFilter(value) {
          observeSeverityFilter = value;
          var buttons = document.querySelectorAll('[data-severity-filter]');
          for (var i = 0; i < buttons.length; i++) {
            var active = buttons[i].getAttribute('data-severity-filter') === value;
            buttons[i].style.background = active ? 'var(--bg-surface)' : 'var(--bg)';
            buttons[i].style.fontWeight = active ? '650' : '400';
          }
          applyObserveFilters();
        }
        function applyObserveFilters() {
          var input = document.getElementById('observe-filter-input');
          var query = input ? String(input.value || '').toLowerCase().trim() : '';
          var rows = document.querySelectorAll('[data-observe-row="review"]');
          for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            var severity = row.getAttribute('data-severity') || '';
            var search = row.getAttribute('data-search') || '';
            var detailId = row.getAttribute('data-detail-id');
            var detail = detailId ? document.querySelector('[data-observe-detail-for="' + detailId + '"]') : null;
            var visible = (observeSeverityFilter === 'all' || severity === observeSeverityFilter) && (!query || search.indexOf(query) >= 0);
            row.style.display = visible ? '' : 'none';
            if (!visible && detail) detail.style.display = 'none';
          }
          var groups = document.querySelectorAll('[data-observe-skill-group]');
          for (var g = 0; g < groups.length; g++) {
            var group = groups[g];
            var groupRows = group.querySelectorAll('[data-observe-row="review"]');
            var anyVisible = false;
            for (var r = 0; r < groupRows.length; r++) {
              if (groupRows[r].style.display !== 'none') {
                anyVisible = true;
                break;
              }
            }
            group.style.display = anyVisible ? '' : 'none';
            if (query && anyVisible) group.open = true;
          }
        }
        (function setupObserveFilters() {
          var input = document.getElementById('observe-filter-input');
          if (input) input.addEventListener('input', applyObserveFilters);
        })();
        (function setupSkillRollupRows() {
          var rows = document.querySelectorAll('[data-observe-rollup-row]');
          for (var i = 0; i < rows.length; i++) {
            rows[i].addEventListener('click', function (event) {
              var targetEl = event.target;
              if (targetEl && targetEl.closest && targetEl.closest('[data-no-rollup-click]')) return;
              var id = this.getAttribute('data-skill-anchor');
              if (!id) return;
              var target = document.getElementById(id);
              if (!target) return;
              target.open = true;
              target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
          }
        })();
        (function syncActionPanelHeight() {
          var action = document.getElementById('observe-action-panel');
          var funnel = document.getElementById('observe-funnel-panel');
          if (!action || !funnel) return;
          function sync() {
            action.style.height = '';
            var h = Math.max(funnel.scrollHeight, funnel.offsetHeight);
            if (h > 0) action.style.height = h + 'px';
          }
          sync();
          window.addEventListener('resize', sync);
          if (document.fonts && document.fonts.ready) document.fonts.ready.then(sync).catch(function () {});
        })();
        (function setupTimelineFullTextTooltips() {
          var tooltip = document.getElementById('timeline-fulltext-tooltip');
          if (!tooltip) return;
          var activeEl = null;
          function hasMoreFullText(el) {
            return el.getAttribute('data-timeline-has-more') === '1';
          }
          function isOverflowing(el) {
            if (!el || (el.clientHeight === 0 && el.clientWidth === 0)) return false;
            return hasMoreFullText(el) || el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2;
          }
          function updateOverflowState(el) {
            var overflowing = isOverflowing(el);
            el.classList.toggle('is-overflowing', overflowing);
            el.tabIndex = overflowing ? 0 : -1;
            return overflowing;
          }
          function refreshOverflowStates() {
            var nodes = document.querySelectorAll('[data-timeline-fulltext]');
            for (var i = 0; i < nodes.length; i++) updateOverflowState(nodes[i]);
          }
          window.refreshTimelineFullTextState = refreshOverflowStates;
          function hide() {
            if (activeEl) activeEl.classList.remove('is-detail-open');
            activeEl = null;
            tooltip.classList.remove('is-open');
            tooltip.setAttribute('aria-hidden', 'true');
            tooltip.innerHTML = '';
          }
          function show(el) {
            if (!updateOverflowState(el)) {
              hide();
              return;
            }
            var text = el.getAttribute('data-timeline-fulltext') || '';
            if (!text) return;
            if (activeEl && activeEl !== el) activeEl.classList.remove('is-detail-open');
            activeEl = el;
            activeEl.classList.add('is-detail-open');
            var title = el.getAttribute('data-timeline-fulltext-title') || '完整内容';
            tooltip.innerHTML = '<div class="timeline-fulltext-dialog" role="document"><div class="timeline-fulltext-header"><strong></strong><button type="button" class="timeline-fulltext-close" data-timeline-fulltext-close>关闭</button></div><div class="timeline-fulltext-body"></div></div>';
            tooltip.querySelector('strong').textContent = title;
            tooltip.querySelector('.timeline-fulltext-body').textContent = text;
            var close = tooltip.querySelector('[data-timeline-fulltext-close]');
            if (close) close.addEventListener('click', function (event) {
              event.stopPropagation();
              hide();
            });
            tooltip.classList.add('is-open');
            tooltip.setAttribute('aria-hidden', 'false');
            if (close && close.focus) close.focus();
          }
          tooltip.addEventListener('click', function (event) {
            if (event.target === tooltip) hide();
          });
          document.addEventListener('click', function (event) {
            var target = event.target;
            var fulltext = target && target.closest ? target.closest('.timeline-snippet[data-timeline-fulltext]') : null;
            if (!fulltext) return;
            if (!updateOverflowState(fulltext)) return;
            event.stopPropagation();
            show(fulltext);
          });
          document.addEventListener('keydown', function (event) {
            var target = event.target;
            var fulltext = target && target.closest ? target.closest('.timeline-snippet[data-timeline-fulltext]') : null;
            if (!fulltext) return;
            if (event.key === 'Enter' || event.key === ' ') {
              if (!updateOverflowState(fulltext)) return;
              event.preventDefault();
              event.stopPropagation();
              show(fulltext);
            }
            if (event.key === 'Escape') hide();
          });
          window.requestAnimationFrame(refreshOverflowStates);
          window.addEventListener('resize', refreshOverflowStates);
          document.addEventListener('click', function (event) {
            var target = event.target;
            if (target && target.closest && target.closest('.timeline-tab-button')) {
              window.setTimeout(refreshOverflowStates, 0);
              hide();
              return;
            }
            if (target && target.closest && (target.closest('#timeline-fulltext-tooltip .timeline-fulltext-dialog') || target.closest('.timeline-snippet[data-timeline-fulltext]'))) return;
            hide();
          });
          document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') hide();
          });
        })();
        (function setupSignalTooltips() {
          var tooltip = document.getElementById('signal-global-tooltip');
          if (!tooltip) return;
          function show(el) {
            var title = el.getAttribute('data-signal-title') || '';
            var description = el.getAttribute('data-signal-description') || '';
            tooltip.innerHTML = '<strong style="display:block;margin-bottom:4px"></strong><div></div>';
            tooltip.querySelector('strong').textContent = title;
            tooltip.querySelector('div').textContent = description;
            tooltip.style.display = 'block';
            var rect = el.getBoundingClientRect();
            var top = rect.bottom + 8;
            var left = rect.left;
            var width = Math.min(360, window.innerWidth - 32);
            if (left + width > window.innerWidth - 16) left = window.innerWidth - width - 16;
            if (left < 16) left = 16;
            tooltip.style.left = left + 'px';
            tooltip.style.top = top + 'px';
            var tipRect = tooltip.getBoundingClientRect();
            if (tipRect.bottom > window.innerHeight - 16) {
              tooltip.style.top = Math.max(16, rect.top - tipRect.height - 8) + 'px';
            }
          }
          function hide() {
            tooltip.style.display = 'none';
          }
          var helps = document.querySelectorAll('.signal-help');
          for (var i = 0; i < helps.length; i++) {
            helps[i].addEventListener('mouseenter', function () { show(this); });
            helps[i].addEventListener('focus', function () { show(this); });
            helps[i].addEventListener('mouseleave', hide);
            helps[i].addEventListener('blur', hide);
          }
        })();
`;
}
