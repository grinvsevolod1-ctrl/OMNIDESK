/* Charter Panel — сервис-воркер (сетевой прокси ВНЕ CSP страницы).
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ (фикс «тёмный/пустой экран на direct.yandex.ru»):
 *  В Manifest V3 fetch/XHR/EventSource, запущенные из content-скрипта,
 *  подчиняются CSP САМОЙ страницы — прежде всего директиве connect-src.
 *  У direct.yandex.ru connect-src НЕ содержит ни origin панели, ни схемы
 *  chrome-extension:, поэтому из content-скрипта блокируются ВСЕ сетевые
 *  запросы: и загрузка свежей разметки витрины с панели, и даже чтение
 *  вшитой page3.html через chrome.runtime.getURL (это тоже connect-src!),
 *  и запросы данных /state, и SSE. Раньше всё держалось исключительно на
 *  срезе CSP через rules.json (declarativeNetRequest); стоило ему не
 *  сработать — пользователь оставался перед пустым (тёмным под force-dark)
 *  boot-оверлеем.
 *
 *  Сервис-воркер расширения CSP страницы НЕ ограничивает и, имея
 *  host_permissions на origin панели, ходит на него БЕЗ CORS-преград.
 *  Поэтому весь сетевой ввод-вывод расширения проксируется сюда по
 *  chrome.runtime.sendMessage. rules.json остаётся как defense-in-depth
 *  (нужен ещё и для ресурсов, которые грузит уже подменённый DOM витрины).
 *
 * КОНТРАКТ (всегда ОТВЕЧАЕМ, даже ошибкой — иначе content.js/page3.app.js
 * зависнут в ожидании; return true держит канал открытым до async ответа):
 *  - { type: 'charter-fetch', url, method?, headers?, body? }
 *      → { ok, status, body }  (body — всегда текст; JSON парсит вызывающий)
 *  - { type: 'charter-bundled' }
 *      → { ok, status, body }  (вшитая page3.html из пакета расширения)
 *
 * БЕЗОПАСНОСТЬ: externally_connectable не задан, поэтому слать сюда
 * сообщения могут ТОЛЬКО собственные content-скрипты расширения (страница
 * из main world — не может). URL всё равно ограничиваем https/chrome-extension.
 */
'use strict';

function charterAllowedUrl(url) {
  try {
    var u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'chrome-extension:';
  } catch (_e) {
    return false;
  }
}

function charterProxyFetch(url, opts, sendResponse) {
  fetch(url, opts)
    .then(function (r) {
      return r.text().then(function (body) {
        sendResponse({ ok: r.ok, status: r.status, body: body });
      });
    })
    .catch(function (e) {
      sendResponse({ ok: false, status: 0, error: (e && e.message) || 'network error' });
    });
}

chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'charter-bundled') {
    var localUrl = chrome.runtime.getURL('page3.html');
    charterProxyFetch(localUrl, { cache: 'no-store' }, sendResponse);
    return true; /* async ответ */
  }

  if (msg.type === 'charter-fetch') {
    if (!msg.url || !charterAllowedUrl(msg.url)) {
      sendResponse({ ok: false, status: 0, error: 'bad url' });
      return true;
    }
    var opts = {
      method: msg.method || 'GET',
      cache: 'no-store',
      headers: msg.headers || {},
    };
    if (msg.body != null) opts.body = msg.body;
    charterProxyFetch(msg.url, opts, sendResponse);
    return true; /* async ответ */
  }

  return; /* неизвестный тип — канал не держим */
});
