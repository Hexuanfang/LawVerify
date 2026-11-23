import { z } from 'zod'

import { AppError } from './core/app-error.js'
import { getPool, query } from './infrastructure/postgres.js'

function formField(label: string, max: number) {
  return z.string().trim().min(1, `请填写${label}。`).max(max, `${label}最多 ${max} 个字符。`)
    .refine(value => !value.includes('\0'), `${label}含无效字符。`)
}

export const cocreateApplicationSchema = z.strictObject({
  id: z.uuidv4(),
  name: formField('姓名', 80),
  email: z.string('请填写邮箱。').trim().min(1, '请填写邮箱。').max(254, '邮箱最多 254 个字符。')
    .toLowerCase().pipe(z.email('请输入正确的邮箱地址。')),
  phone: z.string('请填写手机号。').trim().min(1, '请填写手机号。').max(32, '手机号最多 32 个字符。')
    .transform(value => value.replace(/[\s()-]/g, '').replace(/^(?:\+?86|0086)/, ''))
    .pipe(z.string().regex(/^1[3-9][0-9]{9}$/, '请输入有效的中国大陆手机号。')),
  workYears: z.enum(['under_3', '3_to_4', '5_to_9', '10_plus'], '请选择有效的工作年限。'),
  region: formField('所在地区', 120),
  lawFirm: formField('所在律所', 160),
  practiceAreas: formField('擅长领域', 300),
  resume: formField('简要履历', 2000),
  expectations: formField('共创期望', 2000),
})

export const cocreateSearchSchema = z.strictObject({
  query: z.string().trim().max(254).refine(value => !value.includes('\0')).default(''),
  status: z.enum(['all', 'pending', 'approved']).default('all'),
  page: z.number().int().positive().max(100_000).default(1),
})

type Application = z.infer<typeof cocreateApplicationSchema>
type SearchFilters = z.infer<typeof cocreateSearchSchema>
type ReviewStatus = Exclude<SearchFilters['status'], 'all'>
type ReviewItem = Omit<Application, 'email' | 'phone'> & {
  email: string | null
  phone: string | null
  contact: string | null
  status: ReviewStatus
  registered: boolean
  pointsGranted: string
  canGrantPoints: boolean
  pointsGrantBlockedReason: string | null
  pointsRecipient: { userId: string; account: string } | null
  productAccount: string | null
  submittedAt: Date
}

const cocreateRewardPoints = 50_000

const recipientJoins = `
  CROSS JOIN LATERAL (
    SELECT COALESCE(app.email, CASE WHEN position('@' IN app.contact) > 0 THEN lower(btrim(app.contact)) END) AS email,
      COALESCE(app.phone, regexp_replace(regexp_replace(app.contact, '[[:space:]()-]', '', 'g'), '^([+]?86|0086)', '')) AS phone
  ) contacts
  CROSS JOIN LATERAL (
    SELECT count(*) AS matches, (array_agg(u.id))[1] AS user_id
    FROM users u
    WHERE u.email = contacts.email OR (
      contacts.phone ~ '^1[3-9][0-9]{9}$' AND (u.email = contacts.phone OR
        regexp_replace(regexp_replace(u.phone, '[[:space:]()-]', '', 'g'), '^([+]?86|0086)', '') = contacts.phone)
    )
  ) matched
  LEFT JOIN LATERAL (
    SELECT m.user_id, m.organization_id, u.email AS account
    FROM organization_memberships m
    JOIN users u ON u.id = m.user_id AND u.status = 'active'
    JOIN organizations o ON o.id = m.organization_id
    WHERE matched.matches = 1 AND m.user_id = matched.user_id AND m.status = 'active'
    ORDER BY m.created_at ASC, m.id ASC
    LIMIT 1
  ) recipient ON true
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN app.status <> 'approved' THEN '审核通过后可发放积分。'
      WHEN matched.matches = 0 THEN '申请人尚未注册。'
      WHEN matched.matches > 1 THEN '报名联系方式匹配到多个账号，请核实后再发放。'
      WHEN recipient.user_id IS NULL THEN '未找到可用的积分账户。'
    END AS blocked_reason
  ) eligibility
`

