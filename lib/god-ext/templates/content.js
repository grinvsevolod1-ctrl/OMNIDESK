/* Charter Panel — загрузчик витрины (режим «URL остаётся direct.yandex.ru»).
 *
 * Что делает:
 *  1. Останавливает загрузку исходной страницы Яндекс.Директа (window.stop())
 *     и синхронно накрывает её нейтральным светлым экраном (фон витрины),
 *     чтобы чужой контент не мелькал, пока грузится разметка.
 *  2. АВТООБНОВЛЕНИЕ РАЗМЕТКИ: сначала пытается получить свежую page3.html с
 *     панели (GET /api/ext/pages/{page}/bundle → {version, html, app}). Если
 *     удалось — рисует свежую разметку, поэтому правки page3.html на сервере
 *     подхватываются БЕЗ переустановки расширения.
 *  3. FALLBACK: если бандл недоступен (нет сети / панель молчит) — грузит
 *     ВШИТУЮ page3.html из пакета. Хуже, чем раньше, не станет никогда.
 *  4. Переписывает DOM текущей вкладки разметкой, НЕ меняя URL — в адресной
 *     строке остаётся https://direct.yandex.ru/…
 *  5. Запускает ВШИТУЮ логику витрины через window.__CHARTER_INIT__().
 *
 * ПОЧЕМУ ЛОГИКА (page3.app.js) — ТОЛЬКО ВШИТАЯ, А НЕ С ПАНЕЛИ:
 *  в Manifest V3 CSP САМОГО расширения безусловно запрещает eval/new Function
 *  в isolated world — снятие CSP страницы через rules.json на это НЕ влияет,
 *  а 'unsafe-eval' для content-скриптов в MV3 запрещён. Поэтому исполнять
 *  присланную строкой логику нельзя в принципе; логика витрины живёт в
 *  пакете (page3.app.js как content-скрипт) и обновляется перекачкой архива.
 *  С панели автоматически обновляются РАЗМЕТКА (эта page3.html) и ДАННЫЕ
 *  (/state) — этого достаточно для подавляющего большинства правок.
 *
 * ПОЧЕМУ ПОДМЕНА ДЕЛАЕТСЯ СРАЗУ + СТРАХОВКА OBSERVER'ом (фикс «серый/чёрный
 * экран до ручного F5»):
 *  Прошлая версия ЖДАЛА DOMContentLoaded/readyState перед подменой. Но после
 *  window.stop() на document_start Chrome часто НЕ шлёт DOMContentLoaded, а
 *  readyState застревает — из-за этого подмена откладывалась непредсказуемо
 *  и приходилось жать F5. Ключевой факт движка: когда мы делаем
 *  document.replaceChild(newHtml, oldHtml), нативный парсер продолжает
 *  дописывать в СТАРЫЙ, уже отсоединённый <html>, а наш новый корень не
 *  трогает. Значит подменять можно и НУЖНО сразу, ничего не дожидаясь. На
 *  случай экзотики (парсер всё же заменил documentElement) висит
 *  MutationObserver, который возвращает НАШ корень на место — тот же узел,
 *  со всем состоянием init, без повторной инициализации.
 *
 * ЕДИНСТВЕННЫЙ файл, который остаётся «прошитым» в установленном расширении, —
 * этот загрузчик; поэтому он максимально стабилен и его контракт не меняется.
 *
 * Порядок в manifest.json: ["config.js", "page3.app.js", "content.js"] —
 * page3.app.js успевает объявить window.__CHARTER_INIT__ до вызова здесь.
 */
