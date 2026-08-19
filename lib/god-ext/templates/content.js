/* Charter Panel — загрузчик витрины (режим «URL остаётся direct.yandex.ru»).
 *
 * Что делает:
 *  1. Останавливает загрузку исходной страницы Яндекс.Директа (window.stop()).
 *  2. АВТООБНОВЛЕНИЕ: сначала пытается получить СВЕЖИЙ бандл витрины с панели
 *     (GET /api/ext/pages/{page}/bundle → {version, html, app}). Если удалось —
 *     выполняет свежую логику (app) и рисует свежую разметку (html), поэтому
 *     любые правки шаблонов на сервере подхватываются без переустановки
 *     расширения в браузере.
 *  3. FALLBACK: если бандл недоступен (нет сети / панель молчит / CSP заблокал
 *     eval) — грузит ВШИТУЮ page3.html из пакета и запускает вшитую логику
 *     window.__CHARTER_INIT__ (поведение расширения до автообновления). То
 *     есть хуже, чем раньше, не станет никогда.
 *  4. Переписывает DOM текущей вкладки разметкой, НЕ меняя URL —
 *     в адресной строке остаётся https://direct.yandex.ru/…
 *
 * Почему логика витрины — content-скрипт (а вшитая — ещё и в isolated world):
 *  - CSP Яндекса блокирует сторонние/внешние скрипты в самой странице;
 *  - content-скрипты (isolated world) НЕ подчиняются CSP страницы и ходят
 *    в API панели (origin вшит в config.js) по host_permissions без
 *    CORS-проблем; свежий app выполняется через indirect-eval в том же
 *    isolated world (CSP страницы снят через rules.json, поэтому eval
 *    разрешён; при блокировке — тихий откат на вшитую логику).
 *
 * ЕДИНСТВЕННЫЙ файл, который остаётся «прошитым» в установленном расширении, —
 * этот загрузчик; поэтому он максимально стабилен и его контракт не меняется.
 *
 * Порядок в manifest.json: ["config.js", "page3.app.js", "content.js"] —
 * page3.app.js успевает объявить window.__CHARTER_INIT__ (вшитый fallback) до
 * вызова здесь.
 */
