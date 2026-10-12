import { config } from './config.js'
import { isDatabaseEnabled, query } from './infrastructure/postgres.js'
import { readDevStore } from './infrastructure/dev-store.js'

type TrendPoint = {
  date: string
  label: string
  value: number
}

const TREND_DAYS = 30

function getExcludedAdminEmails() {
  return config.ADMIN_EMAILS
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

function isExcludedAdminEmail(email: string | undefined | null, excludedEmails = getExcludedAdminEmails()) {
  return Boolean(email && excludedEmails.includes(email.trim().toLowerCase()))
}

function getTrendDates(days = TREND_DAYS) {
  const dates: Date[] = []
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  for (let index = days - 1; index >= 0; index -= 1) {
    const date = new Date(today)
    date.setDate(today.getDate() - index)
    dates.push(date)
  }
  return dates
}

function toDateKey(date: Date | string) {
  const current = typeof date === 'string' ? new Date(date) : date
  const year = current.getFullYear()
  const month = String(current.getMonth() + 1).padStart(2, '0')
  const day = String(current.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function toDateLabel(date: Date | string) {
  const current = typeof date === 'string' ? new Date(date) : date
  const month = String(current.getMonth() + 1).padStart(2, '0')
  const day = String(current.getDate()).padStart(2, '0')
  return `${month}-${day}`
}

function buildCumulativeTrend(dailyCounts: Map<string, number>, baseline: number, days = TREND_DAYS): TrendPoint[] {
  let runningTotal = baseline
  return getTrendDates(days).map((date) => {
    const key = toDateKey(date)
    runningTotal += dailyCounts.get(key) ?? 0
    return {
      date: key,
      label: toDateLabel(date),
      value: runningTotal,
    }
  })
}

function buildDailyTrend(dailyValues: Map<string, number>, days = TREND_DAYS): TrendPoint[] {
  return getTrendDates(days).map((date) => {
    const key = toDateKey(date)
    return {
      date: key,
      label: toDateLabel(date),
      value: dailyValues.get(key) ?? 0,
    }
  })
}

export async function getAdminDashboard() {
  const excludedEmails = getExcludedAdminEmails()

  if (!isDatabaseEnabled()) {
    const store = await readDevStore()
    const monitoredUsers = store.users.filter((user) => !isExcludedAdminEmail(user.email, excludedEmails))
    const monitoredUserIds = new Set(monitoredUsers.map((user) => user.id))
    const monitoredOrganizationIds = new Set(
      store.memberships
        .filter((membership) => monitoredUserIds.has(membership.userId))
        .map((membership) => membership.organizationId),
    )
    const membershipCreatedAtByUser = new Map<string, string>()

    for (const membership of store.memberships.filter((item) => monitoredUserIds.has(item.userId))) {
      const current = membershipCreatedAtByUser.get(membership.userId)
      if (!current || current > membership.createdAt) {
        membershipCreatedAtByUser.set(membership.userId, membership.createdAt)
      }
    }

    const windowStartKey = toDateKey(getTrendDates(TREND_DAYS)[0])
    const userDailyCounts = new Map<string, number>()
    let userBaseline = 0

    for (const user of monitoredUsers) {
      const createdAt = membershipCreatedAtByUser.get(user.id) ?? new Date().toISOString()
      const key = toDateKey(createdAt)
      if (key < windowStartKey) {
        userBaseline += 1
        continue
      }
      userDailyCounts.set(key, (userDailyCounts.get(key) ?? 0) + 1)
    }

    const pointsDailyValues = new Map<string, number>()
    for (const entry of store.pointLedgerEntries) {
      if (entry.entryType !== 'consume') {
        continue
      }
      if (isExcludedAdminEmail(store.users.find((user) => user.id === entry.userId)?.email, excludedEmails)) {
        continue
      }
      const key = toDateKey(entry.createdAt)
      if (key < windowStartKey) {
        continue
      }
      pointsDailyValues.set(key, (pointsDailyValues.get(key) ?? 0) + Math.abs(entry.changePoints))
    }

    return {
      totalUsers: monitoredUsers.length,
      totalOrganizations: monitoredOrganizationIds.size,
      totalPointsConsumed: Math.abs(
        store.pointLedgerEntries
          .filter((entry) =>
            entry.entryType === 'consume'
            && !isExcludedAdminEmail(store.users.find((user) => user.id === entry.userId)?.email, excludedEmails),
          )
          .reduce((sum, e) => sum + e.changePoints, 0)
      ),
      userGrowthTrend: buildCumulativeTrend(userDailyCounts, userBaseline),
      tokenConsumptionTrend: buildDailyTrend(pointsDailyValues),
    }
  }

  const windowStartKey = toDateKey(getTrendDates(TREND_DAYS)[0])
  const usersCountResult = await query<{ count: string }>(
    'SELECT COUNT(*) as count FROM users WHERE LOWER(email) <> ALL($1::text[])',
    [excludedEmails],
  )
  const orgsCountResult = await query<{ count: string }>(`
    SELECT COUNT(DISTINCT m.organization_id) as count
    FROM organization_memberships m
    JOIN users u ON u.id = m.user_id
    WHERE m.status = 'active' AND LOWER(u.email) <> ALL($1::text[])
  `, [excludedEmails])
  const pointsConsumedResult = await query<{ sum: string }>(`
    SELECT SUM(change_points) as sum
    FROM point_ledger_entries
    WHERE entry_type = 'consume'
      AND LOWER(COALESCE(workspace_user_email, '')) <> ALL($1::text[])
  `, [excludedEmails])
  const userBaselineResult = await query<{ count: string }>(
    'SELECT COUNT(*) as count FROM users WHERE created_at::date < $1::date AND LOWER(email) <> ALL($2::text[])',
    [windowStartKey, excludedEmails],
  )
  const userTrendResult = await query<{ day: string; count: string }>(`
    SELECT created_at::date::text AS day, COUNT(*)::text AS count
    FROM users
    WHERE created_at::date >= $1::date
      AND LOWER(email) <> ALL($2::text[])
    GROUP BY created_at::date
    ORDER BY created_at::date ASC
  `, [windowStartKey, excludedEmails])
  const pointsTrendResult = await query<{ day: string; value: string }>(`
    SELECT created_at::date::text AS day, COALESCE(SUM(ABS(change_points)), 0)::text AS value
    FROM point_ledger_entries
    WHERE entry_type = 'consume'
      AND created_at::date >= $1::date
      AND LOWER(COALESCE(workspace_user_email, '')) <> ALL($2::text[])
    GROUP BY created_at::date
    ORDER BY created_at::date ASC
  `, [windowStartKey, excludedEmails])

  const userDailyCounts = new Map(
    userTrendResult.rows.map((row) => [row.day, parseInt(row.count, 10)])
  )
  const pointsDailyValues = new Map(
    pointsTrendResult.rows.map((row) => [row.day, parseInt(row.value, 10)])
  )

  return {
    totalUsers: parseInt(usersCountResult.rows[0].count, 10),
    totalOrganizations: parseInt(orgsCountResult.rows[0].count, 10),
    totalPointsConsumed: Math.abs(parseInt(pointsConsumedResult.rows[0].sum || '0', 10)),
    userGrowthTrend: buildCumulativeTrend(userDailyCounts, parseInt(userBaselineResult.rows[0].count, 10)),
    tokenConsumptionTrend: buildDailyTrend(pointsDailyValues),
  }
}

export async function getAdminUsers() {
  const excludedEmails = getExcludedAdminEmails()

  if (!isDatabaseEnabled()) {
    const store = await readDevStore()
    return {
      users: store.users.filter((user) => !isExcludedAdminEmail(user.email, excludedEmails)).map(u => ({
        id: u.id,
        email: u.email,
        name: u.name,
        createdAt: new Date().toISOString(),
        pointsBalance: store.pointAccounts.find(pa => pa.userId === u.id)?.balancePoints || 0,
      }))
    }
  }

  const usersResult = await query<{
    id: string
    email: string
    name: string
    created_at: string
    balance_points: number
  }>(`
    SELECT u.id, u.email, u.name, u.created_at, COALESCE(pa.balance_points, 0) as balance_points
    FROM users u
    LEFT JOIN point_accounts pa ON u.id = pa.user_id
    WHERE LOWER(u.email) <> ALL($1::text[])
    ORDER BY u.created_at DESC
  `, [excludedEmails])

  return {
    users: usersResult.rows.map(row => ({
      id: row.id,
      email: row.email,
      name: row.name,
      createdAt: row.created_at,
      pointsBalance: row.balance_points,
    }))
  }
}

export async function getAdminUsage() {
  const excludedEmails = getExcludedAdminEmails()

  if (!isDatabaseEnabled()) {
    const store = await readDevStore()
    const usageByUser = new Map<string, {
      name: string
      email: string
      totalConsumed: number
      actionCount: number
      lastConsumedAt: string
    }>()

    const logs = store.pointLedgerEntries
      .filter((entry) =>
        entry.entryType === 'consume'
        && !isExcludedAdminEmail(store.users.find((user) => user.id === entry.userId)?.email, excludedEmails),
      )
      .slice(0, 100)
      .map(e => {
        const user = store.users.find(u => u.id === e.userId)
        const email = user?.email || '-'
        const name = user?.name || email
        const consumed = Math.abs(e.changePoints)
        const current = usageByUser.get(email)
        if (!current) {
          usageByUser.set(email, {
            name,
            email,
            totalConsumed: consumed,
            actionCount: 1,
            lastConsumedAt: e.createdAt,
          })
        } else {
          current.totalConsumed += consumed
          current.actionCount += 1
          if (current.lastConsumedAt < e.createdAt) {
            current.lastConsumedAt = e.createdAt
          }
        }

        return {
          id: e.id,
          name,
          email,
          actionType: e.actionType || '-',
          changePoints: e.changePoints,
          note: e.note,
          createdAt: e.createdAt,
        }
      })

    return {
      users: Array.from(usageByUser.values()).sort((left, right) => {
        if (right.totalConsumed !== left.totalConsumed) {
          return right.totalConsumed - left.totalConsumed
        }
        return right.actionCount - left.actionCount
      }),
      logs,
    }
  }

  const userStatsResult = await query<{
    name: string | null
    email: string
    total_consumed: string
    action_count: string
    last_consumed_at: string
  }>(`
    SELECT
      COALESCE(u.name, COALESCE(ple.workspace_user_email, '-')) AS name,
      COALESCE(ple.workspace_user_email, '-') AS email,
      COALESCE(SUM(ABS(change_points)), 0)::text AS total_consumed,
      COUNT(*)::text AS action_count,
      MAX(ple.created_at)::text AS last_consumed_at
    FROM point_ledger_entries ple
    LEFT JOIN users u ON LOWER(u.email) = LOWER(ple.workspace_user_email)
    WHERE ple.entry_type = 'consume'
      AND LOWER(COALESCE(ple.workspace_user_email, '')) <> ALL($1::text[])
    GROUP BY COALESCE(ple.workspace_user_email, '-'), COALESCE(u.name, COALESCE(ple.workspace_user_email, '-'))
    ORDER BY SUM(ABS(change_points)) DESC, COUNT(*) DESC, MAX(ple.created_at) DESC
  `, [excludedEmails])

  const logsResult = await query<{
    id: string
    name: string | null
    workspace_user_email: string
    action_type: string
    change_points: number
    note: string
    created_at: string
  }>(`
    SELECT
      ple.id,
      u.name,
      ple.workspace_user_email,
      ple.action_type,
      ple.change_points,
      ple.note,
      ple.created_at
    FROM point_ledger_entries ple
    LEFT JOIN users u ON LOWER(u.email) = LOWER(ple.workspace_user_email)
    WHERE ple.entry_type = 'consume'
      AND LOWER(COALESCE(ple.workspace_user_email, '')) <> ALL($1::text[])
    ORDER BY ple.created_at DESC
    LIMIT 100
  `, [excludedEmails])

  return {
    users: userStatsResult.rows.map(row => ({
      name: row.name || row.email,
      email: row.email,
      totalConsumed: parseInt(row.total_consumed, 10),
      actionCount: parseInt(row.action_count, 10),
      lastConsumedAt: row.last_consumed_at,
    })),
    logs: logsResult.rows.map(row => ({
      id: row.id,
      name: row.name || row.workspace_user_email,
      email: row.workspace_user_email,
      actionType: row.action_type,
      changePoints: row.change_points,
      note: row.note,
      createdAt: row.created_at,
    }))
  }
}