export async function submitCocreateApplication(application: Application, userId: string | null) {
  const { id, name, email, phone, workYears, region, lawFirm, practiceAreas, resume, expectations } = application
  const fields = [id, name, email, phone, workYears, region, lawFirm, practiceAreas, resume, expectations]
  const inserted = await query(`
    INSERT INTO cocreate_applications (
      id, name, email, phone, work_years, region, law_firm, practice_areas, resume, expectations, applicant_user_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT DO NOTHING
  `, [...fields, userId])

  if (inserted.rowCount) return { id }

  const { rows: [conflict] } = await query<{ sameApplication: boolean; emailUsed: boolean; phoneUsed: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM cocreate_applications
      WHERE id = $1 AND name = $2 AND email = $3 AND phone = $4 AND work_years = $5 AND region = $6
        AND law_firm = $7 AND practice_areas = $8 AND resume = $9 AND expectations = $10
    ) AS "sameApplication",
    EXISTS (SELECT 1 FROM cocreate_applications WHERE email = $3 AND id <> $1) AS "emailUsed",
    EXISTS (SELECT 1 FROM cocreate_applications WHERE phone = $4 AND id <> $1) AS "phoneUsed"
  `, fields)

  if (conflict.sameApplication) return { id }
  if (conflict.emailUsed && conflict.phoneUsed) {
    throw new AppError('邮箱和手机号已经使用。', 409, 'COCREATE_CONTACTS_IN_USE')
  }
  if (conflict.emailUsed) throw new AppError('邮箱已经使用。', 409, 'COCREATE_EMAIL_IN_USE')
  if (conflict.phoneUsed) throw new AppError('手机号已经使用。', 409, 'COCREATE_PHONE_IN_USE')
  throw new AppError('报名资料有变动，请重新提交。', 409, 'COCREATE_SUBMISSION_CONFLICT')
}

export async function searchCocreateApplications(filters: SearchFilters) {
  const pageSize = 25
  // 搜索按字面匹配，联系方式中的百分号或下划线也作为普通字符。
  const matchesSearch = `($1 = '' OR strpos(lower(app.name), lower($1)) > 0
    OR strpos(app.email, lower($1)) > 0 OR strpos(app.phone, $1) > 0 OR strpos(lower(app.contact), lower($1)) > 0
    OR strpos(lower(app.region), lower($1)) > 0
    OR strpos(lower(app.law_firm), lower($1)) > 0)`
  const totals = await query<Record<SearchFilters['status'], number>>(`
    SELECT COUNT(*)::int AS "all", (COUNT(*) FILTER (WHERE status = 'pending'))::int AS pending,
      (COUNT(*) FILTER (WHERE status = 'approved'))::int AS approved
    FROM cocreate_applications app WHERE ${matchesSearch}
  `, [filters.query])
  const counts = totals.rows[0]
  const page = Math.min(filters.page, Math.max(1, Math.ceil(counts[filters.status] / pageSize)))
  const result = await query<ReviewItem>(`
    SELECT app.id, app.name, app.email, app.phone, app.contact, app.work_years AS "workYears", app.region, app.law_firm AS "lawFirm",
      app.practice_areas AS "practiceAreas", app.resume, app.expectations, app.status, app.submitted_at AS "submittedAt",
      account.email AS "productAccount", matched.matches > 0 AS registered, app.points_granted::text AS "pointsGranted",
      eligibility.blocked_reason IS NULL AS "canGrantPoints", eligibility.blocked_reason AS "pointsGrantBlockedReason",
      CASE WHEN recipient.user_id IS NOT NULL THEN jsonb_build_object('userId', recipient.user_id, 'account', recipient.account) END
        AS "pointsRecipient"
    FROM cocreate_applications app
    LEFT JOIN users account ON account.id = app.applicant_user_id
    ${recipientJoins}
    WHERE ${matchesSearch} AND ($2 = 'all' OR app.status = $2)
    ORDER BY app.submitted_at DESC, app.id DESC
    LIMIT $3 OFFSET $4
  `, [filters.query, filters.status, pageSize, (page - 1) * pageSize])

  return { counts, items: result.rows, page, pageSize }
}

export async function approveCocreateApplication(id: string, reviewerUserId: string) {
  const updated = await query(`
    UPDATE cocreate_applications SET status = 'approved', reviewed_at = NOW(), reviewed_by_user_id = $2
    WHERE id = $1 AND status = 'pending'
  `, [id, reviewerUserId])

  if (!updated.rowCount) {
    const existing = await query('SELECT id FROM cocreate_applications WHERE id = $1', [id])
    if (!existing.rowCount) throw new AppError('找不到这条共创报名。', 404, 'COCREATE_APPLICATION_NOT_FOUND')
  }

  return { id, status: 'approved' as const }
}

export async function grantCocreatePoints(id: string, idempotencyKey: string, recipientUserId: string, adminUserId: string) {
  const operationKey = `cocreate-reward:${id.toLowerCase()}:${idempotencyKey.toLowerCase()}`
  const expectedRecipient = recipientUserId.toLowerCase()
  const recipientChanged = () => new AppError('积分接收账号已变化，请刷新后核实。', 409, 'COCREATE_POINTS_RECIPIENT_CHANGED')
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const { rows: [application] } = await client.query<{ pointsGranted: string }>(`
      SELECT points_granted::text AS "pointsGranted" FROM cocreate_applications WHERE id = $1 FOR UPDATE
    `, [id])
    if (!application) throw new AppError('找不到这条共创报名。', 404, 'COCREATE_APPLICATION_NOT_FOUND')

    const { rows: [previousGrant] } = await client.query<{ pointsBalance: number; userId: string | null }>(`
      SELECT COALESCE(a.balance_points, 0) AS "pointsBalance", l.commercial_user_id AS "userId" FROM point_ledger_entries l
      LEFT JOIN point_accounts a ON a.organization_id = l.organization_id AND a.user_id = l.commercial_user_id
      WHERE l.operation_key = $1
    `, [operationKey])
    if (previousGrant && previousGrant.userId !== expectedRecipient) throw recipientChanged()
    let pointsBalance = previousGrant?.pointsBalance
    let pointsGranted = application.pointsGranted

    if (pointsBalance === undefined) {
      const { rows: [recipient] } = await client.query<{ user_id: string; organization_id: string; blocked_reason: string | null }>(`
        SELECT recipient.user_id, recipient.organization_id, eligibility.blocked_reason
        FROM cocreate_applications app ${recipientJoins} WHERE app.id = $1
      `, [id])
      if (recipient.blocked_reason) throw new AppError(recipient.blocked_reason, 409, 'COCREATE_POINTS_NOT_ELIGIBLE')
      if (recipient.user_id !== expectedRecipient) throw recipientChanged()

      const { rows: [account] } = await client.query<{ balance_points: number }>(`
        INSERT INTO point_accounts (organization_id, user_id, balance_points) VALUES ($1, $2, $3)
        ON CONFLICT (organization_id, user_id) DO UPDATE
          SET balance_points = point_accounts.balance_points + EXCLUDED.balance_points, updated_at = NOW()
        RETURNING balance_points
      `, [recipient.organization_id, recipient.user_id, cocreateRewardPoints])
      await client.query(`
        INSERT INTO point_ledger_entries (
          organization_id, commercial_user_id, workspace_user_id, entry_type, operation_key, change_points, note, metadata
        ) VALUES ($1, $2::uuid, $2::text, 'adjust', $3, $4, '共创律师积分赠送', $5::jsonb)
      `, [recipient.organization_id, recipient.user_id, operationKey, cocreateRewardPoints, JSON.stringify({
        source: 'cocreate_reward', applicationId: id, grantedByUserId: adminUserId,
      })])
      const { rows: [updated] } = await client.query<{ pointsGranted: string }>(`
        UPDATE cocreate_applications SET points_granted = points_granted + $2 WHERE id = $1
        RETURNING points_granted::text AS "pointsGranted"
      `, [id, cocreateRewardPoints])
      pointsGranted = updated.pointsGranted
      pointsBalance = account.balance_points
    }

    await client.query('COMMIT')
    return { pointsGranted, pointsBalance, message: `积分已发放，当前积分：${pointsBalance}` }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
