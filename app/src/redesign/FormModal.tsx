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
import { api } from '../api'
import type { KnowledgeCase, KnowledgeStatuteDocument } from '../types'
export function FormModal() {
  const app = useApp()
  const form = app.form
  const [values, setValues] = useState<Record<string, string>>({})
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
  const project = app.workspace?.cases.find((item) => item.id === form?.id)
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
    else
      setValues({
        name: project?.name || '',
        court: project?.description || '',
        gist: '',
      })
  }, [form, law, lawArticle, knowledgeCase, project])
  const field = (
    key: string,
    label: string,
    textarea = false,
    required = false,
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
    if (!form || !values.name?.trim()) return
    let createdId = ''
    const saved = await app.run(async () => {
      if (form.tab === 'proj') {
        if (form.id)
          await api.updateCase(form.id, {
            name: values.name.trim(),
            description: values.court,
          })
        else
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
    }, '已保存')
    if (saved) {
      app.setForm(null)
      if (createdId) app.setUploadCase(createdId)
    }
  }
  return (
    <Dialog
      open={Boolean(form)}
      onOpenChange={(open) => {
        if (!open && !app.busy) app.setForm(null)
      }}
    >
      <DialogContent className="fm-box new-form">
        <DialogHeader className="fm-h">
          <DialogTitle>
            {form?.id ? '编辑' : '新增'} ·{' '}
            {form?.tab === 'law'
              ? '法条'
              : form?.tab === 'case'
                ? '案例'
                : '案件'}
          </DialogTitle>
          <DialogDescription className="sr-only">
            填写信息后保存到当前工作区。
          </DialogDescription>
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
          ) : (
            <>
              {field('name', '案件名称 *', false, true)}
              {field('court', '受诉法院 / 案件说明')}
              {field('gist', '备注', true)}
            </>
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
              {app.busy ? '保存中…' : '保存'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
