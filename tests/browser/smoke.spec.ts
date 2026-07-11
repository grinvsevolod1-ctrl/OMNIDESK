import { expect, test } from '@playwright/test'

test('login remains usable at the configured viewport', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByRole('heading', { name: 'Вход в Omnidesk' })).toBeVisible()
  await expect(page.getByRole('button', { name: /войти/i })).toBeVisible()
})

test('widget artifact is served as executable JavaScript', async ({ request }) => {
  const response = await request.get('/livechat.js')
  expect(response.ok()).toBeTruthy()
  expect(response.headers()['content-type']).toContain('javascript')
  const source = await response.text()
  expect(source).toContain('SupportChat')
  expect(source).toContain('Generated from widget-src/livechat.js')
})
