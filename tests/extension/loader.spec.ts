import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, expect, test as base, type BrowserContext, type Page } from '@playwright/test'
import { unzipSync } from 'fflate'
import { assembleExtensionZip, renderMarkup } from '../../lib/god-ext/build'

const target = 'https://direct.yandex.ru/dna/campaigns'
const panel = 'https://panel.test'

type Extension = {
  page: Page
  requests: string[]
  state: { blocked: boolean; unavailable: boolean }
}

type Options = { missingMarkup: boolean; loadStyles: boolean }

const test = base.extend<{ extension: Extension } & Options>({
  missingMarkup: [false, { option: true }],
  loadStyles: [false, { option: true }],
  extension: async ({ missingMarkup, loadStyles }, provideExtension) => {
    const dir = await mkdtemp(join(tmpdir(), 'omnidesk-extension-'))
    let context: BrowserContext | undefined
    try {
      const extensionDir = join(dir, 'extension')
      await mkdir(extensionDir)
      const archive = await assembleExtensionZip({
        origin: panel,
        slug: 'browser-test',
        token: 'test-only-token',
        name: 'OMNIDESK browser test',
        version: '1.0.1',
      })
      const files = unzipSync(archive)
      if (missingMarkup) files['page3.markup.js'] = Buffer.from(renderMarkup(''))
      await Promise.all(Object.entries(files).map(([name, data]) => writeFile(join(extensionDir, name), data)))
      context = await chromium.launchPersistentContext(join(dir, 'profile'), {
        channel: 'chromium',
        headless: true,
        viewport: { width: 966, height: 636 },
        colorScheme: 'dark',
        args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
      })
      const requests: string[] = []
      const state = { blocked: false, unavailable: false }
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url())
        requests.push(url.href)
        if (url.href === target) {
          await route.fulfill({
            contentType: 'text/html',
            headers: { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline' https://direct.yastatic.net; img-src data: https://direct.yastatic.net; font-src https://yastatic.net" },
            body: '<!doctype html><html><head><title>Original page</title></head><body><p>Original page</p></body></html>',
          })
        } else if (url.origin === panel && url.pathname.endsWith('/state')) {
          await route.fulfill({
            status: state.unavailable ? 503 : 200,
            contentType: 'application/json',
            body: JSON.stringify({
              login: 'browser-test',
              balance: 1200,
              currency: '₽',
              campaigns: [],
              period: url.searchParams.get('period'),
              blocked: state.blocked,
            }),
          })
        } else if (loadStyles && ['direct.yastatic.net', 'yastatic.net'].includes(url.hostname)) {
          await route.fulfill({ response: await route.fetch() })
        } else {
          await route.abort()
        }
      })
      const page = await context.newPage()
      await provideExtension({ page, requests, state })
    } finally {
      await context?.close()
      await rm(dir, { recursive: true, force: true })
    }
  },
})

async function openExtension(page: Page) {
  await page.goto(target, { waitUntil: 'commit' })
  await expect(page.locator('html')).toHaveAttribute('data-charter-status', 'ready')
  await expect(page.locator('.yda-cover')).toHaveCount(0)
}

test.describe('rendering with the existing CDN styles', () => {
  test.use({ loadStyles: true })

  test('packaged extension paints, responds to input, and survives the old watchdog deadline', async ({ extension }) => {
    const { page, requests } = extension
    await openExtension(page)
    await expect(page).toHaveTitle(/browser-test/)
    expect(requests.some((url) => url.includes('/bundle'))).toBe(false)

    const callbacks = await page.evaluate(async () => {
      let mutations = 0
      const observer = new MutationObserver((records) => { mutations += records.length })
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
      document.documentElement.classList.add('observer-regression')
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      observer.disconnect()
      return mutations
    })
    expect(callbacks).toBe(1)

    await page.getByRole('button', { name: 'Период', exact: true }).click()
    await expect(page.locator('.yda-pmenu')).toBeVisible()
    await page.getByRole('button', { name: 'Вчера', exact: true }).click()
    await expect.poll(() => requests.some((url) => url.endsWith('/state?period=yesterday'))).toBe(true)
    await expect.poll(() => page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')).every((link) => !!link.sheet),
    )).toBe(true)
    await expect.poll(() => page.evaluate(() => document.readyState)).toBe('complete')
    await page.screenshot({ path: '/tmp/agent-browser/omnidesk-extension-local.png' })

    // The previous loader overwrote a successful document after 14 seconds.
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 15_000)))
    await expect(page.locator('html')).toHaveAttribute('data-charter-status', 'ready')
    await expect(page.getByText('Витрина недоступна', { exact: true })).toHaveCount(0)
    await expect(page).toHaveURL(target)
    expect(requests.filter((url) => url === target)).toHaveLength(1)
  })
})

test('API failure does not prevent local document startup', async ({ extension }) => {
  extension.state.unavailable = true
  await openExtension(extension.page)
  await extension.page.getByRole('button', { name: 'Период', exact: true }).click()
  await expect(extension.page.locator('.yda-pmenu')).toBeVisible()
  expect(extension.requests.some((url) => url.includes('/bundle'))).toBe(false)
})

test('legitimate full-screen account blocking is not hidden by the loader', async ({ extension }) => {
  extension.state.blocked = true
  await openExtension(extension.page)
  await expect(extension.page.getByText('Аккаунт заблокирован', { exact: true })).toBeVisible()
  await expect(extension.page).toHaveTitle('Аккаунт заблокирован')
  extension.state.blocked = false
  await expect(extension.page.getByText('Аккаунт заблокирован', { exact: true })).toHaveCount(0, { timeout: 8_000 })
  await expect(extension.page).toHaveTitle(/browser-test/)
})

test.describe('incomplete archive', () => {
  test.use({ missingMarkup: true })

  test('shows an actionable error without automatic reloads', async ({ extension }) => {
    await extension.page.goto(target, { waitUntil: 'commit' })
    await expect(extension.page.locator('html')).toHaveAttribute('data-charter-status', 'error')
    await expect(extension.page.getByRole('heading', { name: 'Не удалось открыть витрину' })).toBeVisible()
    await expect(extension.page.getByRole('button', { name: 'Повторить' })).toBeVisible()
    expect(extension.requests.filter((url) => url === target)).toHaveLength(1)
    await extension.page.getByRole('button', { name: 'Повторить' }).click()
    await expect.poll(() => extension.requests.filter((url) => url === target).length).toBe(2)
    await expect(extension.page.getByRole('heading', { name: 'Не удалось открыть витрину' })).toBeVisible()
  })
})