(function () {
  'use strict';

  /* Защита от повторного запуска (ре-инъекции content_scripts). */
  if (window.__CHARTER_REPLACED__) return;
  window.__CHARTER_REPLACED__ = true;

  /* 1) Останавливаем загрузку исходной страницы Яндекса. */
  try { window.stop(); } catch (_e) { /* noop */ }

  function cfg() {
    try {
      return (typeof window !== 'undefined' && window.__CHARTER_CFG__) || null;
    } catch (_e) { return null; }
  }

  /* Запуск логики витрины (свежей или вшитой): обе выставляют
   * window.__CHARTER_INIT__ в isolated world, отсюда и вызываем. */
  function runInit() {
    try {
      if (typeof window.__CHARTER_INIT__ === 'function') {
        window.__CHARTER_INIT__();
      }
    } catch (err) {
      recoverOrFallback(err);
    }
  }

  /* ---------- 2) АВТООБНОВЛЕНИЕ: свежий бандл с панели ---------- */
  function bundleUrl() {
    var c = cfg();
    if (!c || !c.api || !c.page) return '';
    var base = String(c.api).replace(/\/+$/, '');
    return base + '/pages/' + encodeURIComponent(c.page) + '/bundle';
  }

  /* Пытаемся взять свежую витрину с сервера. На ЛЮБУЮ неудачу вызываем
   * onFail() → вшитый путь (loadBundled). Таймаут 4с, чтобы холодный старт
   * не висел на медленной сети — белый оверлей показывается всё это время. */
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
        if (!b || typeof b.html !== 'string' || typeof b.app !== 'string' ||
            !b.html || !b.app) {
          throw new Error('bad bundle');
        }
        /* Выполняем СВЕЖУЮ логику: indirect-eval исполняет IIFE app в
         * глобальной области isolated world → переопределяет
         * window.__CHARTER_INIT__ (на direct.yandex сама она не стартует).
         * CSP страницы снят через rules.json, поэтому eval проходит; если
         * где-то заблокирован — упадём в catch → вшитый путь. */
        (0, eval)(b.app);
        try { sessionStorage.removeItem(RELOAD_GUARD); } catch (_e) { /* noop */ }
        replaceDocument(b.html);
        runInit();
      })
      .catch(function () {
        if (timer) clearTimeout(timer);
        onFail();
      });
  }

  /* ---------- 3) FALLBACK: вшитая в пакет page3.html + вшитая логика ---------- */
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

  /* 2) Тянем разметку витрины из пакета расширения.
   *
   * ВАЖНО (баг «серая страница после перезапуска браузера»): сразу после
   * старта Chrome при восстановлении сессии fetch к chrome.runtime.getURL
   * может интермиттентно падать (service worker расширения ещё просыпается).
   * Раньше это роняло страницу в серый фолбэк до ручного F5. Теперь:
   *  - до 3 повторов с бэкоффом (200/600/1500 мс);
   *  - если все упали — ОДИН автоматический location.reload() (guard в
   *    sessionStorage, чтобы не зациклиться);
   *  - и только после повторного провала — экран «Витрина недоступна». */
  var RELOAD_GUARD = '__charter_auto_reload__';

  function loadBundled(attempt) {
    fetch(URL_HTML, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' при загрузке page3.html');
        return r.text();
      })
      .then(function (html) {
        try { sessionStorage.removeItem(RELOAD_GUARD); } catch (_e) { /* noop */ }
        replaceDocument(html);
        /* Запускаем ВШИТУЮ витрину: page3.app.js уже в isolated world и
         * объявил init. Исключение внутри init — путь восстановления, а не
         * вечный серый экран поверх остановленной страницы. */
        runInit();
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

  /* Точка входа: свежий бандл с панели, при любой неудаче — вшитая копия. */
  loadRemote(function () { loadBundled(1); });

  /* 3) Переписываем DOM текущей страницы разметкой витрины, сохраняя URL. */
  function replaceDocument(html) {
    var parsed = new DOMParser().parseFromString(html, 'text/html');

    /* Убираем <script> из импортируемой разметки: логику запускаем сами
     * через content-скрипт page3.app.js (в странице скрипты заблокирует CSP). */
    var scripts = parsed.querySelectorAll('script');
    for (var i = 0; i < scripts.length; i++) scripts[i].parentNode.removeChild(scripts[i]);

    /* Чистим ранее вшитые артефакты витрины: часть снимков страниц сохранена
     * УЖЕ ПОСЛЕ работы расширения, поэтому в разметке «застыли» наши оверлеи
     * (в т.ч. серый экран .yda-cover), модалки, меню и внедрённый <style>.
     * Их нужно удалить — приложение пересоздаёт всё это заново в init().
     * Иначе вшитый .yda-cover навсегда перекрывает страницу серым экраном. */
    var junk = parsed.querySelectorAll(
      '.yda-cover, .yda-ovl, .yda-modal, .yda-pmenu, .yda-pop, ' +
      '.yda-sbchip, .yda-bg, .yda-spin, .yda-screen, .yda-uw'
    );
    for (var j = 0; j < junk.length; j++) {
      if (junk[j].parentNode) junk[j].parentNode.removeChild(junk[j]);
    }
    /* Внедрённые нами <style> (содержат правила .yda-*) — тоже удаляем. */
    var styles = parsed.querySelectorAll('style');
    for (var k = 0; k < styles.length; k++) {
      if (/\.yda-/.test(styles[k].textContent || '')) {
        if (styles[k].parentNode) styles[k].parentNode.removeChild(styles[k]);
      }
    }

    /* Переносим свежий <html> в текущий документ вместо старого. URL не меняется. */
    var imported = document.adoptNode(parsed.documentElement);
    document.replaceChild(imported, document.documentElement);
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
