/**
 * Клиентское сжатие фото перед загрузкой: даунскейл до maxSide по большей
 * стороне + перекодирование в JPEG. На мобильном интернете это в разы
 * ускоряет загрузку (фото с камеры 8–12 МБ → ~0.5–1.5 МБ) и экономит место
 * в БД. GIF (анимация), SVG и не-изображения возвращаются как есть; если
 * сжатая версия вышла крупнее оригинала — тоже возвращаем оригинал.
 */
export async function compressImageFile(
  file: File,
  opts: { maxSide?: number; quality?: number } = {},
): Promise<File> {
  const { maxSide = 2048, quality = 0.85 } = opts
  const mime = file.type
  if (!mime.startsWith('image/')) return file
  // Анимации и вектор не трогаем — canvas убьёт анимацию/масштабируемость.
  if (mime === 'image/gif' || mime === 'image/svg+xml') return file
  // Маленькие файлы не пережимаем — экономия не окупит потерю качества.
  if (file.size < 300 * 1024) return file

  try {
    const bitmap = await createImageBitmap(file)
    const { width, height } = bitmap
    const scale = Math.min(1, maxSide / Math.max(width, height))
    const w = Math.max(1, Math.round(width * scale))
    const h = Math.max(1, Math.round(height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close()

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality),
    )
    if (!blob || blob.size >= file.size) return file

    const name = file.name.replace(/\.[^.]+$/, '') + '.jpg'
    return new File([blob], name, { type: 'image/jpeg' })
  } catch {
    // Битое изображение или отсутствие canvas — грузим оригинал.
    return file
  }
}
