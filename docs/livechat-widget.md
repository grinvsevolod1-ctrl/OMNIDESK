# Live-chat widget — developer guide

How the embeddable website chat widget is created in the admin, how to install
it, how integration status is tracked, and how visitor routing behaves. This
mirrors the in-app **Documentation** tab (`/admin/docs`). The public panel
domain used throughout is `charter-panel.com`.

---

## 1. Creating a widget (admin)

Path: **`/admin/livechat`** (component: `components/admin/livechat-admin.tsx`).

Click **Add live chat** and fill in:

| Field | Required | Meaning |
| --- | --- | --- |
| **Name** | no (defaults to `Live chat`) | Internal label shown on the admin card. |
| **Website domain** | no | Informational only — shown on the admin card. The widget works on any domain; access is controlled by the API key (see §5). |
| **Manager queue** | yes (≥1) | Ordered list of managers. The selection order **is** the round-robin order; the first manager is the channel owner. |

On save the server (`createLivechatAction`) mints a public API key (`lc_…`) and
creates a `livechat` channel with `status: 'pending'` and
`config = { domain, apiKey, pool, rrCursor }`. A dialog then shows the install
snippet.

### Visual editor (per-site, live)

Each card has a **«Настроить чат»** button → full-screen **widget editor**
(`components/admin/widget-editor.tsx`, action `updateLivechatWidgetConfigAction`)
with a live `<iframe>` preview that renders the **real** widget in preview mode.
Edits are pushed into the iframe over `postMessage`, so the admin sees exactly
what visitors see. Every site is configured **independently**; tabs cover:

- **Вид** — header title, subtitle, agent name + avatar, brand color, side
  (left/right), and the greeting teaser (text + sub-line).
- **Контент** — welcome message shown on open, quick-reply chips, input
  placeholder, and whether to show messenger buttons during working hours.
- **Мессенджеры** — per-site Telegram / WhatsApp / custom buttons.
- **Часы** — per-site working hours (timezone, open/close, weekdays, overnight
  windows) and the off-hours screen copy.
- **Поведение** — auto-open after N seconds.

The whole config is stored under `channels.config.widget` (jsonb — **no schema
migration**), validated server-side by `resolveWidgetConfig` in
`lib/widget-config.ts`. Admin-wide **default working hours** live in
`app_settings` (`livechat_defaults`) and seed any site that hasn't overridden
them (`components/admin/livechat-defaults.tsx`).

**Live updates without reinstalling the snippet:** the widget polls
`GET /api/livechat/config?key=…` every ~15s. The endpoint returns the resolved
per-site config plus an authoritative, server-computed `offHours` flag (from the
site's own working hours via `isOffHoursFor`). The snippet carries only the key —
all look & feel comes from this config poll.

---

## 2. Getting the embed code

There is one install method: a single async script tag. Paste it into the page
HTML (ideally before `</body>`). It works on any site and any framework — for
React/Next.js add the same tag to your markup (e.g. `app/layout.tsx` inside
`<body>`).

```html
<script async src="https://charter-panel.com/widget.js"
  data-support-key="lc_xxx"></script>
```

Only `data-support-key` is required (the older `data-omnidesk-key` name is still
accepted for already-deployed snippets). The script auto-mounts a floating
launcher + chat panel (no iframe) and talks to two endpoints:

- `POST /api/livechat/ingest` — visitor → panel sends a message.
- `GET  /api/livechat/stream` — Server-Sent Events: history replay + agent
  replies in realtime.

Both authenticate with the channel **API key**.

---

## 3. Status lifecycle (single source of truth)

`channels.status` is the single source of truth, surfaced by
`isLivechatConnected(channel)` in `lib/data.ts`:

```ts
isLivechatConnected(channel) => channel.status === 'connected'
```

- **`pending`** — created in the admin, the widget has never connected from the
  live site yet. Shown in the admin as **Not integrated**.
- **`connected`** — the widget successfully handshaked from the installed site.
  Shown as **Active**.

The `pending → connected` transition is automatic: when the widget opens its
stream from the installed page, `app/api/livechat/stream/route.ts` calls
`markLivechatConnected(channelId)`. This is why the admin never shows a false
"Active" before the chat is really installed, and why `/admin/channels` moves off
`pending` once the site goes live.

---

## 4. Availability — the chat is always reachable

The widget renders whenever the API key resolves to an existing channel.
Deleting **managers** never deletes the chat:

- `channels.manager_id` is `ON DELETE SET NULL` (migration `008`), so a live-chat
  channel outlives its owner.
- `deleteManager` strips the removed id from every live-chat `config.pool` and
  deletes only the manager's worker-backed (telegram/whatsapp) channels.

When no manager is available, `POST /api/livechat/ingest` returns
`{ ok: true, noAgents: true }` and **does not** create a conversation. The widget
keeps the chat open and shows a notice:

> «К сожалению, сейчас мы не можем ответить. Оставьте сообщение — мы свяжемся с
> вами, как только освободимся.»

Assign a manager again and routing resumes immediately.

---

## 5. Access model

`originAllowed` (`lib/livechat.ts`) always returns `true`: the channel **API
key** is the access boundary, so the same snippet works on any domain
(production, staging, localhost) with no per-site configuration. The key is a
public channel identifier whose only capability is posting to its own channel.
The channel `domain` field is informational only and never blocks requests.

---

## 6. Optional control API & analytics events

The widget works with zero code. Optionally, the global `window.SupportChat`
lets you open/close it and hook analytics:

```js
SupportChat.open({ name, subject, message }) // open + prefill
SupportChat.close()
SupportChat.on('open',          () => {})
SupportChat.on('close',         () => {})
SupportChat.on('message_sent',  ({ body, count }) => {})
SupportChat.on('first_message', ({ body }) => {})
```

Subscriptions made before the widget mounts are queued and flushed once it is
ready, so calling `.on(...)` from `<head>` is safe.

---

## 7. Where things live

| Concern | Location |
| --- | --- |
| Status definition (source of truth) | `isLivechatConnected` in `lib/data.ts` |
| Mark connected (pending → connected) | `markLivechatConnected` in `lib/data.ts` |
| Agent availability / no-agents check | `resolveLivechatAgentId` in `lib/data.ts` |
| Manager removal keeps the chat | `deleteManager` in `lib/data.ts` + `scripts/008_livechat_status.sql` |
| API key → channel | `getLivechatChannelByApiKey` in `lib/data.ts` |
| API key → channel + resolved widget config | `getLivechatWidgetConfigByApiKey` in `lib/data.ts` |
| Per-site widget config schema + validation | `lib/widget-config.ts` |
| Live widget config (polled by the widget) | `app/api/livechat/config/route.ts` |
| Per-site off-hours computation | `isOffHoursFor` in `lib/offhours.ts` |
| Visual widget editor (live iframe preview) | `components/admin/widget-editor.tsx` |
| Admin-wide default working hours | `components/admin/livechat-defaults.tsx` + `app_settings.livechat_defaults` |
| Stream handshake + connect | `app/api/livechat/stream/route.ts` |
| Inbound + no-agents response | `app/api/livechat/ingest/route.ts` |
| Widget UI + no-agents notice | `public/livechat.js` |
| Admin status badge | `WidgetStatus` in `components/admin/livechat-admin.tsx` |
| In-app documentation tab | `app/admin/docs/page.tsx` |

---

## 8. Migration to apply

Run once on the VPS:

```bash
psql "$DATABASE_URL" -f scripts/008_livechat_status.sql
```

It makes `channels.manager_id` nullable and switches its FK to
`ON DELETE SET NULL` so live-chat channels survive manager deletion.
