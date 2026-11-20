import { normalizeDocKey, profile } from '../../src/intelligence/verification/profile.ts'

const ratio = (numerator, denominator) => ({ numerator, denominator, value: denominator ? numerator / denominator : null })
const compact = text => text.replace(/\s/gu, '')
const hasRange = target => Number.isInteger(target.start) && Number.isInteger(target.end) && target.start >= 0 && target.end > target.start
const locationFields = ['paragraphIndex', 'start', 'end', 'row', 'column']

function editDistance(left, right, limit) {
  if (Math.abs(left.length - right.length) > limit) return Infinity
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let row = 1; row <= left.length; row++) {
    const next = Array(right.length + 1).fill(Infinity)
    next[0] = row
    for (let column = Math.max(1, row - limit); column <= Math.min(right.length, row + limit); column++) {
      next[column] = Math.min(next[column - 1] + 1, previous[column] + 1, previous[column - 1] + Number(left[row - 1] !== right[column - 1]))
    }
    previous = next
  }
  return previous[right.length]
}

function matchText(label, prediction) {
  if (label.quote === prediction.quote) return 0
  if (Number.isInteger(label.location.paragraphIndex) && label.location.paragraphIndex !== prediction.location.paragraphIndex) return Infinity
  const expected = compact(label.quote), actual = compact(prediction.quote)
  if (!expected || !actual) return Infinity
  if (expected.includes(actual) || actual.includes(expected)) return 1
  const limit = Math.floor(Math.max(expected.length, actual.length) * 0.2)
  return editDistance(expected, actual, limit) <= limit ? 2 : Infinity
}

function expectedLocation(label, document) {
  const target = Object.fromEntries(locationFields.flatMap(key => {
    const value = label.location?.[key] ?? label[key]
    return Number.isInteger(value) ? [[key, value]] : []
  }))
  const paragraph = document?.paragraphs?.[target.paragraphIndex]
  if (!hasRange(target) && typeof paragraph === 'string') {
    const start = paragraph.indexOf(label.quote)
    if (start >= 0 && paragraph.indexOf(label.quote, start + 1) < 0) {
      target.start = start
      target.end = start + label.quote.length
    }
  }
  return target
}

function locationMatches(target, actual) {
  return Object.entries(target).every(([key, value]) => actual[key] === value)
}

const positionDifference = (expected, actual, key) => expected[key] === undefined ? 0
  : Math.abs(expected[key] - (actual[key] ?? -1))
const anchored = location => hasRange(location) || (Number.isInteger(location.row) && Number.isInteger(location.column))
const describe = ({ id, documentId, type, location, quote, verdict }) => ({ id, documentId, type, location, quote, verdict })

