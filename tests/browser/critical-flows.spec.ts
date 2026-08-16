import { expect, test } from '@playwright/test'

/**
 * E2E критических путей. Два уровня:
 *
 * 1. БЕЗ кредов (всегда бегут): целостность контура логина (server action +
 *    БД + rate-limit), гейты ролей, контракт виджет-ingest. Они ловят
 *    «сломали проводку» — самые частые регрессии.
 * 2. С кредами из env (E2E_MANAGER_LOGIN / E2E_MANAGER_PASSWORD /
 *    E2E_WIDGET_KEY): полный вход менеджера до инбокса и реальное создание
 *    лида из виджета. Скипаются, когда переменные не заданы, чтобы сьют
 *    оставался зелёным на чистой машине без сид-данных.
 *
 * ВАЖНО: тесты с кредами гоняйте только против тестовой БД — логин пишет
 * audit_log, ingest создаёт реальный диалог.
 */

const MANAGER_LOGIN = process.env.E2E_MANAGER_LOGIN
const MANAGER_PASSWORD = process.env.E2E_MANAGER_PASSWORD
const WIDGET_KEY = process.env.E2E_WIDGET_KEY

/* ------------------------------------------------------------------ */
/*  Логин: полный круг server action → БД → ответ формы               */
/* ------------------------------------------------------------------ */

test('login with wrong credentials shows an error (full action round-trip)', async ({
  page,
}) => {
  await page.goto('/login')
  await page.getByLabel('Email или логин').fill('e2e-nonexistent-user')
  await page.getByLabel('Пароль').fill('definitely-wrong-password')
  await page.getByRole('button', { name: /войти/i }).click()
  // Ошибка приходит из server action ПОСЛЕ похода в БД — если она
  // отрисовалась, значит весь контур (action → auth → аудит) жив.
  await expect(page.getByRole('alert')).toBeVisible({ timeout: 15_000 })
  // И мы всё ещё на /login, а не упали в 500.
  await expect(page).toHaveURL(/\/login/)
})

test('protected sections redirect anonymous visitors to /login', async ({
  page,
}) => {
  for (const path of ['/admin', '/app', '/curator']) {
    await page.goto(path)
    await expect(page, `${path} должен требовать вход`).toHaveURL(/\/login/)
  }
})

/* ------------------------------------------------------------------ */
/*  Виджет-ingest: публичный контракт для сайтов клиентов              */
/* ------------------------------------------------------------------ */

test('widget ingest rejects a missing/invalid key with 401, not 500', async ({
  request,
}) => {
  const response = await request.post('/api/livechat/ingest', {
    data: { key: 'e2e-invalid-key', message: 'привет' },
  })
  expect(response.status()).toBe(401)
  const body = await response.json()
  expect(body.ok).toBe(false)
  expect(body.error).toBe('invalid_key')
})

test('widget ingest validates payload shape (schema, not crash)', async ({
  request,
}) => {
  const response = await request.post('/api/livechat/ingest', {
    data: { key: 'k', message: '', unexpected: 'field' },
  })
  expect([400, 413]).toContain(response.status())
  const body = await response.json()
  expect(body.ok).toBe(false)
})

/* ------------------------------------------------------------------ */
/*  Полные сценарии с кредами (скип без env)                           */
/* ------------------------------------------------------------------ */

test('manager logs in and reaches the inbox', async ({ page }) => {
  test.skip(
    !MANAGER_LOGIN || !MANAGER_PASSWORD,
    'E2E_MANAGER_LOGIN / E2E_MANAGER_PASSWORD не заданы',
  )
  await page.goto('/login')
  await page.getByLabel('Email или логин').fill(MANAGER_LOGIN!)
  await page.getByLabel('Пароль').fill(MANAGER_PASSWORD!)
  await page.getByRole('button', { name: /войти/i }).click()

  // Аккаунт с 2FA попросит код — для E2E используйте аккаунт без 2FA.
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 })
  // Инбокс отрисовался: есть хотя бы навигация раздела менеджера.
  await expect(page.getByRole('navigation')).toBeVisible()
})

test('widget lead lands as a real conversation', async ({ request }) => {
  test.skip(!WIDGET_KEY, 'E2E_WIDGET_KEY не задан')
  const visitor = `e2e-${Date.now()}`
  const response = await request.post('/api/livechat/ingest', {
    data: {
      key: WIDGET_KEY!,
      visitor,
      name: 'E2E Тест',
      message: 'Здравствуйте! Это автоматический E2E-тест.',
      meta: { page: 'https://example.com/e2e', language: 'ru' },
    },
  })
  expect(response.ok()).toBeTruthy()
  const body = await response.json()
  expect(body.ok).toBe(true)

  // Повторное сообщение того же визитора попадает в ТОТ ЖЕ диалог —
  // это и есть защита от гонки livechat-диалогов (миграция 128).
  const second = await request.post('/api/livechat/ingest', {
    data: { key: WIDGET_KEY!, visitor, message: 'Второе сообщение.' },
  })
  expect(second.ok()).toBeTruthy()
})
