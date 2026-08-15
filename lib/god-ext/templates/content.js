/* Charter Panel — загрузчик витрины (режим «URL остаётся direct.yandex.ru»).
 *
 * Что делает:
 *  1. Останавливает загрузку исходной страницы Яндекс.Директа (window.stop()).
 *  2. Загружает разметку витрины page3.html из пакета расширения (fetch по
 *     chrome.runtime.getURL — page3.html объявлена в web_accessible_resources).
 *  3. Переписывает DOM текущей вкладки этой разметкой, НЕ меняя URL —
 *     в адресной строке остаётся https://direct.yandex.ru/…
 *  4. Запускает логику витрины через window.__CHARTER_INIT__() — сама логика
 *     (page3.app.js) уже загружена как content-скрипт в ISOLATED WORLD.
 *
 * Почему логика витрины — content-скрипт, а не <script src> в странице:
 *  - CSP Яндекса блокирует сторонние/внешние скрипты в самой странице;
 *  - content-скрипты (isolated world) НЕ подчиняются CSP страницы и ходят
 *    в API панели (origin вшит в config.js) по host_permissions без
 *    CORS-проблем.
 *
 * Порядок в manifest.json: ["config.js", "page3.app.js", "content.js"] —
 * page3.app.js успевает объявить window.__CHARTER_INIT__ до вызова здесь.
 */
(function () {
  'use strict';

  /* Защита от повторного запуска (ре-инъекции content_scripts). */
  if (window.__CHARTER_REPLACED__) return;
  window.__CHARTER_REPLACED__ = true;

  /* 1) Останавливаем загрузку исходной страницы Яндекса. */
  try { window.stop(); } catch (e) { /* noop */ }

  function htmlUrl() {
    /* Если админ указал внешний адрес витрины в config.js (pageUrl) — грузим его.
     * Иначе используем вшитую в расширение копию page3.html. */
    try {
      var cfg = (typeof window !== 'undefined' && window.__CHARTER_CFG__) || null;
      if (cfg && typeof cfg.pageUrl === 'string' && cfg.pageUrl.trim()) {
        return cfg.pageUrl.trim();
      }
    } catch (e) { /* noop */ }
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
        return chrome.runtime.getURL('page3.html');
      }
    } catch (e) { /* noop */ }
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

  function loadHtml(attempt) {
    fetch(URL_HTML, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' при загрузке page3.html');
        return r.text();
      })
      .then(function (html) {
        try { sessionStorage.removeItem(RELOAD_GUARD); } catch (e) { /* noop */ }
        replaceDocument(html);
        /* 4) Запускаем витрину. page3.app.js уже в isolated world и объявил
         * init. Исключение внутри init — тот же путь восстановления, а не
         * вечный серый экран поверх остановленной страницы. */
        try {
          if (typeof window.__CHARTER_INIT__ === 'function') {
            window.__CHARTER_INIT__();
          }
        } catch (err) {
          recoverOrFallback(err);
        }
      })
      .catch(function (err) {
        if (attempt < 4) {
          setTimeout(function () { loadHtml(attempt + 1); },
            attempt === 1 ? 200 : attempt === 2 ? 600 : 1500);
          return;
        }
        recoverOrFallback(err);
      });
  }

  /* Одноразовая автоперезагрузка вкладки; при повторном провале — фолбэк. */
  function recoverOrFallback(err) {
    var alreadyTried = false;
    try { alreadyTried = sessionStorage.getItem(RELOAD_GUARD) === '1'; } catch (e) { /* noop */ }
    if (!alreadyTried) {
      try {
        sessionStorage.setItem(RELOAD_GUARD, '1');
        location.reload();
        return;
      } catch (e) { /* noop → фолбэк ниже */ }
    }
    showFallback(err);
  }

  loadHtml(1);

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
    } catch (e) { /* noop */ }
  }
})();