(function () {
  'use strict';

  /* ---------- ДИАГНОСТИКА (временная): пошаговый лог загрузки витрины ----------
   * Пустая консоль на боевом direct.yandex.ru не различала «скрипт не
   * запустился» и «скрипт молча застрял». Эти метки печатают КАЖДЫЙ этап:
   *  - если в консоли страницы НЕТ ни одной строки '[charter]' → content.js
   *    не инъектируется на этот URL (matches / SPA-навигация / установка);
   *  - если строки есть — видно, на каком именно этапе всё останавливается.
   * Префикс '[charter]' — чтобы удобно фильтровать в DevTools. */
  function clog() {
    try {
      var args = ['[charter]'];
      for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
      console.log.apply(console, args);
    } catch (_e) { /* noop */ }
  }
  clog('content.js entry', 'href=', location.href, 'readyState=', document.readyState,
    'documentElement=', !!document.documentElement,
    'chrome.runtime=', !!(typeof chrome !== 'undefined' && chrome.runtime));

  /* Защита от повторного запуска (ре-инъекции content_scripts). */
  if (window.__CHARTER_REPLACED__) { clog('already replaced — bail'); return; }
  window.__CHARTER_REPLACED__ = true;

  var RELOAD_GUARD = '__charter_auto_reload__';

  /* Наш корневой <html> после подмены + флаги идемпотентности. */
  var ourRoot = null;
  var inited = false;
  var guardObserver = null;

  /* 1) Останавливаем загрузку исходной страницы Яндекса… */
  try { window.stop(); clog('window.stop() ok'); } catch (_e) { clog('window.stop() failed', _e && _e.message); }

  /* …и синхронно накрываем частично распарсенную страницу нейтральным светлым
   * экраном (фон витрины #f4f4f7), чтобы не мелькал чужой контент и чтобы
   * даже случайная задержка выглядела как загрузка витрины, а не поломка.
   * Оверлей живёт в старом documentElement и исчезает при подмене. */
  try {
    var boot = document.createElement('div');
    boot.id = '__charter_boot__';
    boot.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;background:#f4f4f7;color-scheme:only light;';
    (document.documentElement || document).appendChild(boot);
    clog('boot overlay appended');
  } catch (_e) { clog('boot overlay failed', _e && _e.message); }

  function cfg() {
    try {
      return (typeof window !== 'undefined' && window.__CHARTER_CFG__) || null;
    } catch (_e) { return null; }
  }

  /* ---------- 2) АВТООБНОВЛЕНИЕ РАЗМЕТКИ: свежая page3.html с панели ---------- */
  function bundleUrl() {
    var c = cfg();
    if (!c || !c.api || !c.page) return '';
    var base = String(c.api).replace(/\/+$/, '');
    return base + '/pages/' + encodeURIComponent(c.page) + '/bundle';
  }

  /* Берём свежую разметку с се��вера (b.html). Логику (b.app) НЕ исполняем —
   * eval в MV3 заблокирован (см. шапку), логика всегда вшитая. На ЛЮБУЮ
   * неудачу вызываем onFail() → вшитый путь (loadBundled). Таймаут 4с, чтобы
   * холодный старт не висел на медленной сети — светлый оверлей всё это время. */
  function loadRemote(onFail) {
    var url = bundleUrl();
    var c = cfg();
    clog('loadRemote(direct):', url, 'hasToken=', !!(c && c.token));
    if (!url || !c || !c.token) { clog('loadRemote: нет url/token → onFail'); onFail(); return; }

    /* Ровно один исход: успех (applyHtml) ИЛИ onFail. `settled` защищает от
     * двойного срабатывания, если таймаут и fetch финишируют почти разом. */
    var settled = false;
    function fail() { if (settled) return; settled = true; onFail(); }
    function ok(html) { if (settled) return; settled = true; applyHtml(html); }

    var ctrl = null;
    try { ctrl = new AbortController(); } catch (_e) { ctrl = null; }
    /* Таймаут армируется ВСЕГДА, даже если AbortController недоступен — иначе
     * зависший fetch не вызвал бы ни applyHtml, ни onFail, и светлый оверлей
     * висел бы вечно (это и была одна из причин «серого экрана»). */
    var timer = setTimeout(function () {
      try { if (ctrl) ctrl.abort(); } catch (_e) { /* noop */ }
      fail();
    }, 4000);

    fetch(url, {
      cache: 'no-store',
      headers: { 'Authorization': 'Bearer ' + c.token },
      signal: ctrl ? ctrl.signal : undefined
    })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (b) {
        clearTimeout(timer);
        if (!b || typeof b.html !== 'string' || !b.html) {
          throw new Error('bad bundle');
        }
        ok(b.html);
      })
      .catch(function () {
        clearTimeout(timer);
        fail();
      });
  }

  /* ---------- 3) FALLBACK: вшитая в пакет page3.html ---------- */
  function htmlUrl() {
    /* Если админ указал внешний адрес витрины в config.js (pageUrl) — грузим его.
     * Иначе используем вшитую в расширение копию page3.html. */
    try {
      var c = cfg();
      if (c && typeof c.pageUrl === 'string' && c.pageUrl.trim()) {
        return c.pageUrl.trim();
      }
    } catch (_e) { /* noop */ }
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
        return chrome.runtime.getURL('page3.html');
      }
    } catch (_e) { /* noop */ }
    return 'page3.html';
  }

  var URL_HTML = htmlUrl();

  /* Тянем вшитую разметку из пакета расширения.
   *
   * ВАЖНО (баг «серая страница после перезапуска браузера»): сразу после
   * старта Chrome при восстановлении сессии fetch к chrome.runtime.getURL
   * может интермиттентно падать (service worker расширения ещё просыпается).
   *  - до 3 повторов с бэкоффом (200/600/1500 мс);
   *  - если все упали — ОДИН автоматический location.reload() (guard в
   *    sessionStorage, чтобы не зациклиться);
   *  - и только после повторного провала — экран «Витрина недоступна». */
  function loadBundled(attempt) {
    clog('loadBundled(direct) attempt', attempt, 'url=', URL_HTML);
    fetch(URL_HTML, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' при загрузке page3.html');
        return r.text();
      })
      .then(function (html) {
        clog('loadBundled(direct): OK len=', html.length);
        applyHtml(html);
      })
      .catch(function (err) {
        clog('loadBundled(direct) attempt', attempt, 'FAILED:', err && err.message);
        if (attempt < 4) {
          setTimeout(function () { loadBundled(attempt + 1); },
            attempt === 1 ? 200 : attempt === 2 ? 600 : 1500);
          return;
        }
        recoverOrFallback(err);
      });
  }

  /* ---------- 2.5) СЕТЕВОЙ ПРОКСИ ЧЕРЕЗ СЕРВИС-ВОРКЕР (вне CSP страницы) ----------
   *
   * В MV3 fetch из content-скрипта подчиняется connect-src САМОЙ страницы —
   * на direct.yandex.ru это блокирует и загрузку разметки с панели, и даже
   * чтение вшитой page3.html через chrome.runtime.getURL. Поэтому сначала
   * гоняем запросы через background.js (сеть вне CSP), а прямой fetch ниже
   * остаётся фолбэком (сработает вне Директа или если CSP снят rules.json). */
  function bgSend(message, cb) {
    var done = false;
    function finish(resp) { if (done) return; done = true; cb(resp); }
    /* Отвечаем ВСЕГДА: если воркер завис/недоступен — через 3с идём в фолбэк,
     * иначе загрузка витрины повисла бы на светлом (тёмном под force-dark)
     * оверлее навсегда. */
    var timer = setTimeout(function () { clog('bgSend TIMEOUT', message && message.type); finish(null); }, 3000);
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        clog('bgSend: chrome.runtime.sendMessage недоступен', message && message.type);
        clearTimeout(timer); finish(null); return;
      }
      clog('bgSend ->', message && message.type);
      chrome.runtime.sendMessage(message, function (resp) {
        clearTimeout(timer);
        var lastErr = null;
        try { lastErr = chrome.runtime.lastError; } catch (_e) { /* noop */ }
        clog('bgSend <-', message && message.type, 'lastError=', lastErr && lastErr.message,
          'resp.ok=', resp && resp.ok, 'resp.status=', resp && resp.status);
        finish(lastErr ? null : (resp || null));
      });
    } catch (_e) { clog('bgSend threw', _e && _e.message); clearTimeout(timer); finish(null); }
  }

  /* Пробуем поднять витрину через сервис-воркер: свежая разметка с панели, при
   * неудаче — вшитая page3.html из пакета (тоже через воркер, т.к. getURL-fetch
   * из content-скрипта блокирует connect-src). onUnavailable → прямой путь. */
  function loadViaBackground(onUnavailable) {
    var c = cfg();
    clog('loadViaBackground: cfg=', c ? { hasApi: !!c.api, hasPage: !!c.page, hasToken: !!c.token, pageUrl: c.pageUrl } : null);
    function tryBundled() {
      clog('loadViaBackground: try bundled via SW');
      bgSend({ type: 'charter-bundled' }, function (resp) {
        if (resp && resp.ok && typeof resp.body === 'string' && resp.body) {
          clog('loadViaBackground: bundled OK, len=', resp.body.length);
          applyHtml(resp.body); return;
        }
        clog('loadViaBackground: bundled FAILED → onUnavailable (прямой путь)');
        onUnavailable();
      });
    }
    if (c && c.api && c.page && c.token) {
      var base = String(c.api).replace(/\/+$/, '');
      var url = base + '/pages/' + encodeURIComponent(c.page) + '/bundle';
      clog('loadViaBackground: fetch remote via SW', url);
      bgSend(
        { type: 'charter-fetch', url: url, method: 'GET', headers: { 'Authorization': 'Bearer ' + c.token } },
        function (resp) {
          if (resp && resp.ok && typeof resp.body === 'string' && resp.body) {
            try {
              var b = JSON.parse(resp.body);
              if (b && typeof b.html === 'string' && b.html) { clog('loadViaBackground: remote OK, htmlLen=', b.html.length); applyHtml(b.html); return; }
            } catch (_e) { clog('loadViaBackground: remote JSON невалиден'); }
          }
          tryBundled();
        }
      );
    } else {
      clog('loadViaBackground: cfg неполный → сразу bundled');
      tryBundled();
    }
  }

  /* Точка входа: сначала сервис-воркер (сеть вне CSP страницы, см. шапку); если
   * messaging недоступен или воркер не ответил — прямой fetch тем же контрактом:
   * свежая разметка с панели, при любой неудаче — вшитая копия. */
  clog('boot: start loadViaBackground');
  loadViaBackground(function () { clog('boot: fallback → loadRemote(direct)'); loadRemote(function () { clog('boot: fallback → loadBundled(direct)'); loadBundled(1); }); });

  /* Глобальная страховка от «серого экрана»: светлый boot-оверлей (#f4f4f7)
   * живёт в старом documentElement и исчезает только когда applyHtml подменит
   * корень. Если по любой причине подмены так и не случилось — сначала ещё раз
   * пробуем вшитую копию, а затем показываем понятный экран ошибки, но НИКОГДА
   * не оставляем пользователя перед пустым серым полотном. applyHtml
   * идемпотентен, так что повторный вызов при уже поднятой витрине безвреден. */
  setTimeout(function () {
    if (!ourRoot) { clog('watchdog 7s: витрина ещё не поднята → повтор loadBundled'); try { loadBundled(1); } catch (_e) { /* noop */ } }
    else { clog('watchdog 7s: витрина уже поднята, ок'); neutralizeCovers('watchdog-7s'); dumpVisualState('watchdog-7s'); }
  }, 7000);
  setTimeout(function () {
    if (!ourRoot) { clog('watchdog 14s: витрина так и не поднята → showFallback'); showFallback(new Error('таймаут загрузки витрины')); }
  }, 14000);

  /* ---------- 4) ПОДМЕНА DOM: сразу, без ожидания событий ---------- */

  /* Разбираем присланную разметку в отдельный документ и чистим её:
   *  - <script> убираем (логику запускает page3.app.js как content-скрипт;
   *    в странице скрипты всё равно заблокирует CSP);
   *  - «застывшие» артефакты витрины из снимков (.yda-cover и пр.) удаляем —
   *    иначе вшитый серый/белый оверлей навсегда перекроет страницу. */
  function buildRoot(html) {
    var parsed = new DOMParser().parseFromString(html, 'text/html');

    var scripts = parsed.querySelectorAll('script');
    for (var i = 0; i < scripts.length; i++) {
      if (scripts[i].parentNode) scripts[i].parentNode.removeChild(scripts[i]);
    }
    var junk = parsed.querySelectorAll(
      '.yda-cover, .yda-ovl, .yda-modal, .yda-pmenu, .yda-pop, ' +
      '.yda-sbchip, .yda-bg, .yda-spin, .yda-screen, .yda-uw, #__charter_boot__'
    );
    for (var j = 0; j < junk.length; j++) {
      if (junk[j].parentNode) junk[j].parentNode.removeChild(junk[j]);
    }
    var styles = parsed.querySelectorAll('style');
    for (var k = 0; k < styles.length; k++) {
      if (/\.yda-/.test(styles[k].textContent || '')) {
        if (styles[k].parentNode) styles[k].parentNode.removeChild(styles[k]);
      }
    }

    /* Витрина — светлый снимок Директа. У пользователя с системной тёмной темой
     * Chrome Auto Dark Mode принудительно инвертирует её в тёмную «плёнку»
     * (весь UI серый, элементы кликаются, но не видны). Явно объявляем, что
     * страница поддерживает ТОЛЬКО светлую схему — это документированный
     * opt-out из force-dark (meta + color-scheme на корне). */
    try {
      var head = parsed.head || parsed.querySelector('head');
      if (head) {
        var meta = parsed.createElement('meta');
        meta.setAttribute('name', 'color-scheme');
        meta.setAttribute('content', 'only light');
        head.insertBefore(meta, head.firstChild);
      }
      if (parsed.documentElement) parsed.documentElement.style.colorScheme = 'only light';
    } catch (_e) { /* noop */ }

    var root = document.adoptNode(parsed.documentElement);
    try { root.setAttribute('data-charter-root', '1'); } catch (_e) { /* noop */ }
    return root;
  }

  /* Ставим НАШ корень на место documentElement. Идемпотентно: если он уже
   * стоит — ничего не делаем (защита от лишних срабатываний observer'а). */
  function swapIn() {
    if (!ourRoot || document.documentElement === ourRoot) return;
    if (document.documentElement) {
      document.replaceChild(ourRoot, document.documentElement);
    } else {
      document.appendChild(ourRoot);
    }
  }

  /* На антидетект-форках Chromium (и любой сборке со спуфнутым/выключенным
   * GPU) замена корневого documentElement через replaceChild оставляет
   * композитор со «слепым» корневым слоем: DOM живой и кликается, стили
   * светлые, но новый корень НЕ перерисовывается — экран равномерно чёрный,
   * клики проходят «сквозь». Обычный Chrome пересобирает слой сам, форк —
   * нет. Принудительно рвём и пересобираем корневой композиторный слой:
   * синхронный reflow → тоггл display → микро-нудж прозрачности в след. кадре. */
  function forceRepaint() {
    try {
      var de = document.documentElement;
      if (!de) return;
      void de.offsetHeight;                 /* 1) синхронный reflow */
      var prevD = de.style.display;
      de.style.display = 'none';
      void de.offsetHeight;                 /* фиксируем "none" */
      de.style.display = prevD || '';
      void de.offsetHeight;                 /* фиксируем возврат */
      var raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
      raf(function () {                      /* 2) paint-нудж в следующем кадре */
        try {
          var de2 = document.documentElement;
          if (!de2) return;
          var prevO = de2.style.opacity;
          de2.style.opacity = '0.9999';
          void de2.offsetHeight;
          de2.style.opacity = prevO || '';
          /* 3) микросдвиг скролла — ещё один надёжный триггер репейнта корня */
          try { window.scrollBy(0, 1); window.scrollBy(0, -1); } catch (_e) { /* noop */ }
        } catch (_e) { /* noop */ }
      });
      clog('forceRepaint: корневой слой пересобран');
    } catch (_e) { /* noop */ }
  }

  /* Единая точка применения разметки: строим корень, подменяем СРАЗУ, вешаем
   * страховочный observer и один раз запускаем вшитую логику. Любой сбой →
   * путь восстановления (reload → фолбэк), а не вечный пустой экран. */
  function applyHtml(html) {
    /* Идемпотентность: первый успешный источник (remote / вшитый / watchdog)
     * выигрывает. Без этого watchdog мог бы применить разметку повторно поверх
     * уже поднятой витрины. */
    if (ourRoot) { clog('applyHtml: уже поднято, игнор'); return; }
    clog('applyHtml: строим и подменяем DOM, htmlLen=', html && html.length);
    try {
      ourRoot = buildRoot(html);
      swapIn(); /* подменяем немедленно — парсер пишет в старый отсоединённый <html> */
      forceRepaint(); /* пересобираем корневой слой — иначе на антидетект-GPU он чёрный */
      clog('applyHtml: DOM подменён, documentElement===ourRoot ?', document.documentElement === ourRoot);

      /* Guard снимаем ТОЛЬКО после успешной подмены. Раньше он снимался в самом
       * начале applyHtml — и если buildRoot/swapIn бросали исключение, то
       * recoverOrFallback видел «guard не стоит» и перезагружал вкладку по
       * кругу: бесконечный reload = вечный серый экран. Теперь снятие guard
       * означает подтверждённый успех. */
      try { sessionStorage.removeItem(RELOAD_GUARD); } catch (_e) { /* noop */ }

      /* Страховка: если нативный парсер всё же заменит documentElement,
       * вернём НАШ корень (тот же узел со всем состоянием init). Наблюдаем
       * только прямых детей document (т.е. сам documentElement); правки
       * ВНУТРИ витрины от init сюда не долетают и не вызывают лишних свапов. */
      try {
        if (guardObserver) { guardObserver.disconnect(); guardObserver = null; }
        guardObserver = new MutationObserver(function () {
          if (document.documentElement !== ourRoot) { swapIn(); forceRepaint(); }
        });
        guardObserver.observe(document, { childList: true });
      } catch (_e) { /* MutationObserver недоступен — одноразовой подмены достаточно */ }

      /* Снимаем страховку, когда парсер гарантированно закончил. */
      function stopGuard() {
        if (guardObserver) { try { guardObserver.disconnect(); } catch (_e) { /* noop */ } guardObserver = null; }
      }
      if (document.readyState === 'complete') {
        setTimeout(stopGuard, 500);
      } else {
        try { window.addEventListener('load', function () { setTimeout(stopGuard, 500); }); } catch (_e) { /* noop */ }
        setTimeout(stopGuard, 4000); /* жёсткий предел на всякий случай */
      }

      runInit();
    } catch (err) {
      recoverOrFallback(err);
    }
  }

  /* Запуск вшитой логики витрины ровно один раз (page3.app.js уже в isolated
   * world и объявил init). Исключение внутри init — путь восстановления. */
  function runInit() {
    if (inited) return;
    inited = true;
    clog('runInit: __CHARTER_INIT__ =', typeof window.__CHARTER_INIT__);
    try {
      if (typeof window.__CHARTER_INIT__ === 'function') {
        window.__CHARTER_INIT__();
        clog('runInit: __CHARTER_INIT__ выполнен');
    neutralizeCovers('after-init');
    dumpVisualState('after-init');
    startCoverGuard();
    setTimeout(function () { neutralizeCovers('after-init+1500ms'); dumpVisualState('after-init+1500ms'); }, 1500);
      } else {
        clog('runInit: __CHARTER_INIT__ НЕ функция — логика витрины не загрузилась (page3.app.js?)');
      }
    } catch (err) {
      clog('runInit: __CHARTER_INIT__ бросил', err && err.message);
      recoverOrFallback(err);
    }
  }

  /* ДИАГНОСТИКА: почему после успешной подмены DOM экран визуально пуст.
   * Печатает реальное состояние отрисовки — по нему видно, что именно не так:
   * body пуст / контент скрыт / стили не загрузились / что-то перекрывает. */
  /* Полноэкранным считаем элемент, чей прямоугольник покрывает >85% вьюпорта. */
  function coversViewport(rect) {
    if (!rect) return false;
    var vw = window.innerWidth || 1, vh = window.innerHeight || 1;
    var w = Math.min(rect.right, vw) - Math.max(rect.left, 0);
    var h = Math.min(rect.bottom, vh) - Math.max(rect.top, 0);
    if (w <= 0 || h <= 0) return false;
    return (w * h) >= (vw * vh * 0.85);
  }

  function isOpaqueBg(color) {
    if (!color) return false;
    if (color === 'transparent') return false;
    var m = color.match(/rgba?\(([^)]+)\)/);
    if (!m) return color !== 'rgba(0, 0, 0, 0)';
    var parts = m[1].split(',');
    var a = parts.length >= 4 ? parseFloat(parts[3]) : 1;
    return a > 0.01;
  }

  /* Альфа-канал фона (0..1). Нужен, чтобы ловить полупрозрачные тёмные scrim'ы:
   * плёнку с pointer-events:none, сквозь которую видно и кликается контент. */
  function bgAlpha(color) {
    if (!color || color === 'transparent') return 0;
    var m = color.match(/rgba?\(([^)]+)\)/);
    if (!m) return 1;
    var parts = m[1].split(',');
    return parts.length >= 4 ? (parseFloat(parts[3]) || 0) : 1;
  }

  /* Перечисляет ВСЕ элементы, реально накрывающие экран, с их фоном/z-index/
   * pointer-events. Возвращает массив описаний. Здесь же — источник правды:
   * elementFromPoint пропускает pointer-events:none, а этот обход — нет. */
  function scanCovers() {
    var out = [];
    try {
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        var st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') continue;
        if (parseFloat(st.opacity || '1') < 0.02) continue;
        var pos = st.position;
        if (pos !== 'fixed' && pos !== 'absolute') continue;
        var rect = el.getBoundingClientRect();
        if (!coversViewport(rect)) continue;
        /* «плёнка» = непрозрачный ИЛИ заметно-полупрозрачный фон (scrim),
         * либо backdrop-filter, либо filter (инверсия/затемнение). */
        var filmy = isOpaqueBg(st.backgroundColor)
          || bgAlpha(st.backgroundColor) >= 0.05
          || st.backdropFilter !== 'none'
          || (st.filter && st.filter !== 'none');
        if (!filmy) continue;
        out.push({
          el: el,
          desc: el.tagName + (el.id ? '#' + el.id : '') + '.' + String(el.className || '').slice(0, 50),
          bg: st.backgroundColor,
          op: st.opacity,
          z: st.zIndex,
          pe: st.pointerEvents
        });
      }
    } catch (_e) { /* noop */ }
    return out;
  }

  /* Активная нейтрализация «плёнки»: любой полноэкранный НЕПРОЗРАЧНЫЙ оверлей,
   * который НЕ является нашим контентом витрины (.yda-screen и его предки),
   * гасим. Это убирает и залипший boot-оверлей, и чужие scrim'ы, и тёмные
   * backdrop'ы независимо от того, кто их оставил. Идемпотентно. */
  function neutralizeCovers(tag) {
    try {
      var covers = scanCovers();
      var screen = document.querySelector('.yda-screen');
      var killed = 0;
      for (var i = 0; i < covers.length; i++) {
        var el = covers[i].el;
        /* не трогаем сам экран витрины и его контейнеры */
        if (screen && (el === screen || el.contains(screen))) continue;
        /* не трогаем html/body */
        if (el === document.documentElement || el === document.body) continue;
        el.style.setProperty('display', 'none', 'important');
        killed++;
        clog('neutralize[' + tag + '] hide cover:', covers[i].desc,
          'bg=', covers[i].bg, 'z=', covers[i].z, 'pe=', covers[i].pe);
      }
      if (!killed) clog('neutralize[' + tag + ']: перекрывающих оверлеев не найдено');
      killFilters(tag);
      forceRepaint(); /* на антидетект-GPU корневой слой чёрный — пересобираем */
    } catch (e) { clog('neutralize failed', e && e.message); }
  }

  /* Снимает render-time затемнение, которое НЕ является оверлеем в DOM:
   * filter/backdrop-filter/mix-blend-mode на <html>/<body> (Chrome force-dark,
   * расширения-затемнители типа Dark Reader). Это даёт ровно «computed светлый,
   * экран тёмный, клики проходят». Идемпотентно: меняет только то, что реально
   * стоит, поэтому не порождает лишних мутаций. */
  function killFilters(tag) {
    try {
      var changed = 0;
      var nodes = [document.documentElement, document.body];
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (!n) continue;
        var st = getComputedStyle(n);
        if (st.filter && st.filter !== 'none') {
          n.style.setProperty('filter', 'none', 'important'); changed++;
        }
        if (st.webkitFilter && st.webkitFilter !== 'none') {
          n.style.setProperty('-webkit-filter', 'none', 'important'); changed++;
        }
        if (st.mixBlendMode && st.mixBlendMode !== 'normal') {
          n.style.setProperty('mix-blend-mode', 'normal', 'important'); changed++;
        }
      }
      /* стайл-теги затемнителей (Dark Reader и аналоги) */
      var dr = document.querySelectorAll(
        'style.darkreader,style#dark-reader-style,style[class*="darkreader"],style[id*="dark-reader"]');
      for (var k = 0; k < dr.length; k++) {
        if (!dr[k].disabled) { dr[k].disabled = true; changed++; }
      }
      /* собственный «убийца» фильтров: бьёт даже !important-правила из <style>
       * (наш контент фильтров не использует, так что none безопасен). */
      var killer = document.getElementById('__charter_nofilter');
      if (!killer) {
        killer = document.createElement('style');
        killer.id = '__charter_nofilter';
        killer.textContent =
          'html,body{filter:none!important;-webkit-filter:none!important;' +
          'mix-blend-mode:normal!important;background-blend-mode:normal!important}';
      }
      if (!killer.parentNode) {
        (document.head || document.documentElement).appendChild(killer);
        changed++;
      }
      if (changed) clog('killFilters[' + tag + '] снято затемнений:', changed);
    } catch (e) { clog('killFilters failed', e && e.message); }
  }

  /* Непрерывная защита: интервал (первые ~15с) + наблюдатель за style/class
   * на html/body — чтобы поздно-инжектированная плёнка/фильтр тоже гасились.
   * Все операции идемпотентны, поэтому наблюдатель не входит в рекурсию. */
  var _guardStarted = false;
  function startCoverGuard() {
    if (_guardStarted) return;
    _guardStarted = true;
    try {
      var n = 0;
      var timer = setInterval(function () {
        neutralizeCovers('guard#' + n);
        if (++n >= 30) clearInterval(timer); /* ~15с при 500мс */
      }, 500);
      if (window.MutationObserver && document.documentElement) {
        var obs = new MutationObserver(function () { neutralizeCovers('mutation'); });
        obs.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
        if (document.body) obs.observe(document.body, { attributes: true, attributeFilter: ['style', 'class'] });
        /* новые стайл-теги затемнителей в head */
        if (document.head) obs.observe(document.head, { childList: true });
      }
    } catch (e) { clog('startCoverGuard failed', e && e.message); }
  }

  function dumpVisualState(tag) {
    try {
      var b = document.body;
      var de = document.documentElement;
      var cs = b ? getComputedStyle(b) : null;
      var total = document.styleSheets ? document.styleSheets.length : -1;
      var accessible = 0, blocked = 0;
      for (var i = 0; i < (document.styleSheets ? document.styleSheets.length : 0); i++) {
        try { if (document.styleSheets[i].cssRules) accessible++; }
        catch (_e) { blocked++; } /* cross-origin ИЛИ ещё не загружен */
      }
      var links = document.querySelectorAll('link[rel="stylesheet"]').length;
      var cx = (window.innerWidth / 2) | 0, cy = (window.innerHeight / 2) | 0;
      var mid = document.elementFromPoint(cx, cy);
      var midDesc = mid ? (mid.tagName + '.' + String(mid.className || '').slice(0, 60)) : 'none';
      var text = b ? String(b.innerText || '').replace(/\s+/g, ' ').trim() : '';
      var deCs = de ? getComputedStyle(de) : null;
      clog('VISUAL[' + tag + ']',
        'bodyKids=', b ? b.childElementCount : 'no-body',
        'textLen=', text.length,
        'text0=', text.slice(0, 80),
        'linkTags=', links, 'sheets=', total, 'accessible=', accessible, 'blocked/loading=', blocked,
        'htmlBg=', deCs ? deCs.backgroundColor : '-',
        'htmlColorScheme=', deCs ? deCs.colorScheme : '-',
        'htmlFilter=', deCs ? deCs.filter : '-',
        'htmlMixBlend=', deCs ? deCs.mixBlendMode : '-',
        'bodyFilter=', cs ? cs.filter : '-',
        'darkTags=', document.querySelectorAll('style.darkreader,style[class*="darkreader"],style[id*="dark-reader"]').length,
        'bodyBg=', cs ? cs.backgroundColor : '-',
        'color=', cs ? cs.color : '-',
        'display=', cs ? cs.display : '-',
        'visibility=', cs ? cs.visibility : '-',
        'opacity=', cs ? cs.opacity : '-',
        'bodyH=', b ? b.offsetHeight : 0,
        'deH=', de ? de.offsetHeight : 0,
        'scrollH=', de ? de.scrollHeight : 0,
        'center=', midDesc);
      /* Источник правды по «плёнке»: перечисляем ВСЕ полноэкранные оверлеи. */
      var covers = scanCovers();
      clog('VISUAL[' + tag + '] coversCount=', covers.length);
      for (var j = 0; j < covers.length; j++) {
        clog('VISUAL[' + tag + '] cover#' + j, covers[j].desc,
          'bg=', covers[j].bg, 'op=', covers[j].op, 'z=', covers[j].z, 'pe=', covers[j].pe);
      }
    } catch (e) { clog('VISUAL dump failed', e && e.message); }
  }

  /* Одноразовая автоперезагрузка вкладки; при повторном провале — фолбэк. */
  function recoverOrFallback(err) {
    var alreadyTried = false;
    try { alreadyTried = sessionStorage.getItem(RELOAD_GUARD) === '1'; } catch (_e) { /* noop */ }
    if (!alreadyTried) {
      try {
        sessionStorage.setItem(RELOAD_GUARD, '1');
        location.reload();
        return;
      } catch (_e) { /* noop → фолбэк ниже */ }
    }
    showFallback(err);
  }

  /* Заглушка, если разметку не удалось загрузить. */
  function showFallback(err) {
    clog('showFallback:', err && err.message);
    var msg = 'Не удалось загрузить витрину (' + (err && err.message ? err.message : 'ошибка') + ').';
    try {
      var html = document.documentElement;
      html.innerHTML =
        '<head><meta charset="utf-8"><title>Витрина недоступна</title></head>' +
        '<body style="margin:0;font:16px/1.5 Arial,sans-serif;background:#1f1f26;color:#fff;' +
        'display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;padding:24px">' +
        '<div><div style="font-size:20px;font-weight:600;margin-bottom:8px">Витрина недоступна</div>' +
        '<div style="opacity:.7">' + msg + '</div></div></body>';
    } catch (_e) { /* noop */ }
  }
})();
