'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import useSWR from 'swr'
import { toast } from 'sonner'
import {
  addLeadCommentAction,
  findCuratorsByCityAction,
  getCityRegionAction,
  getLeadCardAction,
  getLeadCardDetailAction,
  saveLeadCardAction,
} from '@/app/actions/lead-cards'
import type { CuratorWithLoad } from '@/lib/data/lead-cards'

export interface LeadCardDefaults {
  fullName?: string
  phone?: string
  telegramUsername?: string
  telegramId?: string
  city?: string
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
  const [vacancy, setVacancy] = useState('')
  const [curatorId, setCuratorId] = useState<string | null>(null)
  const [transferredAt, setTransferredAt] = useState<string | null>(null)
  // true — куратор подставлен автоматически по городу/области (не кликом).
  const [autoPicked, setAutoPicked] = useState(false)

  const load = useCallback(async () => {
    const card = await getLeadCardAction(conversationId)
    if (card) {
      setCardId(card.id)
      setFullName(card.fullName || defaults?.fullName || '')
      setPhone(card.phone || defaults?.phone || '')
      setTelegramUsername(
        card.telegramUsername || defaults?.telegramUsername || '',
      )
      setTelegramId(card.telegramId || defaults?.telegramId || '')
      setCity(card.city || defaults?.city || '')
      setAddress(card.address)
      setVacancy(card.vacancy)
      setCuratorId(card.curatorId)
      setTransferredAt(card.transferredAt)
    } else {
      // No card for this contact yet — make sure the form shows THIS
      // conversation's defaults, never leftovers from a previous thread.
      setCardId(null)
      setFullName(defaults?.fullName ?? '')
      setPhone(defaults?.phone ?? '')
      setTelegramUsername(defaults?.telegramUsername ?? '')
      setTelegramId(defaults?.telegramId ?? '')
      setCity(defaults?.city ?? '')
      setAddress('')
      setVacancy('')
      setCuratorId(null)
      setTransferredAt(null)
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
    setVacancy('')
    setCuratorId(null)
    setTransferredAt(null)
    setAutoPicked(false)
  }

  function toggleOpen() {
    const next = !open
    setOpen(next)
    // Refetch on every open: the card may have been updated from another
    // dialog of the same contact or by the curator/admin meanwhile.
    if (next) void load()
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
  // a second Esc then closes the dialog as usual.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open])

  // Lock body scroll while panel is open on mobile.
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  // Curator search by city (SWR keyed by the trimmed query).
  const cityQuery = open ? city.trim() : ''
  const { data: curatorsData, isLoading: searching } = useSWR(
    cityQuery.length >= 2 ? ['curator-city-search', cityQuery] : null,
    () => findCuratorsByCityAction(cityQuery),
    { revalidateOnFocus: false, keepPreviousData: true, dedupingInterval: 300 },
  )
  const curators: CuratorWithLoad[] =
    cityQuery.length >= 2 ? (curatorsData ?? []) : []

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

  // Автовыбор куратора: как только по городу/области нашлись кураторы и
  // менеджер ещё никого не выбрал — подставляем первого (наименее
  // загруженного; сортировка приходит с сервера). Ручной клик по другому
  // куратору перекрывает автовыбор; смена города сбрасывает выбор и
  // автоподбор срабатывает заново. State adjustment during render — тот же
  // паттерн, что и сброс полей при смене диалога выше (без setState в эффекте).
  const autoCandidate =
    open && !transferredAt && curatorId === null
      ? (curatorsData?.[0] ?? null)
      : null
  if (autoCandidate) {
    setCuratorId(autoCandidate.id)
    setAutoPicked(true)
  }

  function pickCurator(id: string | null) {
    setCuratorId(id)
    setAutoPicked(false)
  }

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
        curatorId: transfer ? curatorId : null,
      })
      if (res.ok) {
        toast.success(res.message)
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
      curatorId: null,
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
    // curators
    curators,
    searching,
    curatorId,
    setCuratorId,
    pickCurator,
    autoPicked,
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
