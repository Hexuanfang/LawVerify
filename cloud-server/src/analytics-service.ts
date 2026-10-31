import { z } from 'zod'
import type { AuthenticatedActor } from './commercial/types.js'
import { getPool, isDatabaseEnabled } from './infrastructure/postgres.js'
import { readDevStore, updateDevStore } from './infrastructure/dev-store.js'
import { AppError } from './core/app-error.js'

export const eventNames = ['app.open', 'auth.login', 'document.import', 'document.generate', 'evidence.link', 'legal.verify', 'case.search', 'payment.completed'] as const
export const eventBatchSchema = z.object({
  events: z.array(z.object({
    id: z.string().uuid(),
    name: z.enum(eventNames),
    surface: z.enum(['desktop', 'web']),
    outcome: z.enum(['success', 'failure']),
    durationMs: z.number().int().min(0).max(3600000),
  }).strict()).min(1).max(50),
}).strict()
type Event = z.infer<typeof eventBatchSchema>['events'][number]
const retentionMs = 90 * 86400000

export async function getAnalyticsPreference(actor: AuthenticatedActor) {
  if (!isDatabaseEnabled()) {
    const store = await readDevStore()
    return { enabled: store.analyticsPreferences.find(p => p.userId === actor.userId)?.enabled ?? false }
  }
  const result = await getPool().query<{ enabled: boolean }>('SELECT enabled FROM analytics_preferences WHERE user_id = $1', [actor.userId])
  return { enabled: result.rows[0]?.enabled ?? false }
}

export async function setAnalyticsPreference(actor: AuthenticatedActor, enabled: boolean) {
  if (!isDatabaseEnabled()) return updateDevStore(store => {
    const item = store.analyticsPreferences.find(p => p.userId === actor.userId)
    if (item) item.enabled = enabled
    else store.analyticsPreferences.push({ userId: actor.userId, enabled })
    if (!enabled) store.productEvents = store.productEvents.filter(e => e.userId !== actor.userId)
    return { enabled }
  })
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(`INSERT INTO analytics_preferences (user_id, enabled) VALUES ($1, $2)
      ON CONFLICT (user_id) DO UPDATE SET enabled = $2, updated_at = NOW()`, [actor.userId, enabled])
    if (!enabled) await client.query('DELETE FROM product_events WHERE user_id = $1', [actor.userId])
    await client.query('COMMIT')
    return { enabled }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

export async function ingestProductEvents(actor: AuthenticatedActor, events: Event[]) {
  if (!isDatabaseEnabled()) return updateDevStore(store => {
    if (!store.analyticsPreferences.find(p => p.userId === actor.userId)?.enabled) return { accepted: 0 }
    store.productEvents = store.productEvents.filter(e => Date.parse(e.receivedAt) > Date.now() - retentionMs)
    const daily = store.productEvents.filter(e => e.userId === actor.userId && Date.parse(e.receivedAt) > Date.now() - 86400000)
    if (daily.length + events.length > 1000) throw new AppError('事件数量超过每日限制。', 429, 'EVENT_RATE_LIMIT')
    let accepted = 0
    for (const event of events) {
      if (store.productEvents.some(e => e.userId === actor.userId && e.id === event.id)) continue
      store.productEvents.push({ ...event, userId: actor.userId, receivedAt: new Date().toISOString() }); accepted++
    }
    return { accepted }
  })
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const preference = await client.query<{ enabled: boolean }>('SELECT enabled FROM analytics_preferences WHERE user_id = $1 FOR UPDATE', [actor.userId])
    if (!preference.rows[0]?.enabled) { await client.query('COMMIT'); return { accepted: 0 } }
    await client.query("DELETE FROM product_events WHERE received_at < NOW() - INTERVAL '90 days'")
    const daily = await client.query<{ count: string }>("SELECT COUNT(*) FROM product_events WHERE user_id = $1 AND received_at > NOW() - INTERVAL '1 day'", [actor.userId])
    if (Number(daily.rows[0].count) + events.length > 1000) throw new AppError('事件数量超过每日限制。', 429, 'EVENT_RATE_LIMIT')
    let accepted = 0
    for (const event of events) {
      const result = await client.query(`INSERT INTO product_events (user_id, event_id, name, surface, outcome, duration_ms)
        VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [actor.userId, event.id, event.name, event.surface, event.outcome, event.durationMs])
      accepted += result.rowCount ?? 0
    }
    await client.query('COMMIT')
    return { accepted }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

export async function getProductAnalytics() {
  if (!isDatabaseEnabled()) {
    const store = await readDevStore()
    const events = store.productEvents.filter(e => Date.parse(e.receivedAt) > Date.now() - 30 * 86400000)
    return { days: 30, items: eventNames.flatMap(name => ['desktop', 'web'].flatMap(surface => {
      const matching = events.filter(e => e.name === name && e.surface === surface)
      return matching.length ? [{ name, surface, count: matching.length, failures: matching.filter(e => e.outcome === 'failure').length,
        averageDurationMs: Math.round(matching.reduce((n, e) => n + e.durationMs, 0) / matching.length) }] : []
    })) }
  }
  const result = await getPool().query(`SELECT name, surface, COUNT(*)::int AS count,
    COUNT(*) FILTER (WHERE outcome = 'failure')::int AS failures, ROUND(AVG(duration_ms))::int AS "averageDurationMs"
    FROM product_events WHERE received_at > NOW() - INTERVAL '30 days' GROUP BY name, surface ORDER BY count DESC`)
  return { days: 30, items: result.rows }
}
