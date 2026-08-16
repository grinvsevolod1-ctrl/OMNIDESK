/* Direct PRO — витрина только для чтения. Все данные тянутся по API панели по идентификатору PAGE_ID. */
(function () {
  'use strict';

  /* ======================= НАСТРОЙКИ =======================
     ЕДИНСТВЕННЫЙ источник конфигурации в расширении — сгенерированный
     config.js (window.__CHARTER_CFG__): при каждом скачивании архива в него
     вшиваются АКТУАЛЬНЫЙ origin панели, PAGE_ID (slug сайта) и свежий токен
     именно этой компании. Хардкода здесь НЕТ намеренно: если config.js не
     загрузился, витрина показывает понятный статус, а не тихо ходит на
     чужой домен со старым токеном.

     Для открытия page3.html напрямую (вне расширения, отладка) параметры
     передаются через URL:
       page3.html?api=https://panel.example.com/api/ext&page=PAGE_ID&token=XXX
                 &transport=sse&poll=4000&period=week
  ===================================================================== */
  var API_BASE = '';  /* корень API панели — из config.js или ?api= */
  var PAGE_ID  = '';  /* идентификатор этой страницы — из config.js или ?page= */

  var API_TOKEN = ''; /* Bearer-токен доступа — из config.js или ?token= */
  var POLL_MS = 5000;           /* период опроса состояния (fallback), мс */
  var TRANSPORT = 'auto';       /* auto | sse | poll — способ live-обновлений */
  var PERIOD = 'today';         /* активный период по умолчанию */
  var DEBUG = false;            /* true → показывать статус синхронизации/периода (для проверки настройки) */

  var ENDPOINTS = {
    state:  { method: 'GET', path: '/pages/{page}/state' },   /* снимок данных страницы */
    stream: { method: 'GET', path: '/pages/{page}/stream' }   /* Server-Sent Events (live) */
  };

  /* доступные периоды: value → подпись */
  var PERIODS = [
    { v: 'today',     label: 'Сегодня' },
    { v: 'yesterday', label: 'Вчера' },
    { v: 'week',      label: 'Последние 7 дней' },
    { v: 'month',     label: 'Последние 30 дней' },
    { v: 'all',       label: 'За всё время' }
  ];
  /* ===================================================================== */

  /* конфиг из расширения (content script): config.js кладёт window.__CHARTER_CFG__ */
  try {
    var xc = (typeof window !== 'undefined' && window.__CHARTER_CFG__) || null;
    if (xc) {
      if (xc.api) API_BASE = String(xc.api).replace(/\/+$/, '');
      if (xc.page) PAGE_ID = xc.page;
      if (xc.token) API_TOKEN = xc.token;
      if (xc.poll) POLL_MS = Math.max(1000, parseInt(xc.poll, 10) || POLL_MS);
      if (xc.transport) TRANSPORT = xc.transport;
      if (xc.period) PERIOD = xc.period;
      if (xc.debug != null) DEBUG = !!xc.debug;
    }
  } catch (_e) { /* noop */ }

  try {
    var qs = new URLSearchParams(location.search);
    if (qs.get('api')) API_BASE = qs.get('api').replace(/\/+$/, '');
    if (qs.get('page')) PAGE_ID = qs.get('page');
    if (qs.get('token')) API_TOKEN = qs.get('token');
    if (qs.get('poll')) POLL_MS = Math.max(1000, parseInt(qs.get('poll'), 10) || POLL_MS);
    if (qs.get('transport')) TRANSPORT = qs.get('transport');
    if (qs.get('period')) PERIOD = qs.get('period');
    if (qs.get('debug')) DEBUG = qs.get('debug') === '1' || qs.get('debug') === 'true';
  } catch (_e) { /* noop */ }

  /* Без токена API отвечает 401/404 — конфигурация неполна и без него. */
  var API_CONFIGURED = !!API_BASE && API_BASE.indexOf('example.com') === -1 && !!PAGE_ID && !!API_TOKEN;
  var SSE_SUPPORTED = typeof window.EventSource !== 'undefined';

  var STATIC_LOGIN = 'porg-zvuq2cjx'; /* демо-логин из исходной разметки — будет заменён логином из API */
  var currentLogin = STATIC_LOGIN;
  var LOGIN = '';                     /* реальный логин приходит из API (поле login) */
  var REMOVED_ID = '710202500';
  function periodLabel(v) {
    for (var i = 0; i < PERIODS.length; i++) if (PERIODS[i].v === v) return PERIODS[i].label;
    return 'Сегодня';
  }
  var PERIOD_LABEL = periodLabel(PERIOD);

  /* ---------- дата ---------- */
  var now = new Date();
  function pad(n) { return String(n).padStart(2, '0'); }
  var TODAY_STR = pad(now.getDate()) + '.' + pad(now.getMonth() + 1) + '.' + now.getFullYear();

  /* ---------- форматирование ---------- */
  var NBSP = '\u00a0';
  function fmtInt(n) { return Math.round(n).toLocaleString('ru-RU').replace(/\u00a0/g, NBSP); }
  function fmtMoney(n) { return n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/\u00a0/g, NBSP); }
  function fmtPct(n) { return fmtMoney(n); }

  /* ---------- состояние (заполняется данными API) ---------- */
  var state = {
    balance: 0,
    currency: '$',
    campaigns: [],
    /* поля пользователя/организации (из charter-panel) */
    organization: '',   /* название организации */
    phone: '',          /* номер телефона */
    orgId: '',          /* идентификатор организации/аккаунта */
    /* рекомендации из charter-panel (если панель их отдаёт) */
    recommendations: null
  };

  /* ---------- helpers DOM ---------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function deepestTextSpan(cell) {
    if (!cell) return null;
    var nt = cell.querySelector('[data-testid="NumberText"]');
    if (nt) return nt;
    var spans = cell.querySelectorAll('span');
    for (var i = spans.length - 1; i >= 0; i--) {
      if (spans[i].children.length === 0) return spans[i];
    }
    return cell;
  }

  function setCellText(testid, text) {
    var cell = $('[data-testid="' + testid + '"]');
    if (!cell) return;
    var span = deepestTextSpan(cell);
    if (span) span.textContent = text;
  }

  function rowsOf(id) {
    var set = [];
    $all('[data-testid*="' + id + '"]').forEach(function (el) {
      var row = el.closest('[class*="Grid_row__"]');
      if (row && set.indexOf(row) === -1) set.push(row);
    });
    return set;
  }

  /* идентификаторы кампаний, реально присутствующих в DOM (включая статическую разметку) */
  function domCampaignIds() {
    var ids = [], seen = {};
    $all('[data-testid^="Grid.Cell-"]').forEach(function (el) {
      var m = (el.getAttribute('data-testid') || '').match(/^Grid\.Cell-([^_]+)_/);
      if (m && !seen[m[1]]) { seen[m[1]] = true; ids.push(m[1]); }
    });
    return ids;
  }

  /* ---------- шаблон строки виртуализированного грида (для добавления кампаний) ---------- */
  var rowTemplates = [];
  var templateTid = null;
  function captureTemplate() {
    var seed = $('[class*="Grid_row__"]');
    if (!seed) return;
    var m = null;
    var idEl = seed.querySelector('[data-testid*="Grid.Cell-"]');
    if (idEl) { m = (idEl.getAttribute('data-testid') || '').match(/Grid\.Cell-([^_]+)_/); }
    if (!m) return;
    templateTid = m[1];
    rowTemplates = rowsOf(templateTid).map(function (r) {
      return { parent: r.parentElement, html: r.outerHTML };
    });
  }

  function domAddCampaign(id) {
    if (!rowTemplates.length || !templateTid) return;
    rowTemplates.forEach(function (t) {
      var html = t.html.split(templateTid).join(id);
      var tmp = document.createElement('div');
      tmp.innerHTML = html;
      var elx = tmp.firstElementChild;
      if (elx) t.parent.appendChild(elx);
    });
  }

  /* ---------- удаление лишней кампании из статической разметки ---------- */
  rowsOf(REMOVED_ID).forEach(function (r) { r.remove(); });
  $all('[data-testid*="' + REMOVED_ID + '"]').forEach(function (el) { el.remove(); });

  /* ---------- пересчёт высоты и позиций сетки ---------- */
  function fixGridHeight() {
    var body = $('[class*="Grid_body"]');
    if (!body) return;
    var rows = $all('[class*="Grid_row__"]', body);
    if (!rows.length) return;
    var top = body.getBoundingClientRect().top;
    var max = 0;
    rows.forEach(function (r) { max = Math.max(max, r.getBoundingClientRect().bottom - top); });
    if (max > 0) {
      var h = Math.ceil(max) + 'px';
      body.style.height = h;
      $all('[class*="Grid_bodyBackground"],[class*="pinnedColumnsLeftBackground"]').forEach(function (bg) { bg.style.height = h; });
    }
  }
  function repositionRows() {
    var offset = 0;
    state.campaigns.forEach(function (c) {
      if (!matchesFilters(c)) return; /* скрытые фильтром строки не занимают место */
      var rs = rowsOf(c.id);
      if (!rs.length) return;
      var h = rs[0].offsetHeight || 86;
      rs.forEach(function (r) { r.style.top = offset + 'px'; });
      offset += h;
    });
    return offset;
  }

  /* ---------- иконки статуса ---------- */
  var ICON_PLAY = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" class="dc-Icon" focusable="false" aria-hidden="true" style="color:#34a853"><path d="M3.1 1.62c0-.9.98-1.46 1.76-1L10.4 3.9a1.16 1.16 0 0 1 0 2l-5.54 3.28c-.78.46-1.76-.1-1.76-1V1.62Z" transform="translate(0 1.4)" fill="currentColor"></path></svg>';
  var ICON_STOP = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" class="dc-Icon dc-Icon_role_main dc-Icon_color_gray" focusable="false" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M2.048 1.323c.26-.16.57-.24 1.001-.282.432-.04.98-.041 1.716-.041h2.47c.735 0 1.284 0 1.716.041.43.041.74.123 1.001.282.296.181.544.43.725.725.16.26.24.57.282 1.001.04.432.041.98.041 1.716v2.47c0 .735 0 1.284-.041 1.716-.041.43-.123.74-.282 1.001-.181.296-.43.544-.725.725-.26.16-.57.24-1.001.282-.432.04-.98.041-1.716.041h-2.47c-.735 0-1.284 0-1.716-.041-.43-.041-.74-.123-1.001-.282a2.195 2.195 0 0 1-.725-.725c-.16-.26-.24-.57-.282-1.001C1.001 8.519 1 7.97 1 7.235v-2.47c0-.735 0-1.284.041-1.716.041-.43.123-.74.282-1.001.181-.296.43-.544.725-.725Z" fill="currentColor"></path></svg>';

  /* ---------- служебный UI: нейтральный загрузчик и меню периода ---------- */
  var css = document.createElement('style');
  css.textContent = [
    ':root{--yda-accent:#7f57ff;--yda-ink:#1f1f26;--yda-bg:#ffffff;--yda-line:#e6e6ee;--yda-mut:#8b8b99}',
    '.yda-pmenu{position:fixed;z-index:100002;background:var(--yda-bg);border:1px solid var(--yda-line);border-radius:12px;box-shadow:0 8px 28px rgba(31,31,38,.18);padding:6px;display:flex;flex-direction:column;min-width:200px;font:400 13px/1.4 "YS Text",Arial,sans-serif}',
    '.yda-pmenu__it{cursor:pointer;border:none;background:transparent;text-align:left;padding:9px 12px;border-radius:8px;color:var(--yda-ink);font:inherit}',
    '.yda-pmenu__it:hover{background:#f2f2f7}',
    '.yda-pmenu__it.sel{background:rgba(127,87,255,.12);color:var(--yda-accent);font-weight:600}',
    /* нейтральный экран загрузки: скрывает исходную разметку до ответа API */
    '.yda-cover{position:fixed;inset:0;z-index:99999;background:#fff;display:flex;align-items:center;justify-content:center;transition:opacity .25s ease}',
    '.yda-cover.hide{opacity:0;pointer-events:none}',
    '.yda-cover__sp{width:40px;height:40px;border-radius:50%;border:3px solid #e6e6ee;border-top-color:var(--yda-accent);animation:yda-spin .8s linear infinite}',
    '@keyframes yda-spin{to{transform:rotate(360deg)}}',
    /* модалка «режим организации» */
    '.yda-ovl{position:fixed;inset:0;z-index:100005;background:rgba(31,31,38,.45);display:flex;align-items:center;justify-content:center}',
    '.yda-modal{background:#fff;border-radius:16px;box-shadow:0 16px 48px rgba(31,31,38,.25);max-width:400px;width:calc(100% - 48px);padding:28px 24px;font:400 14px/1.5 "YS Text",Arial,sans-serif;color:var(--yda-ink);text-align:center}',
    '.yda-modal__ttl{font-size:17px;font-weight:600;margin:0 0 8px}',
    '.yda-modal__tx{color:var(--yda-mut);margin:0 0 20px}',
    '.yda-modal__btn{cursor:pointer;border:none;border-radius:10px;background:#ffdb4d;color:#1f1f26;font:600 14px/1 "YS Text",Arial,sans-serif;padding:12px 28px}',
    '.yda-modal__btn:hover{background:#fed42b}',
    /* сортировка колонок */
    '[data-testid^="Grid.HeaderCell-STAT_"]{cursor:pointer;user-select:none}',
    '.yda-sort{margin-left:3px;font-size:10px;color:var(--yda-accent)}',
    /* чип разворота свёрнутого сайдбара */
    '.yda-sbchip{position:fixed;left:12px;bottom:12px;z-index:100001;width:38px;height:38px;border-radius:50%;background:#fff;border:1px solid var(--yda-line);box-shadow:0 4px 16px rgba(31,31,38,.15);cursor:pointer;font:600 16px/36px "YS Text",Arial,sans-serif;text-align:center;color:var(--yda-ink)}',
    '.yda-sbchip:hover{background:#f2f2f7}',
    /* попап баланса */
    '.yda-pop__hd{font:600 13px/1.2 "YS Text",Arial,sans-serif;color:var(--yda-mut);padding:8px 12px 2px}',
    '.yda-pop__sum{font:700 20px/1.2 "YS Text",Arial,sans-serif;color:var(--yda-ink);padding:2px 12px 10px}',
    /* ---- экраны «Обзор» / «Рекомендации» ---- */
    '.yda-screen{position:fixed;right:0;bottom:0;z-index:99990;background:#f4f4f7;overflow:auto;font-family:"YS Text",Arial,sans-serif}',
    '.yda-screen__wrap{max-width:1200px;margin:0 auto;padding:24px 28px 60px}',
    '.yda-screen__head{margin:0 0 20px}',
    '.yda-screen__title{font:700 28px/1.2 "YS Text",Arial,sans-serif;color:var(--yda-ink);margin:0 0 4px}',
    '.yda-screen__sub{font:400 14px/1.4 "YS Text",Arial,sans-serif;color:var(--yda-mut)}',
    '.yda-cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:0 0 24px}',
    '@media (max-width:900px){.yda-cards{grid-template-columns:repeat(2,1fr)}}',
    '.yda-card{background:#fff;border:1px solid var(--yda-line);border-radius:14px;padding:16px}',
    '.yda-card__lbl{font:400 13px/1.2 "YS Text",Arial,sans-serif;color:var(--yda-mut);margin:0 0 8px}',
    '.yda-card__val{font:700 22px/1.2 "YS Text",Arial,sans-serif;color:var(--yda-ink)}',
    '.yda-card__sub{font:400 12px/1.2 "YS Text",Arial,sans-serif;color:var(--yda-mut);margin-top:6px}',
    '.yda-block{background:#fff;border:1px solid var(--yda-line);border-radius:14px;padding:20px;margin:0 0 16px}',
    '.yda-block__ttl{font:600 16px/1.2 "YS Text",Arial,sans-serif;color:var(--yda-ink);margin:0 0 14px}',
    '.yda-table{width:100%;border-collapse:collapse;font:400 13px/1.4 "YS Text",Arial,sans-serif}',
    '.yda-table th{text-align:left;color:var(--yda-mut);font-weight:500;padding:8px 10px;border-bottom:1px solid var(--yda-line);white-space:nowrap}',
    '.yda-table td{padding:10px;border-bottom:1px solid #f0f0f4;color:var(--yda-ink)}',
    '.yda-t__num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.yda-t__name{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.yda-t__empty{text-align:center;color:var(--yda-mut);padding:24px}',
    '.yda-badge{display:inline-block;font:500 12px/1 "YS Text",Arial,sans-serif;padding:5px 9px;border-radius:8px}',
    '.yda-badge_on{background:#e6f5ea;color:#188038}',
    '.yda-badge_off{background:#f0f0f4;color:#7b7b85}',
    '.yda-recs{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}',
    '@media (max-width:900px){.yda-recs{grid-template-columns:1fr}}',
    '.yda-rec{border:1px solid var(--yda-line);border-radius:12px;padding:14px 16px;background:#fbfbfd}',
    '.yda-rec__top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 6px}',
    '.yda-rec__ttl{font:600 15px/1.3 "YS Text",Arial,sans-serif;color:var(--yda-ink)}',
    '.yda-rec__impact{flex:none;font:600 12px/1 "YS Text",Arial,sans-serif;color:#188038;background:#e6f5ea;border-radius:8px;padding:5px 8px}',
    '.yda-rec__tx{font:400 13px/1.5 "YS Text",Arial,sans-serif;color:var(--yda-mut)}',
    '.yda-rec__camp{font:400 12px/1.3 "YS Text",Arial,sans-serif;color:#9a9aa2;margin-top:8px}',
    /* ---- окно организации (аватар) ---- */
    '.yda-uw{position:fixed;z-index:100002;width:320px;background:#fff;border:1px solid var(--yda-line);border-radius:16px;box-shadow:0 12px 40px rgba(31,31,38,.22);padding:16px;font-family:"YS Text",Arial,sans-serif}',
    '.yda-uw__hd{display:flex;align-items:center;gap:12px;padding:0 0 14px;border-bottom:1px solid #f0f0f4;margin:0 0 12px}',
    '.yda-uw__ava{flex:none;width:44px;height:44px;border-radius:50%;background:#ffdb4d;color:#1f1f26;font:700 20px/44px "YS Text",Arial,sans-serif;text-align:center}',
    '.yda-uw__org{font:600 15px/1.2 "YS Text",Arial,sans-serif;color:var(--yda-ink);word-break:break-word}',
    '.yda-uw__login{font:400 13px/1.3 "YS Text",Arial,sans-serif;color:var(--yda-mut);margin-top:2px}',
    '.yda-uw__row{display:flex;justify-content:space-between;gap:12px;padding:7px 0}',
    '.yda-uw__k{font:400 13px/1.3 "YS Text",Arial,sans-serif;color:var(--yda-mut);flex:none}',
    '.yda-uw__v{font:500 13px/1.3 "YS Text",Arial,sans-serif;color:var(--yda-ink);text-align:right;word-break:break-word}'
  ].join('\n');
  /* Инъекция стилей отложена: на direct.yandex.ru скрипт стартует при
     document_start, когда document.head ещё не существует. Вызывается из init(). */
  var stylesInjected = false;
  function injectStyles() {
    if (stylesInjected) return;
    var head = document.head || document.documentElement;
    if (!head) return;
    head.appendChild(css);
    stylesInjected = true;
  }

  /* ---------- экран загрузки (скрывает разметку до ответа API) ---------- */
  var cover = null, firstLoaded = false;
  function mountCover() {
    if (cover || firstLoaded) return;
    cover = document.createElement('div');
    cover.className = 'yda-cover';
    cover.innerHTML = '<div class="yda-cover__sp"></div>';
    (document.body || document.documentElement).appendChild(cover);
  }
  function markLoaded() {
    if (firstLoaded) return;
    firstLoaded = true;
    if (cover) {
      cover.classList.add('hide');
      setTimeout(function () { if (cover) { cover.remove(); cover = null; } }, 300);
    }
  }
  /* Заглушку монтируем из init() — на direct.yandex.ru DOM может быть ещё не готов. */

  /* Индикатор синхронизации/периода.
   * По умолчанию отключён (страница выглядит как настоящий Директ).
   * Включается флагом DEBUG (config.js: debug:true либо URL ?debug=1) —
   * тогда внизу справа видно: активный период, режим live и предупреждение,
   * если панель вернула НЕ тот период, что был запрошен. */
  var syncBadge = null;
  var SYNC_COLORS = { ok: '#2f7d32', pend: '#8a6d00', err: '#b3261e', warn: '#8a4b00' };
  function setSync(stateName, msg) {
    if (!DEBUG) return;
    try {
      if (!syncBadge) {
        syncBadge = document.createElement('div');
        syncBadge.className = 'yda-sync';
        syncBadge.style.cssText =
          'position:fixed;right:12px;bottom:12px;z-index:2147483647;max-width:360px;' +
          'padding:8px 12px;border-radius:8px;font:12px/1.4 Arial,sans-serif;color:#fff;' +
          'box-shadow:0 4px 16px rgba(0,0,0,.25);pointer-events:none;white-space:normal;';
        (document.body || document.documentElement).appendChild(syncBadge);
      }
      syncBadge.style.background = SYNC_COLORS[stateName] || '#333';
      syncBadge.textContent = msg || '';
    } catch (_e) { /* noop */ }
  }

  /* ---------- рендер ---------- */
  /* Ячейка «Бюджет и стратегия»: работаем с текстовыми узлами напрямую,
     т.к. " в неделю" — текстовый узел внутри общего span, а не отдельный элемент.
     Узлы кэшируем на элементе, чтобы после очистки их можно было восстановить. */
  function renderBudgetCell(cell, weeklyBudget, strategy) {
    if (!cell.__budgetNodes) {
      var w = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT, null);
      var all = [], node;
      while ((node = w.nextNode())) { if (node.nodeValue && node.nodeValue.trim()) all.push(node); }
      if (!all.length) return;
      var per = null;
      for (var i = 1; i < all.length; i++) if (/недел/.test(all[i].nodeValue)) { per = all[i]; break; }
      var last = all[all.length - 1];
      cell.__budgetNodes = {
        money: all[0],
        per: per,
        strategy: (last !== all[0] && last !== per) ? last : null
      };
    }
    var nn = cell.__budgetNodes;
    if (weeklyBudget) {
      nn.money.nodeValue = fmtMoney(weeklyBudget) + NBSP + state.currency;
      if (nn.per) nn.per.nodeValue = ' в' + NBSP + 'неделю';
    } else {
      nn.money.nodeValue = 'Без' + NBSP + 'ограничения';
      if (nn.per) nn.per.nodeValue = '';
    }
    if (nn.strategy && strategy != null) nn.strategy.nodeValue = strategy;
  }

  function campaignDerived(c) {
    return {
      cpa: c.goals ? c.cost / c.goals : 0,
      cpc: c.clicks ? c.cost / c.clicks : 0,
      ctr: c.shows ? (c.clicks / c.shows) * 100 : 0,
      cpm: c.shows ? (c.cost / c.shows) * 1000 : 0,
      cr: c.clicks ? (c.goals / c.clicks) * 100 : 0,
      crr: c.revenue ? (c.cost / c.revenue) * 100 : 0,          /* ДРР, % */
      roi: c.cost ? ((c.revenue - c.cost) / c.cost) * 100 : 0   /* ROI, % */
    };
  }

  function renderCampaign(c) {
    var d = campaignDerived(c);
    setCellText('Grid.Cell-' + c.id + '_STAT_COST', fmtMoney(c.cost));
    setCellText('Grid.Cell-' + c.id + '_STAT_SHOWS', fmtInt(c.shows));
    setCellText('Grid.Cell-' + c.id + '_STAT_CLICKS', fmtInt(c.clicks));
    setCellText('Grid.Cell-' + c.id + '_STAT_GOALS', fmtInt(c.goals));
    setCellText('Grid.Cell-' + c.id + '_STAT_AVG_GOAL_COST', fmtMoney(d.cpa));
    setCellText('Grid.Cell-' + c.id + '_STAT_AVG_CLICK_COST', fmtMoney(d.cpc));
    setCellText('Grid.Cell-' + c.id + '_STAT_CTR', fmtPct(d.ctr));
    setCellText('Grid.Cell-' + c.id + '_STAT_CPM_PRICE', fmtMoney(d.cpm));
    setCellText('Grid.Cell-' + c.id + '_STAT_CONVERSION_RATE', fmtPct(d.cr));
    setCellText('Grid.Cell-' + c.id + '_STAT_BOUNCE_RATE', fmtPct(c.bounce));
    setCellText('Grid.Cell-' + c.id + '_STAT_REVENUE', fmtMoney(c.revenue));
    setCellText('Grid.Cell-' + c.id + '_STAT_CRR', fmtPct(d.crr));
    setCellText('Grid.Cell-' + c.id + '_STAT_PROFITABILITY', fmtPct(d.roi));
    setCellText('Grid.Cell-' + c.id + '_start_date', c.startDate || TODAY_STR);
    var platCell = $('[data-testid="Grid.Cell-' + c.id + '_platform"] [data-testid="CampaignPlatformCell"]');
    if (platCell && c.platform) {
      var pSpan = deepestTextSpan(platCell);
      if (pSpan) pSpan.textContent = c.platform;
    }
    var sbCell = $('[data-testid="Grid.Cell-' + c.id + '_strategyAndBudget"]');
    if (sbCell) renderBudgetCell(sbCell, c.weeklyBudget, c.strategy);
    var nameLink = $('[data-testid="Grid.Cell-' + c.id + '_name-with-links"] a[data-testid="CampaignNameCell.Name.Link"]');
    if (nameLink) nameLink.textContent = c.name;
    var stCell = $('[data-testid="Grid.Cell-' + c.id + '_aggregated-status-info"]');
    if (stCell) {
      var stText = stCell.querySelector('[data-testid="AggregatedStatusContent"]');
      if (stText) {
        stText.textContent = c.status === 'running' ? 'Идут показы' : 'Остановлена';
        stText.style.color = c.status === 'running' ? '#1f1f26' : '';
      }
      var iconHolder = stCell.querySelector('svg');
      if (iconHolder) {
        var wrap = document.createElement('span');
        wrap.innerHTML = c.status === 'running' ? ICON_PLAY : ICON_STOP;
        iconHolder.replaceWith(wrap.firstChild);
      }
    }
  }

  function renderTotals() {
    var cost = 0, shows = 0, clicks = 0, goals = 0, bounceSum = 0, revenue = 0, budgetSum = 0;
    /* итоги считаются по видимым (после фильтров) кампаниям */
    visibleCampaigns().forEach(function (c) {
      cost += c.cost; shows += c.shows; clicks += c.clicks; goals += c.goals;
      bounceSum += c.bounce * c.clicks; revenue += c.revenue; budgetSum += c.weeklyBudget;
    });
    /* бюджет в строке «Итого» = сумма недельных бюджетов кампаний */
    var totalBudgetCell = $('[data-testid="Grid.HeaderCell-strategyAndBudget"] [data-testid="TextTooltipCell.Text"]');
    if (totalBudgetCell) renderBudgetCell(totalBudgetCell, budgetSum, null);
    setCellText('StatsTotalCell.cost', fmtMoney(cost));
    setCellText('StatsTotalCell.shows', fmtInt(shows));
    setCellText('StatsTotalCell.clicks', fmtInt(clicks));
    setCellText('StatsTotalCell.goals', fmtInt(goals));
    setCellText('StatsTotalCell.avgGoalCost', fmtMoney(goals ? cost / goals : 0));
    setCellText('StatsTotalCell.avgClickCost', fmtMoney(clicks ? cost / clicks : 0));
    setCellText('StatsTotalCell.ctr', fmtPct(shows ? clicks / shows * 100 : 0));
    setCellText('StatsTotalCell.conversionRate', fmtPct(clicks ? goals / clicks * 100 : 0));
    setCellText('StatsTotalCell.bounceRate', fmtPct(clicks ? bounceSum / clicks : 0));
    setCellText('StatsTotalCell.purchaseRevenue', fmtMoney(revenue));
    setCellText('StatsTotalCell.purchaseProfitability', fmtPct(cost ? (revenue - cost) / cost * 100 : 0));
  }

  var balanceSpan = null;
  function findBalance() {
    if (balanceSpan && document.contains(balanceSpan)) return balanceSpan;
    var spans = $all('span');
    for (var i = 0; i < spans.length; i++) {
      if (/^\d[\d\s\u00a0]*,\d{2}[\s\u00a0].{1,3}$/.test(spans[i].textContent.trim()) && spans[i].children.length === 0) {
        balanceSpan = spans[i];
        return balanceSpan;
      }
    }
    return null;
  }
  function renderBalance() {
    var el = findBalance();
    if (el) el.textContent = fmtMoney(state.balance) + NBSP + state.currency;
  }

  function renderPeriod() {
    var el = $('[data-testid="PeriodFilterSelect.HiddenInput"]');
    if (el) {
      var vis = el.closest('button, [role="button"], div');
      var span = vis && vis.parentElement ? vis.parentElement.querySelector('span[title]') : null;
      if (!span) {
        $all('span[title]').some(function (s) {
          if (/Последние|Сегодня|дней|дня/.test(s.getAttribute('title') || '')) { span = s; return true; }
          return false;
        });
      }
      if (span) { span.textContent = PERIOD_LABEL; span.setAttribute('title', PERIOD_LABEL); }
    }
  }

  /* ---------- логин (из API) ---------- */
  function renderLogin(login) {
    login = String(login || '').trim();
    if (!login || login === currentLogin) return;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var nodes = [], n;
    while ((n = walker.nextNode())) nodes.push(n);
    nodes.forEach(function (t) {
      var v = t.nodeValue;
      if (v && (v.indexOf(currentLogin) !== -1 || v.indexOf(STATIC_LOGIN) !== -1)) {
        t.nodeValue = v.split(currentLogin).join(login).split(STATIC_LOGIN).join(login);
      }
    });
    /* обновляем и атрибуты title/aria, где мог остаться логин */
    $all('[title], [aria-label]').forEach(function (elx) {
      ['title', 'aria-label'].forEach(function (attr) {
        var a = elx.getAttribute(attr);
        if (a && (a.indexOf(currentLogin) !== -1 || a.indexOf(STATIC_LOGIN) !== -1)) {
          elx.setAttribute(attr, a.split(currentLogin).join(login).split(STATIC_LOGIN).join(login));
        }
      });
    });
    currentLogin = login;
    LOGIN = login;
    document.title = 'Кампании — ' + login + ' — Директ';
  }

  function renderAll() {
    state.campaigns.forEach(renderCampaign);
    renderTotals();
    renderBalance();
    renderPeriod();
  }
  function renderAndFix() {
    applySortToState();
    renderAll();
    applyRowVisibility();
    repositionRows();
    fixGridHeight();
  }

  /* ---------- интерактив: рабочие функции + режим организации ---------- */
  var ORG_MSG = 'Вы находитесь в режиме организации. Обратитесь к своему администратору за помощью.';

  var orgOvl = null;
  function closeOrgModal() { if (orgOvl) { orgOvl.remove(); orgOvl = null; } }
  function showOrgModal() {
    if (orgOvl) return;
    orgOvl = el('div', 'yda-ovl');
    var m = el('div', 'yda-modal');
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    m.innerHTML =
      '<p class="yda-modal__ttl">Действие недоступно</p>' +
      '<p class="yda-modal__tx">' + ORG_MSG + '</p>' +
      '<button type="button" class="yda-modal__btn">Понятно</button>';
    orgOvl.appendChild(m);
    orgOvl.addEventListener('click', function (e) { if (e.target === orgOvl) closeOrgModal(); });
    m.querySelector('.yda-modal__btn').addEventListener('click', closeOrgModal);
    document.body.appendChild(orgOvl);
    m.querySelector('.yda-modal__btn').focus();
  }

  /* ---------- универсальное выпадающее меню ---------- */
  var choiceMenu = null;
  function closeChoiceMenu() { if (choiceMenu) { choiceMenu.remove(); choiceMenu = null; } }
  function openChoiceMenu(anchor, items, cb) {
    closeChoiceMenu();
    var r = anchor.getBoundingClientRect();
    choiceMenu = el('div', 'yda-pmenu');
    items.forEach(function (it) {
      var b = el('button', 'yda-pmenu__it' + (it.sel ? ' sel' : ''), it.label);
      b.type = 'button';
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        closeChoiceMenu();
        cb(it.v);
      });
      choiceMenu.appendChild(b);
    });
    choiceMenu.style.left = Math.round(r.left) + 'px';
    choiceMenu.style.top = Math.round(r.bottom + 4) + 'px';
    document.body.appendChild(choiceMenu);
    setTimeout(function () {
      document.addEventListener('click', function onDoc(e) {
        if (choiceMenu && !choiceMenu.contains(e.target)) closeChoiceMenu();
        document.removeEventListener('click', onDoc, true);
      }, true);
    }, 0);
  }

  /* ---------- фильтры: статус и тип кампании ---------- */
  var statusFilter = 'all', typeFilter = 'all';
  function matchesFilters(c) {
    if (statusFilter !== 'all' && c.status !== statusFilter) return false;
    if (typeFilter !== 'all' && c.type !== typeFilter) return false;
    return true;
  }
  function visibleCampaigns() { return state.campaigns.filter(matchesFilters); }
  function applyRowVisibility() {
    state.campaigns.forEach(function (c) {
      var show = matchesFilters(c);
      rowsOf(c.id).forEach(function (r) { r.style.display = show ? '' : 'none'; });
    });
  }
  function setSelectLabel(sel, label) {
    var s = deepestTextSpan(sel);
    if (s) s.textContent = label;
  }
  var STATUS_OPTS = [
    { v: 'all', label: 'Все, кроме архивных' },
    { v: 'running', label: 'Идут показы' },
    { v: 'stopped', label: 'Остановлены' }
  ];
  function openStatusMenu(anchor) {
    openChoiceMenu(anchor, STATUS_OPTS.map(function (o) {
      return { v: o.v, label: o.label, sel: o.v === statusFilter };
    }), function (v) {
      statusFilter = v;
      var opt = STATUS_OPTS.filter(function (o) { return o.v === v; })[0];
      setSelectLabel(anchor, opt.label);
      renderAndFix();
    });
  }
  function openTypeMenu(anchor) {
    var types = [];
    state.campaigns.forEach(function (c) { if (types.indexOf(c.type) === -1) types.push(c.type); });
    var items = [{ v: 'all', label: 'Все типы кампаний', sel: typeFilter === 'all' }];
    types.forEach(function (t) { items.push({ v: t, label: t, sel: typeFilter === t }); });
    openChoiceMenu(anchor, items, function (v) {
      typeFilter = v;
      setSelectLabel(anchor, v === 'all' ? 'Все типы кампаний' : v);
      renderAndFix();
    });
  }

  /* ---------- сортировка по колонкам статистики ---------- */
  var sortKey = null, sortDir = -1;
  var SORT_KEYS = {
    STAT_COST: function (c) { return c.cost; },
    STAT_SHOWS: function (c) { return c.shows; },
    STAT_CLICKS: function (c) { return c.clicks; },
    STAT_GOALS: function (c) { return c.goals; },
    STAT_AVG_GOAL_COST: function (c, d) { return d.cpa; },
    STAT_AVG_CLICK_COST: function (c, d) { return d.cpc; },
    STAT_CTR: function (c, d) { return d.ctr; },
    STAT_REVENUE: function (c) { return c.revenue; },
    STAT_CRR: function (c, d) { return d.crr; },
    STAT_CPM_PRICE: function (c, d) { return d.cpm; },
    STAT_CONVERSION_RATE: function (c, d) { return d.cr; },
    STAT_BOUNCE_RATE: function (c) { return c.bounce; },
    STAT_PROFITABILITY: function (c, d) { return d.roi; }
  };
  function applySortToState() {
    if (!sortKey || !SORT_KEYS[sortKey]) return;
    var g = SORT_KEYS[sortKey];
    state.campaigns.sort(function (a, b) {
      return (g(a, campaignDerived(a)) - g(b, campaignDerived(b))) * sortDir;
    });
  }
  function updateSortMarks() {
    $all('.yda-sort').forEach(function (s) { s.remove(); });
    if (!sortKey) return;
    $all('[data-testid="Grid.HeaderCell-' + sortKey + '"]').forEach(function (h) {
      var mark = el('span', 'yda-sort', sortDir < 0 ? '\u25BC' : '\u25B2');
      h.appendChild(mark);
    });
  }
  function toggleSort(key) {
    if (sortKey === key) {
      if (sortDir === -1) sortDir = 1;
      else { sortKey = null; sortDir = -1; } /* третий клик — сброс */
    } else { sortKey = key; sortDir = -1; }
    updateSortMarks();
    renderAndFix();
  }

  /* ---------- сворачивание сайдбара ---------- */
  var sbChip = null;
  function toggleSidebar() {
    var sb = $('.rmp-page-sidebar');
    if (!sb) return;
    var collapsed = sb.style.display === 'none';
    if (collapsed) {
      sb.style.display = '';
      if (sbChip) { sbChip.remove(); sbChip = null; }
    } else {
      sb.style.display = 'none';
      sbChip = el('button', 'yda-sbchip', '\u00BB');
      sbChip.type = 'button';
      sbChip.title = 'Развернуть меню';
      sbChip.addEventListener('click', function (e) { e.stopPropagation(); toggleSidebar(); });
      document.body.appendChild(sbChip);
    }
    setTimeout(fixGridHeight, 50);
  }

  /* ---------- попап баланса ---------- */
  function openBalancePop(anchor) {
    closeChoiceMenu();
    var r = anchor.getBoundingClientRect();
    choiceMenu = el('div', 'yda-pmenu');
    choiceMenu.innerHTML =
      '<div class="yda-pop__hd">Баланс счёта</div>' +
      '<div class="yda-pop__sum">' + fmtMoney(state.balance) + NBSP + state.currency + '</div>';
    choiceMenu.style.left = Math.round(r.left) + 'px';
    choiceMenu.style.top = Math.round(r.bottom + 4) + 'px';
    document.body.appendChild(choiceMenu);
    setTimeout(function () {
      document.addEventListener('click', function onDoc(e) {
        if (choiceMenu && !choiceMenu.contains(e.target)) closeChoiceMenu();
        document.removeEventListener('click', onDoc, true);
      }, true);
    }, 0);
  }

  /* ================================================================
   *  ЭКРАНЫ «ОБЗОР» И «РЕКОМЕНДАЦИИ» (на наших данных из charter-panel)
   * ================================================================ */
  var activeScreen = null;      /* 'overview' | 'recommendations' | null */
  var screenEl = null;

  /* область контента справа от сайдбара и ниже шапки */
  function contentBox() {
    var sb = $('.rmp-page-sidebar');
    var head = $('[data-testid="PageHead"]');
    var left = 0, top = 0;
    if (sb && sb.style.display !== 'none') {
      var r = sb.getBoundingClientRect();
      left = Math.max(0, Math.round(r.right));
    }
    if (head) {
      var h = head.getBoundingClientRect();
      top = Math.max(0, Math.round(h.bottom));
    }
    return { left: left, top: top };
  }

  function positionScreen() {
    if (!screenEl) return;
    var b = contentBox();
    screenEl.style.left = b.left + 'px';
    screenEl.style.top = b.top + 'px';
  }

  function closeScreen() {
    if (screenEl) { screenEl.remove(); screenEl = null; }
    activeScreen = null;
    setActiveNav('campaigns');
  }

  /* подсветка активного пункта меню */
  function setActiveNav(kind) {
    var map = { campaigns: 'SidebarLink.campaigns', overview: 'SidebarLink.overview', recommendations: 'SidebarLink.recommendations' };
    Object.keys(map).forEach(function (k) {
      var link = $('[data-testid="' + map[k] + '"]');
      if (!link) return;
      var item = link.closest('.dc-SidebarItem') || link;
      if (k === kind) item.classList.add('dc-SidebarItem_active', 'yda-nav-active');
      else item.classList.remove('yda-nav-active');
    });
  }

  function openScreen(kind) {
    if (!screenEl) {
      screenEl = el('div', 'yda-screen');
      document.body.appendChild(screenEl);
    }
    activeScreen = kind;
    setActiveNav(kind);
    positionScreen();
    renderScreen(kind);
  }

  function renderScreen(kind) {
    if (!screenEl) return;
    if (kind === 'overview') screenEl.innerHTML = buildOverviewHTML();
    else if (kind === 'recommendations') screenEl.innerHTML = buildRecommendationsHTML();
    positionScreen();
  }

  /* ---------- «Обзор»: агрегаты по нашим кампаниям ---------- */
  function aggregate() {
    var a = { cost: 0, shows: 0, clicks: 0, goals: 0, revenue: 0, active: 0, total: 0 };
    state.campaigns.forEach(function (c) {
      a.total++;
      if (c.status === 'running') a.active++;
      a.cost += c.cost; a.shows += c.shows; a.clicks += c.clicks;
      a.goals += c.goals; a.revenue += c.revenue;
    });
    a.ctr = a.shows ? (a.clicks / a.shows * 100) : 0;
    a.cpc = a.clicks ? (a.cost / a.clicks) : 0;
    a.cpa = a.goals ? (a.cost / a.goals) : 0;
    a.cr = a.clicks ? (a.goals / a.clicks * 100) : 0;
    return a;
  }

  function metricCard(label, value, sub) {
    return '<div class="yda-card">' +
      '<div class="yda-card__lbl">' + label + '</div>' +
      '<div class="yda-card__val">' + value + '</div>' +
      (sub ? '<div class="yda-card__sub">' + sub + '</div>' : '') +
      '</div>';
  }

  function buildOverviewHTML() {
    var a = aggregate();
    var cur = NBSP + state.currency;
    var cards =
      metricCard('Расход', fmtMoney(a.cost) + cur, PERIOD_LABEL) +
      metricCard('Показы', fmtInt(a.shows), 'всего') +
      metricCard('Клики', fmtInt(a.clicks), 'CTR ' + fmtPct(a.ctr) + '%') +
      metricCard('Конверсии', fmtInt(a.goals), 'CR ' + fmtPct(a.cr) + '%') +
      metricCard('Цена клика', fmtMoney(a.cpc) + cur, 'средняя') +
      metricCard('Цена конверсии', fmtMoney(a.cpa) + cur, 'средняя') +
      metricCard('Баланс', fmtMoney(state.balance) + cur, 'счёт') +
      metricCard('Кампании', fmtInt(a.active) + ' / ' + fmtInt(a.total), 'активных / всего');

    var rows = state.campaigns.map(function (c) {
      var d = campaignDerived(c);
      return '<tr>' +
        '<td class="yda-t__name">' + escapeHTML(c.name) + '</td>' +
        '<td>' + (c.status === 'running' ? '<span class="yda-badge yda-badge_on">Идут показы</span>' : '<span class="yda-badge yda-badge_off">Остановлена</span>') + '</td>' +
        '<td class="yda-t__num">' + fmtMoney(c.cost) + '</td>' +
        '<td class="yda-t__num">' + fmtInt(c.shows) + '</td>' +
        '<td class="yda-t__num">' + fmtInt(c.clicks) + '</td>' +
        '<td class="yda-t__num">' + fmtPct(d.ctr) + '%</td>' +
        '<td class="yda-t__num">' + fmtInt(c.goals) + '</td>' +
        '</tr>';
    }).join('');
    if (!rows) rows = '<tr><td colspan="7" class="yda-t__empty">Нет кампаний</td></tr>';

    return '' +
      '<div class="yda-screen__wrap">' +
        '<div class="yda-screen__head"><h1 class="yda-screen__title">Обзор</h1>' +
          '<div class="yda-screen__sub">' + escapeHTML(state.organization || currentLogin) + ' · ' + PERIOD_LABEL + '</div></div>' +
        '<div class="yda-cards">' + cards + '</div>' +
        '<div class="yda-block"><div class="yda-block__ttl">Кампании</div>' +
          '<table class="yda-table"><thead><tr>' +
            '<th>Кампания</th><th>Статус</th><th class="yda-t__num">Расход</th><th class="yda-t__num">Показы</th>' +
            '<th class="yda-t__num">Клики</th><th class="yda-t__num">CTR</th><th class="yda-t__num">Конверсии</th>' +
          '</tr></thead><tbody>' + rows + '</tbody></table>' +
        '</div>' +
      '</div>';
  }

  /* ---------- «Рекомендации»: из API либо вычисленные по логике ---------- */
  function computeRecommendations() {
    /* если панель отдала свои рекомендации — используем их */
    if (state.recommendations && state.recommendations.length) return state.recommendations;
    /* иначе формируем по логике наших кампаний */
    var out = [];
    state.campaigns.forEach(function (c) {
      var d = campaignDerived(c);
      if (c.status === 'running' && c.cost > 0 && c.goals === 0) {
        out.push({ id: 'r-conv-' + c.id, title: 'Настройте конверсии', category: 'Конверсии',
          campaign: c.name, impact: 'экономия бюджета',
          text: 'Кампания расходует бюджет, но не приносит конверсий. Проверьте цели и корректность счётчика Метрики.' });
      }
      if (c.status === 'running' && c.shows > 500 && d.ctr < 3) {
        out.push({ id: 'r-ctr-' + c.id, title: 'Повысьте CTR объявлений', category: 'Объявления',
          campaign: c.name, impact: '+CTR',
          text: 'Низкий CTR (' + fmtPct(d.ctr) + '%). Добавьте быстрые ссылки, уточнения и релевантные заголовки.' });
      }
      if (c.status === 'stopped' && c.cost === 0) {
        out.push({ id: 'r-run-' + c.id, title: 'Возобновите показы', category: 'Показы',
          campaign: c.name, impact: '+трафик',
          text: 'Кампания остановлена и не получает трафик. Запустите её, если она актуальна.' });
      }
      if (c.status === 'running' && c.bounce > 30) {
        out.push({ id: 'r-bounce-' + c.id, title: 'Снизьте отказы', category: 'Качество',
          campaign: c.name, impact: '-отказы',
          text: 'Высокий процент отказов (' + fmtPct(c.bounce) + '%). Проверьте релевантность посадочной страницы.' });
      }
    });
    if (state.balance <= 0) {
      out.push({ id: 'r-balance', title: 'Пополните счёт', category: 'Бюджет', campaign: '', impact: 'без простоев',
        text: 'Баланс исчерпан — показы могут остановиться. Пополните счёт, чтобы не терять трафик.' });
    }
    if (!out.length) {
      out.push({ id: 'r-ok', title: 'Всё в порядке', category: 'Общие', campaign: '', impact: '',
        text: 'Критичных проблем не обнаружено. Продолжайте отслеживать показатели кампаний.' });
    }
    return out;
  }

  function buildRecommendationsHTML() {
    var recs = computeRecommendations();
    /* группировка по категориям */
    var groups = {}; var order = [];
    recs.forEach(function (r) {
      if (!groups[r.category]) { groups[r.category] = []; order.push(r.category); }
      groups[r.category].push(r);
    });
    var blocks = order.map(function (cat) {
      var cards = groups[cat].map(function (r) {
        return '<div class="yda-rec">' +
          '<div class="yda-rec__top">' +
            '<div class="yda-rec__ttl">' + escapeHTML(r.title) + '</div>' +
            (r.impact ? '<span class="yda-rec__impact">' + escapeHTML(r.impact) + '</span>' : '') +
          '</div>' +
          '<div class="yda-rec__tx">' + escapeHTML(r.text) + '</div>' +
          (r.campaign ? '<div class="yda-rec__camp">Кампания: ' + escapeHTML(r.campaign) + '</div>' : '') +
        '</div>';
      }).join('');
      return '<div class="yda-block"><div class="yda-block__ttl">' + escapeHTML(cat) + '</div>' +
        '<div class="yda-recs">' + cards + '</div></div>';
    }).join('');

    return '' +
      '<div class="yda-screen__wrap">' +
        '<div class="yda-screen__head"><h1 class="yda-screen__title">Рекомендации</h1>' +
          '<div class="yda-screen__sub">' + escapeHTML(state.organization || currentLogin) + ' · найдено ' + recs.length + '</div></div>' +
        blocks +
      '</div>';
  }

  /* ---------- окно организации (аватар/пользователь справа) ---------- */
  var orgWidget = null;
  function closeOrgWidget() { if (orgWidget) { orgWidget.remove(); orgWidget = null; } }
  function showOrgWidget(anchor) {
    closeOrgWidget();
    var login = currentLogin || LOGIN || '—';
    var org = state.organization || '—';
    var phone = state.phone || '—';
    var id = state.orgId || '—';
    var initial = (org && org !== '—' ? org : login).charAt(0).toUpperCase();

    orgWidget = el('div', 'yda-uw');
    orgWidget.setAttribute('role', 'dialog');
    orgWidget.setAttribute('aria-modal', 'true');
    orgWidget.innerHTML =
      '<div class="yda-uw__hd">' +
        '<div class="yda-uw__ava">' + escapeHTML(initial) + '</div>' +
        '<div class="yda-uw__id">' +
          '<div class="yda-uw__org">' + escapeHTML(org) + '</div>' +
          '<div class="yda-uw__login">' + escapeHTML(login) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="yda-uw__rows">' +
        '<div class="yda-uw__row"><span class="yda-uw__k">Организация</span><span class="yda-uw__v">' + escapeHTML(org) + '</span></div>' +
        '<div class="yda-uw__row"><span class="yda-uw__k">Логин</span><span class="yda-uw__v">' + escapeHTML(login) + '</span></div>' +
        '<div class="yda-uw__row"><span class="yda-uw__k">Телефон</span><span class="yda-uw__v">' + escapeHTML(phone) + '</span></div>' +
        '<div class="yda-uw__row"><span class="yda-uw__k">Идентификатор</span><span class="yda-uw__v">' + escapeHTML(id) + '</span></div>' +
      '</div>';

    document.body.appendChild(orgWidget);
    /* позиционирование: под/над якорем, прижато к правому краю как в оригинале */
    var w = orgWidget.getBoundingClientRect();
    var top = 8, left = window.innerWidth - w.width - 16;
    if (anchor && anchor.getBoundingClientRect) {
      var r = anchor.getBoundingClientRect();
      top = Math.round(r.bottom + 6);
      left = Math.round(Math.min(r.left, window.innerWidth - w.width - 16));
      if (top + w.height > window.innerHeight - 8) top = Math.max(8, Math.round(r.top - w.height - 6));
    }
    orgWidget.style.top = Math.max(8, top) + 'px';
    orgWidget.style.left = Math.max(8, left) + 'px';

    setTimeout(function () {
      document.addEventListener('click', function onDoc(e) {
        if (orgWidget && !orgWidget.contains(e.target)) closeOrgWidget();
        else document.addEventListener('click', onDoc, true);
        document.removeEventListener('click', onDoc, true);
      }, true);
    }, 0);
  }

  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------- маршрутизация кликов ---------- */
  function wireInteractions() {
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      /* собственный UI не трогаем */
      if (t.closest('.yda-pmenu, .yda-ovl, .yda-sbchip, .yda-cover, .yda-screen, .yda-uw')) return;
      /* период — отдельный обработчик */
      if (t.closest('[data-testid*="PeriodFilterSelect"]')) return;

      var elx;

      /* --- навигация: наши экраны на данных charter-panel --- */
      if (t.closest('[data-testid="SidebarLink.overview"]')) {
        e.preventDefault(); e.stopPropagation(); openScreen('overview'); return;
      }
      if (t.closest('[data-testid="SidebarLink.recommendations"]')) {
        e.preventDefault(); e.stopPropagation(); openScreen('recommendations'); return;
      }
      /* «Кампании» — закрываем наш экран и возвращаемся к таблице */
      if (t.closest('[data-testid="PageHead.TabMenu.campaigns"], [data-testid="SidebarLink.campaigns"]')) {
        e.preventDefault(); e.stopPropagation();
        if (activeScreen) closeScreen();
        return;
      }
      /* --- аватар/пользователь справа: окно организации --- */
      if ((elx = t.closest('[data-testid="SidebarUserControl"], [data-testid="Sidebar.SidebarUserControl"], [data-testid="UserBar"]'))) {
        e.preventDefault(); e.stopPropagation(); showOrgWidget(elx); return;
      }
      /* рабочие функции */
      if ((elx = t.closest('[data-testid="CampaignsStatusFilterSelect"]'))) {
        e.preventDefault(); e.stopPropagation(); openStatusMenu(elx); return;
      }
      if ((elx = t.closest('[data-testid="CampaignsGridDimensionSelect"]'))) {
        e.preventDefault(); e.stopPropagation(); openTypeMenu(elx); return;
      }
      var hd = t.closest('[data-testid^="Grid.HeaderCell-STAT_"]');
      if (hd) {
        e.preventDefault(); e.stopPropagation();
        toggleSort(hd.getAttribute('data-testid').replace('Grid.HeaderCell-', ''));
        return;
      }
      if (t.closest('[data-testid="SidebarExpandButton"]')) {
        e.preventDefault(); e.stopPropagation(); toggleSidebar(); return;
      }
      /* кнопка баланса в сайдбаре */
      var btn = t.closest('button');
      if (btn && btn.closest('.rmp-page-sidebar') && /\d[\d\s\u00a0.,]*\s?[$₽€¥£₴₸]/.test(btn.textContent)) {
        e.preventDefault(); e.stopPropagation(); openBalancePop(btn); return;
      }
      /* текущая вкладка/раздел «Кампании» — уже здесь, ничего не делаем */
      if (t.closest('[data-testid="PageHead.TabMenu.campaigns"], [data-testid="SidebarLink.campaigns"]')) {
        e.preventDefault(); e.stopPropagation(); return;
      }
      /* чекбоксы выбора строк — нативное поведение */
      if (t.closest('input[type="checkbox"]')) return;

      /* ссылки */
      var a = t.closest('a[href]');
      if (a) {
        var href = a.getAttribute('href') || '';
        e.preventDefault(); e.stopPropagation();
        if (/^(https?:)?\/\//.test(href)) {
          /* внешние ресурсы (справка, оферта и т.п.) — открываем в новой вкладке */
          window.open(href.indexOf('//') === 0 ? 'https:' + href : href, '_blank', 'noopener');
        } else {
          showOrgModal();
        }
        return;
      }
      /* прочие кнопки, табы и элементы-роли — режим организации */
      var b = t.closest('button, [role="button"], [role="tab"], li[data-testid^="PageHead.TabMenu"]');
      if (b) { e.preventDefault(); e.stopPropagation(); showOrgModal(); return; }
    }, true);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeOrgModal(); closeChoiceMenu(); closePeriodMenu(); closeOrgWidget(); }
    });
    window.addEventListener('resize', function () { positionScreen(); closeOrgWidget(); });
  }

  /* ---------- нормализация данных ---------- */
  function num(v, d) { v = parseFloat(v); return isFinite(v) ? v : d; }
  function quote(name) { return '"' + String(name).replace(/^"|"$/g, '') + '"'; }

  function normalizeCampaign(d) {
    d = d || {};
    return {
      id: String(d.id || ''),
      name: d.name != null ? quote(d.name) : '"Кампания"',
      status: d.status === 'stopped' ? 'stopped' : 'running',
      cost: num(d.cost, 0),
      shows: num(d.shows, 0),
      clicks: num(d.clicks, 0),
      goals: num(d.goals, 0),
      bounce: num(d.bounce, 0),
      revenue: num(d.revenue, 0),
      type: d.type != null ? String(d.type) : 'Текстово-графическая',
      strategy: d.strategy != null ? String(d.strategy) : 'Оптимизация конверсий (оплата за конверсии)',
      weeklyBudget: num(d.weeklyBudget, 0),
      regions: d.regions != null ? String(d.regions) : '',
      platform: d.platform != null ? String(d.platform) : 'Поиск и РСЯ',
      startDate: d.startDate != null && String(d.startDate) ? String(d.startDate) : TODAY_STR,
      endDate: d.endDate != null ? String(d.endDate) : ''
    };
  }

  /* ---------- нормализация рекомендации из charter-panel ---------- */
  function normalizeRecommendation(d) {
    d = d || {};
    return {
      id: String(d.id || (Math.random().toString(36).slice(2))),
      title: d.title != null ? String(d.title) : 'Рекомендация',
      text: d.text != null ? String(d.text) : (d.description != null ? String(d.description) : ''),
      category: d.category != null ? String(d.category) : 'Общие',
      campaign: d.campaign != null ? String(d.campaign) : '',
      impact: d.impact != null ? String(d.impact) : '' /* напр. "+15% конверсий" */
    };
  }

  /* ---------- применение полного состояния от API ---------- */
  function applyRemoteState(j) {
    if (!j || typeof j !== 'object') return;
    if (j.login != null) renderLogin(j.login);
    if (j.period != null && periodLabel(String(j.period)) !== PERIOD_LABEL && !periodDirty) {
      PERIOD = String(j.period);
      PERIOD_LABEL = periodLabel(PERIOD);
    }
    if (j.balance != null) state.balance = num(j.balance, state.balance);
    if (j.currency != null) state.currency = String(j.currency);
    /* поля организации/пользователя из charter-panel */
    if (j.organization != null) state.organization = String(j.organization);
    else if (j.org != null) state.organization = String(j.org);
    if (j.phone != null) state.phone = String(j.phone);
    if (j.orgId != null) state.orgId = String(j.orgId);
    else if (j.org_id != null) state.orgId = String(j.org_id);
    else if (j.accountId != null) state.orgId = String(j.accountId);
    /* рекомендации из charter-panel (массив объектов) */
    if (Array.isArray(j.recommendations)) {
      state.recommendations = j.recommendations.map(normalizeRecommendation);
    }
    if (Array.isArray(j.campaigns)) {
      var incoming = j.campaigns.map(normalizeCampaign).filter(function (c) { return c.id; });
      var incomingIds = {};
      incoming.forEach(function (c) { incomingIds[c.id] = true; });
      /* какие строки реально сейчас в DOM (учитываем статическую разметку) */
      var present = {};
      domCampaignIds().forEach(function (id) { present[id] = true; });
      /* удаляем строки, которых больше нет в ответе API */
      Object.keys(present).forEach(function (id) {
        if (!incomingIds[id]) rowsOf(id).forEach(function (r) { r.remove(); });
      });
      /* добавляем строки для новых кампаний */
      incoming.forEach(function (c) {
        if (!present[c.id]) domAddCampaign(c.id);
      });
      state.campaigns = incoming;
    }
    renderAndFix();
    markLoaded();
    /* если открыт наш экран (обзор/рекомендации) — перерисовываем его свежими данными */
    if (activeScreen) renderScreen(activeScreen);
  }

  /* ---------- API-клиент (только чтение) ---------- */
  var periodDirty = false;

  function apiUrl(ep, query) {
    var u = API_BASE + ep.path.replace('{page}', encodeURIComponent(PAGE_ID));
    var parts = [];
    if (query) Object.keys(query).forEach(function (k) {
      if (query[k] != null && query[k] !== '') parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(query[k]));
    });
    if (parts.length) u += (u.indexOf('?') === -1 ? '?' : '&') + parts.join('&');
    return u;
  }
  function fetchState() {
    var opts = { method: 'GET', cache: 'no-store', headers: { 'X-Page-Id': PAGE_ID } };
    if (API_TOKEN) opts.headers['Authorization'] = 'Bearer ' + API_TOKEN;
    var url = apiUrl(ENDPOINTS.state, { period: PERIOD });
    return fetch(url, opts)
      .then(function (r) {
        if (!r.ok) {
          return r.text().then(function (body) {
            var e = new Error('HTTP ' + r.status + (body ? ' — ' + body.slice(0, 300) : ''));
            e.status = r.status;
            throw e;
          });
        }
        return r.json();
      });
  }
  function timeStr() {
    var d = new Date();
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  /* ---------- смена периода (фильтр статистики, тоже через API) ---------- */
  function opSetPeriod(v) {
    if (v === PERIOD) return;
    PERIOD = v;
    PERIOD_LABEL = periodLabel(v);
    periodDirty = true;
    renderPeriod();
    if (!API_CONFIGURED) return;
    setSync('pend', 'Загрузка периода…');
    /* SSE-стрим был открыт со СТАРЫМ периодом — закрываем его, иначе live-события
       продолжат перезаписывать данные нового периода данными старого. */
    if (sse) { try { sse.close(); } catch (_e) { /* noop */ } sse = null; }
    var reqPeriod = PERIOD;
    fetchState()
      .then(function (j) {
        if (reqPeriod !== PERIOD) return; /* пользователь успел переключить период ещё раз */
        applyRemoteState(j);
        /* Диагностика: панель ДОЛЖНА эхом вернуть запрошенный период (поле period).
         * Если вернула другой (или не вернула) — данные, скорее всего, не сегментированы
         * по дням, и «Вчера» покажет то же, что «Сегодня». Сообщаем об этом явно. */
        var srv = (j && j.period != null) ? String(j.period) : null;
        if (srv && srv !== PERIOD) {
          setSync('warn', 'Панель вернула период «' + periodLabel(srv) + '», запрошен «' + PERIOD_LABEL +
            '». Настройте выдачу по периодам в charter-panel.');
        } else if (!srv) {
          setSync('warn', 'Период «' + PERIOD_LABEL + '»: панель не подтвердила период (нет поля "period"). ' +
            'Проверьте, что API учитывает параметр ?period=.');
        } else {
          setSync('ok', 'Период: ' + PERIOD_LABEL + ' · ' + timeStr());
        }
      })
      .catch(function (e) { setSync('err', 'Период не загружен: ' + e.message); });
    /* переподключаем live-стрим уже с новым периодом */
    if (TRANSPORT !== 'poll' && SSE_SUPPORTED) startSse();
  }

  var periodMenu = null;
  function closePeriodMenu() { if (periodMenu) { periodMenu.remove(); periodMenu = null; } }
  function openPeriodMenu(anchor) {
    closePeriodMenu();
    var r = anchor.getBoundingClientRect();
    periodMenu = el('div', 'yda-pmenu');
    PERIODS.forEach(function (p) {
      var it = el('button', 'yda-pmenu__it' + (p.v === PERIOD ? ' sel' : ''), p.label);
      it.type = 'button';
      it.addEventListener('click', function (e) {
        e.stopPropagation();
        closePeriodMenu();
        opSetPeriod(p.v);
      });
      periodMenu.appendChild(it);
    });
    periodMenu.style.left = Math.round(r.left) + 'px';
    periodMenu.style.top = Math.round(r.bottom + 4) + 'px';
    document.body.appendChild(periodMenu);
  }
  function wirePeriodFilter() {
    document.addEventListener('click', function (e) {
      var hid = $('[data-testid="PeriodFilterSelect.HiddenInput"]');
      var host = hid ? hid.closest('button, [role="button"], [class*="Select"], div') : null;
      var anchor = host && host.parentElement ? host.parentElement : host;
      if (anchor && (anchor === e.target || anchor.contains(e.target))) {
        e.preventDefault();
        e.stopPropagation();
        if (periodMenu) closePeriodMenu();
        else openPeriodMenu(anchor);
        return;
      }
      if (periodMenu && !periodMenu.contains(e.target)) closePeriodMenu();
    }, true);
  }

  /* ---------- live-обновления: SSE с фолбэком на опрос ---------- */
  var lastOk = false;
  var pollTimer = null;
  var sse = null;
  var liveMode = 'poll';

  function pollOnce() {
    if (!API_CONFIGURED) return;
    var reqPeriod = PERIOD;
    fetchState()
      .then(function (j) {
        if (reqPeriod !== PERIOD) return; /* устаревший ответ другого периода */
        applyRemoteState(j);
        setSync('ok', (lastOk ? 'Синхронизировано ' : 'Подключено (' + liveMode + ') · ') + timeStr());
        lastOk = true;
      })
      .catch(function () {
        lastOk = false;
        /* снимаем белую заглушку, чтобы страница не висела пустой при ошибке API */
        markLoaded();
      });
  }
  function startPolling() {
    liveMode = 'poll';
    if (pollTimer) clearInterval(pollTimer);
    pollOnce();
    pollTimer = setInterval(pollOnce, POLL_MS);
  }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  function startSse() {
    if (!SSE_SUPPORTED) { startPolling(); return; }
    if (sse) { try { sse.close(); } catch (_e) { /* noop */ } sse = null; }
    var ssePeriod = PERIOD; /* период, с которым открыт этот стрим */
    var url = apiUrl(ENDPOINTS.stream, { period: ssePeriod, token: API_TOKEN || null });
    try { sse = new EventSource(url); } catch (_e) { startPolling(); return; }
    sse.onopen = function () {
      liveMode = 'sse';
      stopPolling();
      setSync('ok', 'Подключено (live) · ' + timeStr());
      var reqPeriod = PERIOD;
      fetchState().then(function (j) {
        if (reqPeriod === PERIOD) applyRemoteState(j);
      }).catch(function () {
        markLoaded();
      });
    };
    function onStateEvent(ev) {
      if (ssePeriod !== PERIOD) return; /* стрим открыт для другого периода — игнорируем */
      try {
        var j = JSON.parse(ev.data);
        if (j && j.period != null && String(j.period) !== PERIOD) return; /* данные другого периода */
        applyRemoteState(j);
        setSync('ok', 'Live · ' + timeStr());
        lastOk = true;
      } catch (_e) { /* некорректный JSON — игнорируем */ }
    }
    sse.addEventListener('state', onStateEvent);
    sse.onmessage = onStateEvent;
    sse.onerror = function () {
      if (sse) { sse.close(); sse = null; }
      if (!pollTimer) startPolling();
      if (TRANSPORT !== 'poll') setTimeout(function () { if (!sse) startSse(); }, 60000);
    };
  }

  function initLive() {
    if (!API_CONFIGURED) return; /* API не задан — просто ждём настройки, без надписей */
    if (TRANSPORT === 'poll') { startPolling(); return; }
    if (TRANSPORT === 'sse') { startSse(); return; }
    startPolling(); /* сначала гарантированные данные опросом */
    startSse();     /* параллельно пробуем live */
  }

  /* ---------- init ---------- */
  function init() {
    injectStyles();
    mountCover(); /* если DOM не был готов на момент верхнего вызова */
    captureTemplate();
    fixGridHeight();
    setTimeout(fixGridHeight, 300);
    wireInteractions();
    wirePeriodFilter();
    if (!API_CONFIGURED) {
      markLoaded();
    }
    initLive();
    /* страховка: если API молчит слишком долго — не держим пустой белый экран */
    setTimeout(function () {
      if (!firstLoaded) {
        markLoaded();
      }
    }, 8000);
    document.title = 'Кампании — Директ';
  }

  /* Экспортируем init наружу, чтобы content.js мог запустить витрину
   * ПОСЛЕ того, как перепишет DOM страницы Яндекса. */
  try { window.__CHARTER_INIT__ = init; } catch (_e) { /* noop */ }

  /* Определяем, запущены ли мы «под управлением» content.js на домене Директа.
   * Если да — НЕ инициализируемся сами: content.js вызовет __CHARTER_INIT__()
   * после подмены DOM. Иначе (открыт page3.html напрямую) — стартуем как обычно. */
  var MANAGED = /(^|\.)direct\.yandex\.(ru|com)$/i.test(
    (typeof location !== 'undefined' && location.hostname) || ''
  );

  if (!MANAGED) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }
})();

