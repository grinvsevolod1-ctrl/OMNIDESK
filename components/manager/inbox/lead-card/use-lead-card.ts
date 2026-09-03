'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import useSWR from 'swr'
import { toast } from 'sonner'
import {
  addLeadCommentAction,
  getCityRegionAction,
  getLeadCardAction,
  getLeadCardDetailAction,
  saveLeadCardAction,
} from '@/app/actions/lead-cards'

export interface LeadCardDefaults {
  fullName?: string
  phone?: string
  telegramUsername?: string
  telegramId?: string
  city?: string
}

/** Вакансия по умолчанию — «Курьер» должна стоять всегда. */
const DEFAULT_VACANCY = 'Курьер'

/** Сериализация полей формы для сравнения «есть ли несохранённые правки». */
function makeSnapshot(f: {
  fullName: string
  phone: string
  telegramUsername: string
  telegramId: string
  city: string
  address: string
  vacancy: string
}): string {
  return JSON.stringify([
    f.fullName,
    f.phone,
    f.telegramUsername,
    f.telegramId,
    f.city,
    f.address,
    f.vacancy,
  ])
}

/**
 * Всё состояние и логика «Карточки лида»: поля формы, сброс при смене
 * диалога, ленивое создание карточки для вложений, поиск менеджеров по
 * кадрам по городу, детали (статусы/комментарии) и сохранение/передача.
 * Контейнер lead-card-panel.tsx остаётся чистой разметкой.
 */
