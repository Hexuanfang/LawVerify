import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildStatuteReference,
  describeStatuteVersionStatus,
  isPlaceholderStatuteContent,
  pickPreferredStatuteBinding,
} from '../src/intelligence/statute-version.ts'

const document = (overrides = {}) => ({
  id: 'law',
  title: '中华人民共和国民法典',
  docType: '法律',
  issuer: '全国人民代表大会',
  effectiveStatus: 'effective',
  effectiveDate: '2021-01-01T00:00:00.000Z',
  publishDate: '2020-05-28T00:00:00.000Z',
  version: '现行有效',
  keywords: [],
  articles: [],
  ...overrides,
})

const article = (overrides = {}) => ({
  id: 'article',
  documentId: 'law',
  articleNumber: '第五百零九条',
  content: '当事人应当按照约定全面履行自己的义务。',
  plainText: '当事人应当按照约定全面履行自己的义务。',
  aliases: [],
  topicTags: [],
  ...overrides,
})

test('废止版本不能当作现行依据，引用上带明确警示', () => {
  const status = describeStatuteVersionStatus({
    effectiveStatus: 'repealed',
    effectiveDate: '1999-10-01T00:00:00.000Z',
    revisionDate: '2020-01-01T00:00:00.000Z',
  })
  assert.equal(status.warning, 'statute-repealed')
  assert.match(status.reason ?? '', /已废止/)
  assert.match(status.reason ?? '', /2020年1月1日/)

  const reference = buildStatuteReference(
    document({ effectiveStatus: 'repealed' }),
    article(),
  )
  assert.equal(reference.warning, 'statute-repealed')
  assert.equal(reference.quote, '当事人应当按照约定全面履行自己的义务。')
  assert.match(reference.reason ?? '', /不能作为现行依据/)
})

test('已修订版本正常引用但标注适用时点待核对', () => {
  const status = describeStatuteVersionStatus({
    effectiveStatus: 'amended',
    effectiveDate: '2021-01-01T00:00:00.000Z',
    revisionDate: '2023-06-01T00:00:00.000Z',
  })
  assert.equal(status.warning, 'statute-amended')
  assert.match(status.reason ?? '', /适用时点需人工核对/)

  const reference = buildStatuteReference(document({ effectiveStatus: 'amended' }), article())
  assert.equal(reference.warning, 'statute-amended')
  assert.ok(reference.quote)
})

test('现行有效版本不产生警示', () => {
  const status = describeStatuteVersionStatus({ effectiveStatus: 'effective' })
  assert.equal(status.warning, undefined)
  assert.equal(status.reason, undefined)

  const reference = buildStatuteReference(document(), article())
  assert.equal(reference.warning, undefined)
  assert.equal(reference.reason, undefined)
  assert.equal(reference.note, 'system:auto-statute-detected')
})

test('官方接口的占位说明不作为引文，正文待补要警示', () => {
  const placeholder = '第五百零九条 官方原文已定位，请点击“官方原文”查看完整条文。当前官方接口未直接返回结构化正文，已先完成法条绑定。'
  assert.equal(isPlaceholderStatuteContent(placeholder), true)
  assert.equal(isPlaceholderStatuteContent(undefined), true)
  assert.equal(isPlaceholderStatuteContent('真实条文正文'), false)

  const reference = buildStatuteReference(document(), article({ content: placeholder }))
  assert.equal(reference.warning, 'statute-content-missing')
  assert.equal(reference.quote, '')
  assert.match(reference.reason ?? '', /条文正文待补/)
})

test('同一部法律多个版本时现行有效优先，已废止最后', () => {
  const binding = (id, effectiveStatus, content) => ({
    id,
    document: { effectiveStatus },
    article: { content },
  })
  const picked = pickPreferredStatuteBinding([
    binding('repealed', 'repealed', '已废止正文'),
    binding('amended', 'amended', '修订正文'),
    binding('effective', 'effective', '现行正文'),
  ])
  assert.equal(picked?.id, 'effective')

  const onlyOld = pickPreferredStatuteBinding([
    binding('repealed', 'repealed', '已废止正文'),
    binding('amended', 'amended', '修订正文'),
  ])
  assert.equal(onlyOld?.id, 'amended')

  const placeholderWins = pickPreferredStatuteBinding([
    binding('placeholder', 'effective', '官方原文已定位'),
    binding('real', 'effective', '真实正文'),
  ])
  assert.equal(placeholderWins?.id, 'real')

  assert.equal(pickPreferredStatuteBinding([]), null)
})
