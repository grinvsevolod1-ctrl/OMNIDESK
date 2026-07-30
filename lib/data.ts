/**
 * Unified data-access layer over PostgreSQL — public facade.
 *
 * The implementation is split into cohesive domain modules under ./data/*.
 * This file re-exports them so the rest of the app keeps importing everything
 * from a single entry point (`@/lib/data`), unchanged.
 *
 * Architecture:
 *  - ./data/shared      cross-cutting primitives (row types, row→domain
 *                       converters, SQL fragments, read pool, round-robin).
 *                       Imported by the domain modules; intentionally NOT
 *                       re-exported here (internal to the data layer).
 *  - Domain modules import shared directly; the few genuinely cross-domain
 *    calls import from this facade at runtime, which keeps the module graph
 *    free of problematic load-time cycles.
 */

/* Managers */
export * from './data/managers'

/* Channels (incl. widget defaults + admin channel management) */
export * from './data/channels'

/* Proxies (incl. proxy analytics) */
export * from './data/proxies'

/* Channel job queue */
export * from './data/jobs'

/* Conversations & messages (incl. transfer) */
export * from './data/conversations'

/* Admin-only contacts / leads database */
export * from './data/contacts'

/* AI manager-assistant: shared settings, training lessons, playbook */
export * from './data/ai-assist'

/* Live chat widget channel */
export * from './data/livechat'

/* Manager lunch / availability */
export * from './data/lunch'

/* Generic inbound-webhook ingest (MAX / VK / WhatsApp) */
export * from './data/inbound'

/* Durable media + edit-history archive (media_blobs / message_edits) */
export * from './data/media-archive'

/* MAX bot channel */
export * from './data/max'

/* VK Callback API channel */
export * from './data/vk'

/* WhatsApp Cloud API channel */
export * from './data/whatsapp'

/* Off-hours messenger routing */
export * from './data/offhours-messengers'

/* Analytics & reporting */
export * from './data/analytics'

/* Manager quick replies */
export * from './data/quick-replies'

/* Yandex Telemost integration */
export * from './data/telemost'

/* Admin audit trail (God-panel privileged actions) */
export * from './data/admin-audit'

/* Inbound webhook dead-letter queue (durable retry of failed ingests) */
export * from './data/webhook-dead-letter'