export function useLeadCard(conversationId: string, defaults?: LeadCardDefaults) {
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [cardId, setCardId] = useState<string | null>(null)
  const [freeComment, setFreeComment] = useState('')
  const [fullName, setFullName] = useState(defaults?.fullName ?? '')
  const [phone, setPhone] = useState(defaults?.phone ?? '')
  const [telegramUsername, setTelegramUsername] = useState(
    defaults?.telegramUsername ?? '',
  )
  const [telegramId, setTelegramId] = useState(defaults?.telegramId ?? '')
  const [city, setCity] = useState(defaults?.city ?? '')
  const [address, setAddress] = useState('')
  // «Курьер» — вакансия по умолчанию: должна стоять всегда, менеджер меняет
  // только в исключительных случаях.
  const [vacancy, setVacancy] = useState(DEFAULT_VACANCY)
  const [transferredAt, setTransferredAt] = useState<string | null>(null)
  // Снимок последнего сохранённого/загруженного состояния полей — по нему
  // определяем «грязность» формы для автосохранения при закрытии карточки.
  const savedSnapshotRef = useRef<string>('')

  const load = useCallback(async () => {
    const card = await getLeadCardAction(conversationId)
    if (card) {
      const fields = {
        fullName: card.fullName || defaults?.fullName || '',
        phone: card.phone || defaults?.phone || '',
        telegramUsername:
          card.telegramUsername || defaults?.telegramUsername || '',
        telegramId: card.telegramId || defaults?.telegramId || '',
        city: card.city || defaults?.city || '',
        address: card.address,
        vacancy: card.vacancy || DEFAULT_VACANCY,
      }
      setCardId(card.id)
      setFullName(fields.fullName)
      setPhone(fields.phone)
      setTelegramUsername(fields.telegramUsername)
      setTelegramId(fields.telegramId)
      setCity(fields.city)
      setAddress(fields.address)
      setVacancy(fields.vacancy)
      setTransferredAt(card.transferredAt)
      savedSnapshotRef.current = makeSnapshot(fields)
    } else {
      // No card for this contact yet — make sure the form shows THIS
      // conversation's defaults, never leftovers from a previous thread.
      const fields = {
        fullName: defaults?.fullName ?? '',
        phone: defaults?.phone ?? '',
        telegramUsername: defaults?.telegramUsername ?? '',
        telegramId: defaults?.telegramId ?? '',
        city: defaults?.city ?? '',
        address: '',
        vacancy: DEFAULT_VACANCY,
      }
      setCardId(null)
      setFullName(fields.fullName)
      setPhone(fields.phone)
      setTelegramUsername(fields.telegramUsername)
      setTelegramId(fields.telegramId)
      setCity(fields.city)
      setAddress(fields.address)
      setVacancy(fields.vacancy)
      setTransferredAt(null)
      savedSnapshotRef.current = makeSnapshot(fields)
    }
  }, [conversationId, defaults])

  // Reset when the conversation changes — state adjustment during render
  // (the React-recommended alternative to a setState-in-effect). EVERY field
  // is reset here: previously only cardId was cleared, which leaked
  // the previous lead's data into the next dialog until a page reload.
  const [prevConversationId, setPrevConversationId] = useState(conversationId)
  if (prevConversationId !== conversationId) {
    setPrevConversationId(conversationId)
    setOpen(false)
    setCardId(null)
    setFreeComment('')
    setFullName(defaults?.fullName ?? '')
    setPhone(defaults?.phone ?? '')
    setTelegramUsername(defaults?.telegramUsername ?? '')
    setTelegramId(defaults?.telegramId ?? '')
    setCity(defaults?.city ?? '')
    setAddress('')
    setVacancy(DEFAULT_VACANCY)
    setTransferredAt(null)
  }

  // Снапшот дефолтов для нового диалога — в эффекте (не в render-сбросе выше:
  // менять ref во время рендера нельзя). Срабатывает после сброса полей и до
  // любого взаимодействия менеджера с карточкой.
  useEffect(() => {
    savedSnapshotRef.current = makeSnapshot({
      fullName: defaults?.fullName ?? '',
      phone: defaults?.phone ?? '',
      telegramUsername: defaults?.telegramUsername ?? '',
      telegramId: defaults?.telegramId ?? '',
      city: defaults?.city ?? '',
      address: '',
      vacancy: DEFAULT_VACANCY,
    })
    // defaults намеренно только при смене диалога: см. reset-блок выше.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId])

  /**
   * Закрытие карточки = автосохранение. Кнопки «Сохранить» в карточке нет:
   * если менеджер что-то менял (форма «грязная» относительно последнего
   * снимка) — молча сохраняем и показываем зелёное уведомление
   * «Карточка сохранена». Пустую нетронутую форму не сохраняем.
   */
  const closeCard = useCallback(() => {
    setOpen(false)
    const snapshot = makeSnapshot({
      fullName,
      phone,
      telegramUsername,
      telegramId,
      city,
      address,
      vacancy,
    })
    const dirty = snapshot !== savedSnapshotRef.current
    // Ничего не менялось — просто закрываем.
    if (!dirty) return
    // Совсем пустая форма (все поля кроме дефолтной вакансии пусты) — не
    // создаём карточку-призрак.
    const hasContent =
      fullName.trim() ||
      phone.trim() ||
      telegramUsername.trim() ||
      telegramId.trim() ||
      city.trim() ||
      address.trim()
    if (!cardId && !hasContent) return
    void (async () => {
      const res = await saveLeadCardAction({
        conversationId,
        fullName,
        phone,
        telegramUsername,
        telegramId,
        city,
        address,
        vacancy,
      })
      if (res.ok) {
        savedSnapshotRef.current = snapshot
        toast.success('Карточка сохранена', {
          className:
            'bg-emerald-500/15 border-emerald-500/30 text-emerald-700 dark:text-emerald-300 backdrop-blur',
        })
        if (!cardId) {
          const card = await getLeadCardAction(conversationId)
          if (card) setCardId(card.id)
        }
      } else {
        toast.error(res.message)
      }
    })()
  }, [
    cardId,
    conversationId,
    fullName,
    phone,
    telegramUsername,
    telegramId,
    city,
    address,
    vacancy,
  ])

  function toggleOpen() {
    if (open) {
      closeCard()
      return
    }
    setOpen(true)
    // Refetch on every open: the card may have been updated from another
    // dialog of the same contact or by the curator/admin meanwhile.
    void load()
  }

  // Сообщаем инбоксу об открытии/закрытии карточки: медиа-режим (кружки/фото)
  // существует только рядом с открытой карточкой — при её закрытии бар
  // навигации тоже закрывается и раскладка возвращается в исходное состояние
  // (иначе оставался правый отступ под карточку — «чёрный экран»).
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('omnidesk:lead-card-open', { detail: { open } }),
    )
  }, [open])

  // Esc closes the card first (capture phase + preventDefault so the
  // inbox-level handler doesn't ALSO close the dialog in the same press);
  // a second Esc then closes the dialog as usual. Закрытие по Esc — тоже
  // автосохранение (та же логика, что клик по крестику/оверлею).
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      closeCard()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, closeCard])

  // Lock body scroll while panel is open on mobile.
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  // Город нужен для маршрутизации в пул команды по региону (миграция 150),
  // но конкретного куратора менеджер больше НЕ выбирает — систему разбирают
  // кураторы команды сами (claim). Здесь оставлена только подсказка области.
  const cityQuery = open ? city.trim() : ''

  // Область введённого города (миграция 124): подтягивается автоматически и
  // показывается менеджеру под полем «Город» — видно, по какой области
  // подобрался куратор («Химки» → «Московская область»).
  const { data: cityRegionData } = useSWR(
    cityQuery.length >= 2 ? ['city-region', cityQuery.toLowerCase()] : null,
    () => getCityRegionAction(cityQuery),
    { revalidateOnFocus: false, keepPreviousData: true, dedupingInterval: 300 },
  )
  const cityRegion =
    cityQuery.length >= 2 ? (cityRegionData ?? null) : null

  // Детали карточки (статусы/комментарии менеджера по кадрам + вложения) — после сохранения.
  const { data: detail, mutate: mutateDetail } = useSWR(
    open && cardId ? ['lead-card-detail', cardId] : null,
    () => getLeadCardDetailAction(cardId as string),
    { revalidateOnFocus: false },
  )

  function submitComment() {
    if (!cardId || !freeComment.trim()) return
    startTransition(async () => {
      const res = await addLeadCommentAction({
        leadCardId: cardId,
        body: freeComment,
      })
      if (res.ok) {
        toast.success(res.message)
        setFreeComment('')
        await mutateDetail()
      } else {
        toast.error(res.message)
      }
    })
  }

  /**
   * Передача лида (миграция 150): уходит в ПУЛ команды менеджера, кураторы
   * разбирают вручную (claim). Конкретный куратор здесь не выбирается, поэтому
   * авто-вставка контакта куратора в композер убрана — куратор станет известен
   * только после того, как возьмёт лид в работу.
   */
  function save(transfer: boolean) {
    startTransition(async () => {
      const res = await saveLeadCardAction({
        conversationId,
        fullName,
        phone,
        telegramUsername,
        telegramId,
        city,
        address,
        vacancy,
        transferToTeam: transfer,
      })
      if (res.ok) {
        toast.success(res.message)
        savedSnapshotRef.current = makeSnapshot({
          fullName,
          phone,
          telegramUsername,
          telegramId,
          city,
          address,
          vacancy,
        })
        if (transfer) {
          setTransferredAt(new Date().toISOString())
          setOpen(false)
        }
        // Подхватить id только что созданной карточки — открывает блок
        // файлов/комментариев без повторного открытия панели.
        if (!cardId) await load()
      } else {
        toast.error(res.message)
      }
    })
  }

  /**
   * Вложения доступны СРАЗУ, до сохранения: при первом прикреплении карточка
   * тихо сохраняется с текущими полями, и файл цепляется уже к ней.
   */
  const ensureCardId = useCallback(async (): Promise<string | null> => {
    if (cardId) return cardId
    const res = await saveLeadCardAction({
      conversationId,
      fullName,
      phone,
      telegramUsername,
      telegramId,
      city,
      address,
      vacancy,
    })
    if (!res.ok) {
      toast.error(res.message)
      return null
    }
    const card = await getLeadCardAction(conversationId)
    if (card) setCardId(card.id)
    return card?.id ?? null
  }, [
    cardId,
    conversationId,
    fullName,
    phone,
    telegramUsername,
    telegramId,
    city,
    address,
    vacancy,
  ])

  // Прикрепление кружка/фото происходит в баре навигации по треду (вне этой
  // панели) — событие сообщает карточке, что список вложений изменился.
  useEffect(() => {
    if (!cardId) return
    const onChanged = (e: Event) => {
      const changed = (e as CustomEvent<{ leadCardId?: string }>).detail
      if (!changed?.leadCardId || changed.leadCardId === cardId)
        void mutateDetail()
    }
    window.addEventListener('omnidesk:lead-attachments-changed', onChanged)
    return () =>
      window.removeEventListener('omnidesk:lead-attachments-changed', onChanged)
  }, [cardId, mutateDetail])

  return {
    // panel
    open,
    setOpen,
    toggleOpen,
    closeCard,
    pending,
    // form fields
    fields: {
      fullName,
      setFullName,
      phone,
      setPhone,
      telegramUsername,
      setTelegramUsername,
      telegramId,
      setTelegramId,
      city,
      setCity,
      address,
      setAddress,
      vacancy,
      setVacancy,
    },
    // city region hint (для маршрутизации в пул по региону)
    cityRegion,
    // card / detail
    cardId,
    detail,
    mutateDetail,
    transferredAt,
    freeComment,
    setFreeComment,
    submitComment,
    save,
    ensureCardId,
  }
}

export type LeadCardState = ReturnType<typeof useLeadCard>
