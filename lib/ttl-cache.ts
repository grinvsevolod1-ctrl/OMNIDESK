/**
 * Крошечный in-process TTL-кэш для горячих читаемых данных.
 *
 * Зачем он есть, когда есть Redis/unstable_cache: панель работает одним
 * Node-процессом на VPS (PM2), поэтому кэш в памяти процесса — самый дешёвый
 * и предсказуемый вариант без новых зависимостей. Паттерн уже проверен в
 * app/api/livechat/config/route.ts — здесь он обобщён, чтобы не копировать
 * Map + expires в каждый модуль.
 *
 * Свойства:
 * - значения считаются ИММУТАБЕЛЬНЫМИ: один объект может раздаваться
 *   нескольким конкурентным запросам, мутировать его нельзя (копируйте);
 * - кэшируются и отрицательные результаты (null), чтобы флуд несуществующими
 *   ключами не пробивал кэш насквозь в БД;
 * - размер ограничен: при переполнении сначала выметаются протухшие записи,
 *   и только если места всё равно нет — удаляется самая старая запись.
 *   Полный clear() здесь был бы thundering herd: все горячие ключи разом
 *   уходили бы в БД (та же ошибка уже была исправлена в lib/rate-limit.ts);
 * - НЕ переживает рестарт процесса и НЕ синхронизируется между процессами —
 *   для данных, где устаревание на ttlMs незаметно (конфиги, метрики).
 */
export class TtlCache<V> {
  private map = new Map<string, { value: V; expires: number }>()

  constructor(
    private readonly ttlMs: number,
    private readonly maxSize = 500,
  ) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key)
    if (!hit) return undefined
    if (hit.expires <= Date.now()) {
      this.map.delete(key)
      return undefined
    }
    return hit.value
  }

  set(key: string, value: V): void {
    if (this.map.size >= this.maxSize && !this.map.has(key)) {
      // Сначала выметаем протухшее — обычно этого достаточно.
      const now = Date.now()
      for (const [k, v] of this.map) {
        if (v.expires <= now) this.map.delete(k)
      }
      // Всё ещё нет места — удаляем самую старую запись (первую в Map:
      // порядок вставки). Не LRU, но горячие ключи переживают эвикцию,
      // в отличие от полного clear().
      while (this.map.size >= this.maxSize) {
        const oldest = this.map.keys().next().value
        if (oldest === undefined) break
        this.map.delete(oldest)
      }
    }
    this.map.set(key, { value, expires: Date.now() + this.ttlMs })
  }

  /** Точечная инвалидация (например, после сохранения из админки). */
  delete(key: string): void {
    this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }

  /**
   * Стандартный флоу «отдай из кэша или сходи и запомни».
   * ВАЖНО: null — валидный кэшируемый результат (negative caching), поэтому
   * loader типизирован как V, а «нет в кэше» различается через undefined.
   */
  async getOrLoad(key: string, loader: () => Promise<V>): Promise<V> {
    const hit = this.get(key)
    if (hit !== undefined) return hit
    const value = await loader()
    this.set(key, value)
    return value
  }
}
