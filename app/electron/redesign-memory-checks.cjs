const assert = require('node:assert/strict')

module.exports = async function checkMemoryCalculation({ evaluate, wait, clickText, screenshot, saved, writeWorkspace, reload, enter, linkageMaterialFingerprint }) {
  const caseId = 'qa-t9-ledger-case'
  const caseTitle = '金额台账回归案件'
  const evidenceId = 'qa-t9-settlement'
  const declarationId = 'qa-t9-unpaid-balance'
  const statement = '被告尚欠货款376,000元。'
  const evidenceText = '货款总额576,000元，累计实付200,000元。'
  const datedEvent = '2026年11月15日被告支付首期货款。'
  const undatedEvent = '次日被告签收结算单。'
  const formula = '货款总额 576000 元 − 累计实付 200000 元 = 欠款 376000.00 元'
  const date = '2026-11-15'
  await saved(async state => {
    const material = { id: evidenceId, caseId, name: '结算凭证', fileName: '结算凭证.txt', number: '证据1', type: 'text',
      ocrText: `${evidenceText}\n${datedEvent}\n${undatedEvent}`, anchorHint: '第1段', uploadedAt: date, contentHash: 'qa-settlement-v1' }
    const source = { tier: 'l1', id: evidenceId, name: material.name, locator: '第1段', quote: evidenceText, version: material.contentHash }
    const inputKey = linkageMaterialFingerprint([material], [])
    const paragraph = { id: 'qa-t9-balance-paragraph', text: statement, verified: false }
    state.cases.push({ id: caseId, name: caseTitle, description: '', createdAt: date, status: 'in_review',
      agent: { position: { party: '测试原告', role: 'plaintiff', goals: ['核实剩余货款'], admissions: [], disputes: [], boundaries: [], confirmedAt: date, version: 1 } } })
    state.evidences.push(material)
    state.certificates.push({ id: 'qa-t9-ledger-document', caseId, title: '货款起诉状', role: 'plaintiff', docKey: 'qs', focus: '',
      createdAt: date, linkageInputKey: inputKey, paragraphIds: [paragraph.id], paragraphs: [paragraph],
      verification: { version: 1, profileVersion: 'qa', revision: 'qa-settlement-v1', inputKey, docKey: 'qs',
        classificationRequired: false, declarations: [{ id: declarationId, type: 'E-CALC', verdict: 'pass', quote: statement, conf: null,
          reason: '凭证金额与复算一致', checks: { A3: { outcome: 'pass', reason: '复算一致' } },
          location: { paragraphId: paragraph.id, paragraphIndex: 0, start: 0, end: statement.length },
          sources: [source], calculation: { kind: 'trade-balance', total: 576000, paid: 200000, amount: 376000, sources: [source] } }] } })
    await writeWorkspace(state)
  })

  const openMemory = async () => {
    await reload()
    await enter(caseTitle)
    await clickText('.topbar button', '案件记忆')
    await wait("document.querySelector('.case-memory-tabs')")
  }
  await openMemory()
  assert.match(await evaluate("document.querySelector('.case-memory-grid[data-state=active]').textContent"), /代理当事人 · 测试原告/)
  await clickText('.case-memory-tabs [role=tab]', '事实时间线')
  await wait(`Array.from(document.querySelectorAll('.case-memory-grid[data-state=active] .case-memory-timeline li')).some(item => item.textContent.includes(${JSON.stringify(datedEvent)}) && item.textContent.includes(${JSON.stringify(date)}))`)
  await wait(`Array.from(document.querySelectorAll('.case-memory-grid[data-state=active] .case-memory-timeline li')).some(item => item.textContent.includes(${JSON.stringify(undatedEvent)}) && item.textContent.includes('日期待核'))`)
  await clickText('.case-memory-grid[data-state=active] button', '结算凭证 · 第 1 段')
  await wait(`document.querySelector('.new-drawer')?.textContent.includes(${JSON.stringify(datedEvent)}) && document.querySelector('.new-drawer .dws')?.textContent.includes('第 1 段')`)
  await clickText('.new-drawer button', 'Close')
  await clickText('.case-memory-tabs [role=tab]', '金额台账')
  await wait(`document.querySelector('.case-memory-grid[data-state=active]')?.textContent.includes(${JSON.stringify(formula)})`)
  await screenshot('t9-amount-ledger')
  await clickText('.case-memory-grid[data-state=active] button', '结算凭证 · 第1段')
  await wait(`document.querySelector('.new-drawer')?.textContent.includes(${JSON.stringify(evidenceText)})`)
  await clickText('.new-drawer button', 'Close')
  await clickText('.case-memory-grid[data-state=active] .case-memory-link', statement + '货款起诉状')
  await wait(`document.querySelector('.rc-q')?.textContent === ${JSON.stringify(statement)}`)
  await wait(`document.querySelector('.whole-document-content [data-el="${declarationId}"].sel')`)

  await saved(async state => {
    state.evidences.find(item => item.id === evidenceId).contentHash = 'qa-settlement-v2'
    await writeWorkspace(state)
  })
  await openMemory()
  await clickText('.case-memory-tabs [role=tab]', '金额台账')
  await wait("document.querySelector('.case-memory-grid[data-state=active]')?.textContent.includes('暂无可回查的复算结果')")
  assert.doesNotMatch(await evaluate("document.querySelector('.case-memory-grid[data-state=active]').textContent"), /376000\.00/)
  await screenshot('t9-amount-ledger-stale')
  console.log('PASS T9 memory ledger formula, L1 source, statement location and stale evidence')
}
