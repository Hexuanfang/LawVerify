import { Button } from './components/ui/button'
import { Brand } from './Home'
import { useApp } from './AppContext'
import { STATUS_NAMES, type ReviewElement } from './model'

export function Report() {
  const app = useApp()
  const jump = (element: ReviewElement) => {
    app.setPage('ws')
    app.select(element.id)
  }
  return (
    <div className="page active" id="pg-report">
      <div className="topbar">
        <Button
          className="btn-txt"
          variant="ghost"
          onClick={() => app.setPage('ws')}
        >
          ← 返回工作台
        </Button>
        <Brand title="核验报告" size={24} />
        <Button
          className="btn btn-pri btn-sm ml-auto"
          onClick={() => void app.exportWord(true)}
        >
          导出审阅版 Word
        </Button>
        <Button
          className="btn btn-gh btn-sm"
          onClick={() => void app.exportWord(false)}
        >
          清洁版 + 报告
        </Button>
      </div>
      <div className="rp-w fade">
        <div className="rp-hero">
          <h1>{app.certificate?.title || '文书'} · 核验报告</h1>
          <div className="sub">
            {app.project?.name} ｜ {new Date().toLocaleDateString('zh-CN')} ｜
            LawVerify {__APP_VERSION__}
          </div>
        </div>
        <div className="review-progress">人工审阅：{app.documentReview.total - app.documentReview.unreviewed}/{app.documentReview.total} 段；
          {app.documentReview.ready ? '本篇审阅完成' : '本篇尚未完成审阅'}</div>
        <div
          className={`vb ${app.stats.fail ? 'bad' : app.stats.warn ? 'warn' : 'ok'}`}
        >
          <i />
          <span>
            {app.stats.fail
              ? '总体结论：需修改后复检 —— 红灯项必须人工处理，才能标记已核验。'
              : app.stats.warn
                ? '总体结论：仍有黄灯项，建议人工复核。'
                : app.stats.all
                  ? app.documentReview.ready ? '总体结论：本篇人工审阅完成，请律师确认后使用。' : '总体结论：仍有段落未经人工审阅。'
                  : '暂无核验结果，请先导入文书并完成核验。'}
          </span>
        </div>
        <div className="stats">
          {(
            [
              ['all', '声明'],
              ['pass', '绿'],
              ['warn', '黄'],
              ['fail', '红'],
            ] as const
          ).map(([key, label]) => (
            <div className="stat" key={key}>
              <b className={`text-${key}`}>{app.stats[key]}</b>
              <span>{label}</span>
            </div>
          ))}
        </div>
        {(
          [
            ['fail', '红灯 · 强制人工处理'],
            ['warn', '黄灯 · 建议复核'],
            ['pass', '绿灯 · 可默认通过'],
          ] as const
        ).map(([status, title]) => {
          const elements = app.elements.filter((element) =>
            status === 'fail'
              ? ['fail', 'miss'].includes(element.verdict)
              : status === 'pass'
                ? ['pass', 'note'].includes(element.verdict)
                : element.verdict === status,
          )
          return (
            <section key={status}>
              <div className="sec" style={{ marginTop: 22 }}>
                {title}
              </div>
              {elements.length ? (
                elements.map((element) => (
                  <button
                    type="button"
                    className="iss"
                    key={element.id}
                    onClick={() => jump(element)}
                  >
                    <span className={`pill text-${status}`}>
                      <i />
                      {STATUS_NAMES[element.verdict]}
                    </span>
                    <div className="iss-b">
                      <div className="iss-t">
                        {element.type} ·{' '}
                        {element.conf === null
                          ? '暂无置信度评分'
                          : `置信 ${element.conf}%`}
                      </div>
                      <div className="iss-d">{element.quote.slice(0, 48)}…</div>
                    </div>
                    <span className="iss-go">定位 →</span>
                  </button>
                ))
              ) : (
                <p className="empty-inline">无</p>
              )}
            </section>
          )
        })}
        <div className="sec" style={{ marginTop: 22 }}>
          人工操作留痕
        </div>
        <div className="report-audits">
          {app.audits
            .filter((item) => item.certificateId === app.docId)
            .map((item, index) => (
              <div key={index}>
                · {new Date(item.t).toLocaleString('zh-CN')} {item.msg}
              </div>
            ))}
          {!app.audits.some((item) => item.certificateId === app.docId) &&
            '暂无人工操作。'}
        </div>
      </div>
    </div>
  )
}

export function Processing() {
  const app = useApp()
  return (
    <div className="page active" id="pg-proc">
      <div className="proc">
        <div className="proc-box fade">
          <div className="proc-t">
            正在核验《{app.certificate?.title || '文书'}》
          </div>
          <div className="proc-s">
            抽取声明 → 定位源头 → 逐项比对 → 绿黄红分档
          </div>
          {[
            '解析文书与 OCR',
            '抽取声明',
            '匹配案件原材料 L1',
            '匹配法条效力 L2',
            '匹配类案 L3',
            '生成分档与批注',
          ].map((name, index) => (
            <div
              className={`pst ${app.proc.step === index ? 'on' : ''} ${app.proc.step > index ? 'done' : ''}`}
              key={name}
            >
              <div className="pst-i">{index + 1}</div>
              <div style={{ fontWeight: 500 }}>{name}</div>
              <div className="proc-meta">
                {app.proc.step > index
                  ? '已完成'
                  : app.proc.step === index
                    ? '处理中'
                    : '—'}
              </div>
            </div>
          ))}
          <div className="pbar" role="progressbar" aria-label="核验进度">
            <i
              className={app.proc.done ? '' : 'indeterminate'}
              style={{ width: app.proc.done ? '100%' : '36%' }}
            />
          </div>
          <div className="ppct" role="status">
            {app.proc.error || app.proc.message}
          </div>
          <div className="proc-actions">
            {app.proc.error ? (
              <>
                <Button
                  className="btn btn-gh"
                  disabled={app.busy}
                  onClick={() => app.setPage('ws')}
                >
                  返回工作台
                </Button>
                <Button
                  className="btn btn-pri"
                  disabled={app.busy}
                  onClick={() => void app.verify()}
                >
                  重试
                </Button>
              </>
            ) : (
              <Button className="btn btn-gh" onClick={app.cancelVerification}>
                取消核验
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
