import { useEffect, useState, type FormEvent } from 'react'
import { Button } from './components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog'
import { Input } from './components/ui/input'
import { Textarea } from './components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './components/ui/select'
import { useApp } from './AppContext'
import { caseNoteKey } from './caseNotes'
import { UploadModal } from './UploadModal'
import { api } from '../api'
import type { KnowledgeCase, KnowledgeStatuteDocument } from '../types'
export function FormModal() {
  const app = useApp()
  const form = app.form
  const project = form?.tab === 'proj' ? app.workspace?.cases.find((item) => item.id === form.id) : undefined
  const caseForm = form?.tab === 'proj'
  const editingProject = caseForm && Boolean(form.id)
  const [values, setValues] = useState<Record<string, string>>(() => ({
    name: project?.name ?? '',
    plaintiff: project?.basicInfo?.plaintiff ?? '',
    defendant: project?.basicInfo?.defendant ?? '',
    ourSide: project?.basicInfo?.ourSide ?? '',
    cause: project?.basicInfo?.cause ?? '',
    court: project?.basicInfo?.court ?? '',
    caseNumber: project?.basicInfo?.caseNumber ?? '',
  }))
  const [task, setTask] = useState<'verify' | 'draft'>('verify')
  const [newCaseId, setNewCaseId] = useState('')
  const law = app.workspace?.knowledgeStatutes.find(
    (item) =>
      item.id === form?.id ||
      item.articles.some((article) => article.id === form?.id),
  )
  const lawArticle =
    law?.articles.find((item) => item.id === form?.id) || law?.articles[0]
  const knowledgeCase = app.workspace?.knowledgeCases.find(
    (item) => item.id === form?.id,
  )
  useEffect(() => {
    if (form?.tab === 'law')
      setValues({
        name: law?.title || '',
        art: lawArticle?.articleNumber || '',
        gist: lawArticle?.content || '',
        st: law?.effectiveStatus || 'effective',
        date: law?.effectiveDate || '',
        no: law?.issuer || '',
      })
    else if (form?.tab === 'case')
      setValues({
        name: knowledgeCase?.title || '',
        no: knowledgeCase?.caseNumber || '',
        court: knowledgeCase?.courtName || '',
        gist: knowledgeCase?.holdingSummary || '',
        date: knowledgeCase?.judgmentDate || '',
        lv: knowledgeCase?.courtLevel || '普通案例',
      })
  }, [form, law, lawArticle, knowledgeCase])
  const field = (
    key: string,
    label: string,
    textarea = false,
    required = false,
    placeholder?: string,
  ) => (
    <div className="fld">
      <label htmlFor={`field-${key}`}>{label}</label>
      {textarea ? (
        <Textarea
          id={`field-${key}`}
          value={values[key] ?? ''}
          onChange={(event) =>
            setValues((current) => ({ ...current, [key]: event.target.value }))
          }
        />
      ) : (
        <Input
          id={`field-${key}`}
          value={values[key] ?? ''}
          required={required}
          placeholder={placeholder}
          type={key === 'date' ? 'date' : 'text'}
          onChange={(event) =>
            setValues((current) => ({ ...current, [key]: event.target.value }))
          }
        />
      )}
    </div>
  )
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!form || app.busy) return
    if (!values.name?.trim()) {
      if (editingProject) app.setError('请输入案件名称。')
      return
    }
    let createdId = ''
    const saved = await app.run(async () => {
      if (form.tab === 'proj') {
        if (form.id) {
          if (!project) throw new Error('案件不存在，请关闭后刷新案件列表。')
          const ourSide = values.ourSide
          await api.updateCase(form.id, {
            name: values.name.trim(),
            basicInfo: {
              plaintiff: values.plaintiff,
              defendant: values.defendant,
              ourSide: ourSide === 'plaintiff' || ourSide === 'defendant' ? ourSide : null,
              cause: values.cause,
              court: values.court,
              caseNumber: values.caseNumber,
            },
          })
        } else
          createdId = (
            await api.createCase(
              values.name.trim(),
              values.court || values.gist,
            )
          ).caseFolder.id
      } else if (form.tab === 'law') {
        if (!values.art?.trim()) throw new Error('条号必填')
        if (lawArticle && values.art.trim() !== lawArticle.articleNumber)
          throw new Error(
            '条号修改需接入按条文 ID 更新的接口，其他字段可保存。',
          )
        const id = law?.id || crypto.randomUUID()
        const item: KnowledgeStatuteDocument = {
          id,
          title: values.name.trim(),
          docType: '法律',
          issuer: values.no || '',
          effectiveStatus:
            values.st as KnowledgeStatuteDocument['effectiveStatus'],
          effectiveDate: values.date || '',
          publishDate: law?.publishDate || '',
          version: law?.version || new Date().toISOString(),
          keywords: law?.keywords || [],
          ...law,
          articles: law
            ? law.articles.map((article) =>
                article.id === lawArticle?.id
                  ? {
                      ...article,
                      content: values.gist || '',
                      plainText: values.gist || '',
                    }
                  : article,
              )
            : [
                {
                  id: crypto.randomUUID(),
                  documentId: id,
                  aliases: [],
                  topicTags: [],
                  articleNumber: values.art.trim(),
                  content: values.gist || '',
                  plainText: values.gist || '',
                },
              ],
        }
        Object.assign(item, {
          title: values.name.trim(),
          issuer: values.no || '',
          effectiveStatus: values.st,
          effectiveDate: values.date || '',
        })
        await api.importKnowledgeStatutes({ items: [item] })
      } else {
        if (!values.no?.trim() || !values.court?.trim())
          throw new Error('案号与法院必填')
        if (
          knowledgeCase &&
          !knowledgeCase.sourceUrl &&
          (values.no.trim() !== knowledgeCase.caseNumber ||
            values.name.trim() !== knowledgeCase.title)
        )
          throw new Error(
            '当前导入接口按案号和名称合并，修改这两个字段需接入案例更新接口。其他字段可保存。',
          )
        const item: KnowledgeCase = {
          id: form.id || crypto.randomUUID(),
          title: '',
          caseNumber: '',
          courtName: '',
          courtLevel: '',
          region: '',
          trialLevel: '',
          caseType: '民事',
          cause: '',
          judgmentDate: '',
          effectiveDate: '',
          issueSummary: '',
          holdingSummary: '',
          reasoningSummary: '',
          resultSummary: '',
          sourceType: 'manual',
          keywords: [],
          focusTags: [],
          referencedStatutes: [],
          excerpts: [],
          ...knowledgeCase,
        }
        Object.assign(item, {
          title: values.name.trim(),
          caseNumber: values.no.trim(),
          courtName: values.court.trim(),
          courtLevel: values.lv,
          judgmentDate: values.date || '',
          holdingSummary: values.gist || '',
        })
        await api.importKnowledgeCases({ items: [item] })
      }
    }, editingProject ? '案件信息已保存' : caseForm ? undefined : '已保存')
    if (saved) {
      if (createdId) {
        const note = values.note?.trim()
        if (note && app.workspace) {
          try { localStorage.setItem(caseNoteKey(app.workspace.user.id, createdId), note) }
          catch { app.setError('案件已创建，律师笔记未写入本机存储。') }
        }
        setNewCaseId(createdId)
      } else app.setForm(null)
    }
  }
  if (newCaseId) {
    const stance = values.stance?.trim()
    return <UploadModal setup={{ caseId: newCaseId, task,
      onImported: () => {
        if (stance) app.setAssistantRequest({ mode: 'case', prompt: stance, position: true })
        app.setForm(null)
      },
      onContinue: () => {
        if (task === 'draft' || stance) {
          app.setCaseIdForUpload(newCaseId, '')
          app.setAssistantRequest(stance ? { mode: 'case', prompt: stance, position: true } : { mode: 'document' })
        } else app.enter(newCaseId)
        app.setForm(null)
      },
    }} />
  }
  return (
    <Dialog
      open={Boolean(form)}
      onOpenChange={(open) => {
        if (!open && !app.busy) app.setForm(null)
      }}
    >
      <DialogContent className={`fm-box new-form${caseForm ? ' case-info-form' : ''}`} showCloseButton={!caseForm}
        onOpenAutoFocus={caseForm ? event => {
          const input = document.getElementById('field-name')
          if (input) { event.preventDefault(); input.focus() }
        } : undefined}>
        <DialogHeader className="fm-h">
          <DialogTitle>
            {caseForm ? editingProject ? '编辑案件信息' : '新建案件' :
              `${form?.id ? '编辑' : '新增'} · ${form?.tab === 'law' ? '法条' : form?.tab === 'case' ? '案例' : '案件'}`}
          </DialogTitle>
          <DialogDescription className="sr-only">
            填写信息后保存到当前工作区。
          </DialogDescription>
          {caseForm && <DialogClose asChild>
            <Button variant="ghost" size="sm" disabled={app.busy}>关闭</Button>
          </DialogClose>}
        </DialogHeader>
        <form onSubmit={(event) => void save(event)}>
          {form?.tab === 'law' ? (
            <>
              {field('name', '法律全称 *', false, true)}
              {field('art', '条号 *', false, true)}
              <div className="fld">
                <label>效力状态</label>
                <Select
                  value={values.st}
                  onValueChange={(st) =>
                    setValues((current) => ({ ...current, st }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="effective">现行有效</SelectItem>
                    <SelectItem value="amended">已修正</SelectItem>
                    <SelectItem value="repealed">已废止</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {field('date', '施行日期')}
              {field('no', '文号 / 发布机关')}
              {field('gist', '条文内容 / 备注', true)}
            </>
          ) : form?.tab === 'case' ? (
            <>
              {field('no', '案号 *', false, true)}
              {field('name', '案件名称 *', false, true)}
              {field('court', '审理法院 *', false, true)}
              {field('date', '裁判日期 *', false, true)}
              <div className="fld">
                <label>效力层级</label>
                <Select
                  value={values.lv}
                  onValueChange={(lv) =>
                    setValues((current) => ({ ...current, lv }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {['指导性案例', '公报案例', '高院参考', '普通案例'].map(
                      (value) => (
                        <SelectItem value={value} key={value}>
                          {value}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
              </div>
              {field('gist', '裁判要旨', true)}
            </>
          ) : editingProject ? (
            <div className="edit-case-body">
              {field('name', '案件名称（必填）', false, true)}
              <section className="edit-case-parties" aria-labelledby="edit-case-parties-heading">
                <div className="edit-case-parties-heading">
                  <h3 id="edit-case-parties-heading">当事人</h3><small>顶栏将标注「我方」</small>
                </div>
                <div className="case-basic-fields">
                  {field('plaintiff', '原告')}
                  {field('defendant', '被告')}
                </div>
                <div className="edit-case-side" role="radiogroup" aria-label="我方当事人">
                  <b aria-hidden="true">我方</b>
                  <div className="edit-case-segments">
                    {([['', '未指定'], ['plaintiff', '原告'], ['defendant', '被告']] as const).map(([side, label]) => (
                      <label key={side}>
                        <input type="radio" className="sr-only" name="case-our-side" checked={values.ourSide === side}
                          onChange={() => setValues(current => ({ ...current, ourSide: side }))} />
                        <span>{label}{side && values[side] ? ` · ${values[side]}` : ''}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </section>
              <details className="edit-case-more">
                <summary>更多案件信息 <small>案由 / 法院 / 案号，选填</small></summary>
                <div className="edit-case-extra-fields">
                  {field('cause', '案由')}
                  {field('court', '受诉法院')}
                  {field('caseNumber', '案号')}
                </div>
              </details>
            </div>
          ) : (
            <div className="edit-case-body">
              {field('name', '案件名称（必填）', false, true, '例如，王某诉李某民间借贷纠纷')}
              <fieldset className="new-case-task">
                <legend>办案任务</legend>
                <div className="new-case-task-options">
                  <label><input type="radio" name="case-task" value="verify" checked={task === 'verify'} onChange={() => setTask('verify')} />
                    <span><b>AI 核验已有文书</b><small>案件原材料与待核验文书</small></span></label>
                  <label><input type="radio" name="case-task" value="draft" checked={task === 'draft'} onChange={() => setTask('draft')} />
                    <span><b>AI 起草新文书</b><small>案件原材料与代理立场</small></span></label>
                </div>
              </fieldset>
              <details className="edit-case-more">
                <summary>案件记忆与更多信息 <small>选填</small></summary>
                <div className="new-case-memory-fields">
                  <div className="case-basic-fields">
                    {field('stance', '代理立场（可由案件助手整理后确认）', true)}
                    {field('note', '律师笔记（保存在本机）', true)}
                  </div>
                  {field('court', '受诉法院 / 案件说明')}
                </div>
              </details>
            </div>
          )}
          <div className="fm-ft">
            <DialogClose asChild>
              <Button
                type="button"
                className="btn btn-gh btn-sm"
                disabled={app.busy}
              >
                取消
              </Button>
            </DialogClose>
            <Button
              type="submit"
              className="btn btn-pri btn-sm"
              disabled={app.busy}
            >
              {app.busy ? '保存中…' : editingProject ? '保存案件信息' : caseForm ? '下一步：添加文件' : '保存'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