export function gradeSeedPairing(expected, predicted, { documents = [], offCandidates = [] } = {}) {
  const byDocument = new Map(documents.map(document => [document.id, document]))
  const placeholderIds = new Set(expected.filter(item => item.purpose === 'pending-placeholder').map(item => item.documentId))
  for (const item of expected) if (item.purpose === 'declaration' && item.quote?.trim()) placeholderIds.delete(item.documentId)
  const inScope = item => !placeholderIds.has(item.documentId)
  const rules = new Map(documents.filter(document => !placeholderIds.has(document.id))
    .map(document => [document.id, profile.profiles[normalizeDocKey(document.docKey)]?.elements]))
  const levelOf = item => rules.get(item.documentId)?.[item.type]?.level
  const labels = expected.filter(item => item.purpose === 'declaration' && item.quote?.trim() && levelOf(item) !== 'off')
    .map(item => ({ ...item, location: expectedLocation(item, byDocument.get(item.documentId)) }))
  const scopedPredictions = predicted.filter(inScope)
  const scopedOff = offCandidates.filter(inScope)
  const offPredictions = [...scopedPredictions.filter(item => levelOf(item) === 'off'), ...scopedOff]
  const seen = new Set()
  const duplicatePredictions = []
  const active = scopedPredictions.filter(item => {
    if (levelOf(item) === 'off') return false
    const location = item.location ?? {}
    const key = JSON.stringify([item.documentId, item.type, ...locationFields.map(field => location[field]), hasRange(location) ? null : item.quote])
    if (!seen.has(key)) { seen.add(key); return true }
    duplicatePredictions.push(describe(item))
    return false
  })
  const pendingPlaceholders = expected.filter(item => item.purpose === 'pending-placeholder').map(item => {
    const expectedItem = { ...item, location: expectedLocation(item, byDocument.get(item.documentId)) }
    const hits = predicted.filter(found => found.documentId === item.documentId && found.type === item.type && found.location
      && Number.isFinite(matchText(expectedItem, found)))
    const status = hits.some(found => found.verdict !== 'pending') || !hits.length ? 'fail' : 'pass'
    return { id: item.id, status, actualVerdict: hits.find(found => found.verdict !== 'pending')?.verdict ?? hits[0]?.verdict ?? null }
  })
  const countByQuote = new Map()
  const countByAnchor = new Map()
  const quoteKey = item => JSON.stringify([item.documentId, compact(item.quote)])
  const anchorKey = item => JSON.stringify([quoteKey(item), item.location.paragraphIndex, item.location.start])
  for (const label of labels) {
    const quote = quoteKey(label)
    const anchor = anchorKey(label)
    countByQuote.set(quote, (countByQuote.get(quote) ?? 0) + 1)
    countByAnchor.set(anchor, (countByAnchor.get(anchor) ?? 0) + 1)
  }
  const edges = labels.flatMap((label, expectedIndex) => active.flatMap((prediction, actualIndex) => {
    if (prediction.documentId !== label.documentId || !prediction.quote?.trim() || !prediction.location) return []
    const distance = matchText(label, prediction)
    if (!Number.isFinite(distance)) return []
    if (distance === 0 && countByQuote.get(quoteKey(label)) > 1
      && (positionDifference(label.location, prediction.location, 'paragraphIndex') || positionDifference(label.location, prediction.location, 'start'))) return []
    if (countByAnchor.get(anchorKey(label)) > 1
      && (positionDifference(label.location, prediction.location, 'row') || positionDifference(label.location, prediction.location, 'column'))) return []
    const order = [distance, positionDifference(label.location, prediction.location, 'paragraphIndex'),
      Number(!locationMatches(label.location, prediction.location)), Number(distance !== 0 && label.type !== prediction.type),
      positionDifference(label.location, prediction.location, 'start'),
      positionDifference(label.location, prediction.location, 'row'), positionDifference(label.location, prediction.location, 'column'),
      Number(label.type !== prediction.type), Math.abs(label.quote.length - prediction.quote.length), expectedIndex, actualIndex]
    return [{ expectedIndex, actualIndex, order }]
  }))
  edges.sort((left, right) => {
    for (const [index, priority] of left.order.entries()) {
      if (priority !== right.order[index]) return priority - right.order[index]
    }
    return 0
  })
  const pairs = new Map()
  const used = new Set()
  for (const { expectedIndex, actualIndex } of edges) {
    if (pairs.has(expectedIndex) || used.has(actualIndex)) continue
    pairs.set(expectedIndex, actualIndex)
    used.add(actualIndex)
  }
  const paired = [...pairs].map(([labelIndex, predictedIndex]) => [labels[labelIndex], active[predictedIndex]])
  const correct = paired.filter(([label, found]) => label.type === found.type)
  const locatedPairs = paired.filter(([label]) => anchored(label.location))
  const required = labels.filter(label => levelOf(label) === 'required')
  const requiredHits = new Set(correct.filter(([label]) => levelOf(label) === 'required').map(([label]) => label))
  const typed = new Set(correct.map(([label]) => label))
  const unsplit = correct.filter(([label, found]) => hasRange(label.location) && hasRange(found.location)
    && found.location.paragraphIndex === label.location.paragraphIndex && found.location.start <= label.location.start && found.location.end >= label.location.end
    && labels.some(other => !typed.has(other) && other.documentId === label.documentId && other.type !== label.type && hasRange(other.location)
      && other.location.paragraphIndex === label.location.paragraphIndex
      && (other.location.end <= label.location.start || other.location.start >= label.location.end)
      && found.location.start <= other.location.start && found.location.end >= other.location.end)).map(([, found]) => found)
  const offOpportunities = [...rules.values()].reduce((total, elements) => total + Object.values(elements ?? {}).filter(rule => rule.level === 'off').length, 0)
  const offHits = new Set(offPredictions.filter(item => levelOf(item) === 'off').map(item => JSON.stringify([item.documentId, item.type])))
  const precisionDenominator = scopedPredictions.length + scopedOff.length + unsplit.length
  return {
    expected: labels.length, predicted: scopedPredictions.length + scopedOff.length, paired: pairs.size, pendingPlaceholders,
    extractionCounts: { tp: correct.length, fp: precisionDenominator - correct.length, fn: labels.length - correct.length },
    unscoredLabels: expected.filter(item => item.purpose !== 'declaration' || !item.quote?.trim() || levelOf(item) === 'off')
      .map(item => ({ id: item.id, purpose: levelOf(item) === 'off' ? 'profile-off' : !item.quote?.trim() && item.purpose === 'declaration' ? 'not-applicable' : item.purpose })),
    recall: ratio(correct.length, labels.length), requiredRecall: ratio(requiredHits.size, required.length),
    precision: ratio(correct.length, precisionDenominator),
    typeAccuracy: ratio(correct.length, pairs.size),
    locationAccuracy: ratio(locatedPairs.filter(([label, found]) => locationMatches(label.location, found.location)).length, locatedPairs.length),
    verdictAccuracy: ratio(paired.filter(([label, found]) => label.verdict !== undefined && label.verdict === found.verdict).length,
      paired.filter(([label]) => label.verdict !== undefined).length),
    offFalsePositiveRate: ratio(offHits.size, offOpportunities),
    matchedDeclarations: correct.map(([label, found]) => ({ labelId: label.id, ...describe(found), extractFlag: 'ok' })),
    requiredMisses: required.filter(label => !requiredHits.has(label)).map(label => ({ ...describe(label), extractFlag: 'required_fn' })),
    offFalsePositives: offPredictions.map(item => ({ ...describe(item), extractFlag: 'off_fp' })),
    duplicatePredictions,
    unsplitPredictions: unsplit.map(describe),
    unanchoredLabels: labels.filter(label => !anchored(label.location)).map(label => label.id),
    failures: labels.flatMap((label, index) => {
      const found = active[pairs.get(index)]
      if (found && label.type === found.type && anchored(label.location) && locationMatches(label.location, found.location) && label.verdict === found.verdict) return []
      return [{ id: label.id, documentId: label.documentId, expectedType: label.type, expectedQuote: label.quote, expectedVerdict: label.verdict, expectedLocation: label.location,
        actualType: found?.type ?? null, actualQuote: found?.quote ?? null, actualVerdict: found?.verdict ?? null, actualLocation: found?.location ?? null }]
    }),
    unmatchedPredictions: active.filter((_item, index) => !used.has(index)).map(describe),
  }
}
