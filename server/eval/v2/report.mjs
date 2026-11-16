const pct = value => value === null || value === undefined ? '未测 / N/A' : `${(value * 100).toFixed(1)}%`

export function renderReport(report) {
  const lines = ['# LawVerify 严格 benchmark v2', '',
    `- 时间：${report.generatedAt}`, `- 模式：${report.mode}；整体结论：**${report.status}**`,
    `- 案件：${report.counts.cases}；主张：${report.counts.claims}；真实附件：${report.counts.files}`,
    '- 数据全部为合成附件/模板化案件；无真实案件或独立法律专家标注，不代表真实业务准确率。',
    '- 标准答案与输入隔离；离线不调用模型。流程探针是人工构造攻击输入，不能当作真实模型准确率。',
    '- 文件集覆盖中文图片、扫描 PDF、同页混合、交替混合、多页扫描、表格、聊天、旋转、低对比度、模糊及损坏文件。',
    '- 集成范围：真实上传落盘、生产原件提取/渲染、生产分片/挂接、生产 chunk 检索；不覆盖 HTTP 路由、账户及完整生产模型编排。live视觉使用独立 benchmark 转录适配器，不能证明生产 OCR 编排完整。',
    `- service.ts SHA256：\`${report.sourceHashes.service}\``,
    `- 数据指纹：\`${report.sourceHashes.dataset}\`；文件清单指纹：\`${report.sourceHashes.manifest}\``, '',
    '## 文件解析：生产原件提取', '',
    '| 文件 | 类型 | 关键字段（含页码） | 字符错误率 CER | 已渲染/总页数 | 结果 |',
    '| --- | --- | --- | --- | --- | --- |']
  for (const doc of report.files) lines.push(`| ${doc.id} | ${doc.kind} | ${doc.extraction ? `${doc.extraction.matched}/${doc.extraction.fields} (${pct(doc.extraction.fieldAccuracy)})` : '-'} | ${pct(doc.extraction?.characterErrorRate)} | ${doc.renderedPages ?? 0}/${doc.totalPages ?? '-'} | ${doc.status} |`)
  lines.push('', '本地 Python workers 解析 PDF 与图片，页码采用解析 blocks 的实际页码。缺失字段、重复正文与字符错误均按实际输出评分。', '',
    '## 生产挂接防线：注入探针', '',
    `- 防线符合预期：${report.guards.correct}/${report.guards.total}（${pct(report.guards.rate)}）`,
    '- 此指标仅衡量在指定输入下防线是否拦截/降级；语义错挂探针被接受会计失败，但不能直接当作真实模型错挂率。', '',
    '| 案件 | 组件 recall@1 | 组件 recall@5 | 防线符合预期 |', '| --- | --- | --- | --- |')
  for (const sample of report.cases) lines.push(`| ${sample.name} | ${pct(sample.retrieval.recall1)} | ${pct(sample.retrieval.recall5)} | ${sample.guards.correct}/${sample.guards.total} |`)
  lines.push('', '检索指标调用生产 chunk BM25，并按材料去重；不是生产完整候选编排召回率。', '', '## 模型核验与完整链路', '',
    `- 语义模型：${report.live.textStatus}；视觉模型：${report.live.visionStatus}`, '')
  if (!report.live.caseResults.length) lines.push('**语义挂接 Precision / Recall / F1、关系准确率、模型 OCR 准确率及文件到挂接的完整链路均未测。**')
  for (const result of report.live.caseResults) lines.push(`- ${result.id}：原始模型 Precision ${pct(result.rawScore.precision)} / Recall ${pct(result.rawScore.recall)} / F1 ${pct(result.rawScore.f1)}；生产过滤后 Precision ${pct(result.score.precision)} / Recall ${pct(result.score.recall)} / F1 ${pct(result.score.f1)}，关系 ${pct(result.score.relationAccuracy)}，页码 ${pct(result.score.pageAccuracy)}，句级 exact match ${pct(result.score.exactMatch)}`)
  if (report.live.visionResults.length) {
    lines.push('', '| 视觉文件 | 字段准确率 | CER |', '| --- | --- | --- |')
    for (const result of report.live.visionResults) lines.push(`| ${result.id} | ${pct(result.score.fieldAccuracy)} | ${pct(result.score.characterErrorRate)} |`)
  }
  for (const result of report.live.fileLinkResults) lines.push(`- 文件链路（benchmark视觉适配器+生产挂接）${result.id}：原始模型 F1 ${pct(result.rawScore.f1)}；过滤后 Precision ${pct(result.score.precision)}，Recall ${pct(result.score.recall)}，F1 ${pct(result.score.f1)}，页码 ${pct(result.score.pageAccuracy)}`)
  lines.push('', '## 严格解析契约', '', `- 正确 ${report.parser.correct}/${report.parser.total}（${pct(report.parser.rate)}）：检查段落、句子锚点、材料、关系和引用内容；要求畸形字段被拒绝。`,
    '- 生产解析器目前主要负责信封恢复；此处同时检验期望的严格字段契约，未满足会保留失败，不用旧版的“非空即成功”口径。')
  lines.push('', '## 评分器反例自检', '', `- 检出 ${report.mutations.detected}/${report.mutations.total} 类故障；这验证评分器灵敏度，不是产品准确率。`, '', '## 严格验收', '')
  for (const [name, value] of Object.entries(report.thresholds)) lines.push(`- ${name}：${value}`)
  lines.push('', '缺少真实模型/视觉结果时完整验收失败；已执行部分的真实失败与未测分别列出。', '', '## 失败与未测明细', '')
  for (const issue of report.issues) lines.push(`- ${issue}`)
  lines.push('', '完整预测、字段缺失、探针输入输出、文件哈希、源码指纹及评分器变异结果见同名 JSON。', '')
  return lines.join('\n')
}
