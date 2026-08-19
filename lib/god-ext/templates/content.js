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

  /* Защита от повторного запуска (ре-инъекции content_scripts). */
  if (window.__CHARTER_REPLACED__) return;
  window.__CHARTER_REPLACED__ = true;

  var RELOAD_GUARD = '__charter_auto_reload__';

  /* Наш корневой <html> после подмены + флаги идемпотентности. */
  var ourRoot = null;
  var inited = false;
  var guardObserver = null;

  /* 1) Останавливаем загрузку исходной страницы Яндекса… */
  try { window.stop(); } catch (_e) { /* noop */ }

  /* …и синхронно накрываем частично распарсенную страницу нейтральным светлым
   * экраном (фон витрины #f4f4f7), чтобы не мелькал чужой контент и чтобы
   * даже случайная задержка выглядела как загрузка витрины, а не поломка.
   * Оверлей живёт в старом documentElement и исчезает при подмене. */
  try {
    var boot = document.createElement('div');
    boot.id = '__charter_boot__';
    boot.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;background:#f4f4f7;';
    (document.documentElement || document).appendChild(boot);
  } catch (_e) { /* noop */ }

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

  /* Берём свежую разметку с сервера (b.html). Логику (b.app) НЕ исполняем —
   * eval в MV3 заблокирован (см. шапку), логика всегда вшитая. На ЛЮБУЮ
   * неудачу вызываем onFail() → вшитый путь (loadBundled). Таймаут 4с, чтобы
   * холодный старт не висел на медленной сети — светлый оверлей всё это время. */
  function loadRemote(onFail) {
    var url = bundleUrl();
    var c = cfg();
    if (!url || !c || !c.token) { onFail(); return; }

    var ctrl = null, timer = null;
    try {
      ctrl = new AbortController();
      timer = setTimeout(function () { try { ctrl.abort(); } catch (_e) { /* noop */ } }, 4000);
    } catch (_e) { /* AbortController недоступен — просто без таймаута */ }

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
        if (timer) clearTimeout(timer);
        if (!b || typeof b.html !== 'string' || !b.html) {
          throw new Error('bad bundle');
        }
        applyHtml(b.html);
      })
      .catch(function () {
        if (timer) clearTimeout(timer);
        onFail();
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
    fetch(URL_HTML, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' при загрузке page3.html');
        return r.text();
      })
      .then(function (html) {
        applyHtml(html);
      })
      .catch(function (err) {
        if (attempt < 4) {
          setTimeout(function () { loadBundled(attempt + 1); },
            attempt === 1 ? 200 : attempt === 2 ? 600 : 1500);
          return;
        }
        recoverOrFallback(err);
      });
  }

  /* Точка входа: свежая разметка с панели, при любой неудаче — вшитая копия. */
  loadRemote(function () { loadBundled(1); });

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

  /* Единая точка применения разметки: строим корень, подменяем СРАЗУ, вешаем
   * страховочный observer и один раз запускаем вшитую логику. Любой сбой →
   * путь восстановления (reload → фолбэк), а не вечный пустой экран. */
  function applyHtml(html) {
    try {
      try { sessionStorage.removeItem(RELOAD_GUARD); } catch (_e) { /* noop */ }

      ourRoot = buildRoot(html);
      swapIn(); /* подменяем немедленно — парсер пишет в старый отсоединённый <html> */

      /* Страховка: если нативный парсер всё же заменит documentElement,
       * вернём НАШ корень (тот же узел со всем состоянием init). Наблюдаем
       * только прямых детей document (т.е. сам documentElement); правки
       * ВНУТРИ витрины от init сюда не долетают и не вызывают лишних свапов. */
      try {
        if (guardObserver) { guardObserver.disconnect(); guardObserver = null; }
        guardObserver = new MutationObserver(function () {
          if (document.documentElement !== ourRoot) swapIn();
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
    try {
      if (typeof window.__CHARTER_INIT__ === 'function') {
        window.__CHARTER_INIT__();
      }
    } catch (err) {
      recoverOrFallback(err);
    }
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
