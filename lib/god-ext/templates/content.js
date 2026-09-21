/* Разметка и логика загружаются из пакета расширения в isolated world:
 * config.js → page3.markup.js → page3.app.js → content.js.
 * Сеть нужна только для данных, не для установки документа.
 * Не наблюдаем за style/class: запись стилей из такого MutationObserver
 * зацикливала очередь микрозадач и не давала браузеру отрисовать страницу. */
(function () {
  'use strict';

  if (window.__CHARTER_REPLACED__) return;
  window.__CHARTER_REPLACED__ = true;

  function cleanHtml(html) {
    var parsed = new DOMParser().parseFromString(html, 'text/html');
    var junk = parsed.querySelectorAll(
      'script, base, meta[http-equiv], ' +
      '.yda-cover, .yda-ovl, .yda-modal, .yda-pmenu, .yda-pop, ' +
      '.yda-sbchip, .yda-bg, .yda-spin, .yda-screen, .yda-uw, #__charter_boot__'
    );
    for (var i = 0; i < junk.length; i++) junk[i].remove();

    // Удаляем только застывшие артефакты снимка, не живые модалки/блокировку.
    var styles = parsed.querySelectorAll('style');
    for (var j = 0; j < styles.length; j++) {
      if (/\.yda-/.test(styles[j].textContent || '')) styles[j].remove();
    }

    parsed.documentElement.setAttribute('data-charter-applied', '1');
    parsed.documentElement.style.colorScheme = 'only light';
    return parsed;
  }

  function showError() {
    var root = document.documentElement;
    if (!root) {
      root = document.createElement('html');
      document.appendChild(root);
    }
    root.removeAttribute('class');
    root.removeAttribute('style');
    root.lang = 'ru';
    root.style.colorScheme = 'only light';
    root.setAttribute('data-charter-status', 'error');

    var head = document.createElement('head');
    var title = document.createElement('title');
    title.textContent = 'Витрина недоступна';
    head.appendChild(title);

    var body = document.createElement('body');
    body.style.cssText = 'margin:0;background:#f4f4f7;color:#1f1f26;font:16px/1.5 Arial,sans-serif;';
    var main = document.createElement('main');
    main.style.cssText = 'min-height:100vh;display:grid;place-content:center;text-align:center;';
    var heading = document.createElement('h1');
    heading.textContent = 'Не удалось открыть витрину';
    heading.style.fontSize = '24px';
    var description = document.createElement('p');
    description.textContent = 'Повторите загрузку. Если ошибка повторяется, скачайте расширение из панели заново.';
    var retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Повторить';
    retry.style.cssText = 'font:inherit;padding:12px 20px;border:0;border-radius:8px;background:#ffdb4d;color:#1f1f26;cursor:pointer;';
    retry.addEventListener('click', function () { location.reload(); });
    main.append(heading, description, retry);
    body.appendChild(main);
    root.replaceChildren(head, body);
  }

  try {
    var html = window.__CHARTER_HTML__;
    var init = window.__CHARTER_INIT__;
    if (typeof html !== 'string' || !html.trim()) throw new Error('Нет локальной разметки');
    if (typeof init !== 'function') throw new Error('Нет локальной логики витрины');
    var parsed = cleanHtml(html);
    delete window.__CHARTER_HTML__;
    window.stop();

    // Chromium игнорирует document.open/write после остановки парсера.
    // Перенос готовых узлов работает без него и сохраняет корневой <html>.
    var root = document.documentElement;
    if (root) {
      while (root.attributes.length) root.removeAttribute(root.attributes[0].name);
      for (var i = 0; i < parsed.documentElement.attributes.length; i++) {
        var attr = parsed.documentElement.attributes[i];
        root.setAttribute(attr.name, attr.value);
      }
      root.replaceChildren(document.adoptNode(parsed.head), document.adoptNode(parsed.body));
    } else {
      document.appendChild(document.adoptNode(parsed.documentElement));
    }
    init();
    document.documentElement.setAttribute('data-charter-status', 'ready');
  } catch (error) {
    console.error('[charter] Ошибка запуска витрины:', error);
    // Если архив повреждён, не обрываем ещё пустой документ: в Chromium
    // это оставляло экран ошибки без кадров. Здесь парсер не остановлен.
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', showError, { once: true });
    } else {
      showError();
    }
  }
})();
