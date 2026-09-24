/**
 * Имена файлов выгрузки (чистые функции, покрыты тестами вместе с рендером).
 * `dialog-<контакт>-<yyyy-mm-dd>.html` / `.zip` — безопасно для любой ОС и
 * читаемо в папке руководителя: видно, чей диалог и когда выгружен.
 */

/** Папка с вложениями внутри ZIP; на неё ссылаются пути в HTML. */
export const MEDIA_DIR = 'media'

/** Имя HTML-файла внутри архива. */
export const HTML_ENTRY = 'dialog.html'

function safeStem(contactName: string | undefined): string {
  return (contactName ?? '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, '-')
    .trim()
    .slice(0, 40)
}

export function dialogExportFilename(
  contactName: string | undefined,
  ext: 'html' | 'zip',
  now = new Date(),
): string {
  const date = now.toISOString().slice(0, 10)
  const who = safeStem(contactName)
  return who ? `dialog-${who}-${date}.${ext}` : `dialog-${date}.${ext}`
}
