import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { statementRanges, type ReviewElement } from './model'
import type { useApp } from './AppContext'

type Save = ReturnType<typeof useApp>['edit']
type Session = {
  target: ReviewElement
  mark: HTMLElement
  anchor: ReviewElement
  composing: boolean
  pending?: Promise<boolean>
}
type NextTarget = { anchor: ReviewElement; start: number }

export function useInlineDeclarationEdit(save: Save, enabled: boolean) {
  const [active, setActive] = useState<Session>()
  const [status, setStatus] = useState('')
  const [canDiscard, setCanDiscard] = useState(false)
  const [nextTarget, setNextTarget] = useState<NextTarget>()
  const current = useRef<Session | undefined>(undefined)
  const leaving = useRef<Promise<boolean> | undefined>(undefined)
  const activation = useRef(0)
  const timer = useRef<number | undefined>(undefined)
  const saveRef = useRef(save)
  useLayoutEffect(() => { saveRef.current = save }, [save])

  const read = (session: Session) => session.mark.textContent?.replace(/[\r\n\t]+/gu, ' ').trim() ?? ''
  const submit = (session: Session): Promise<boolean> => {
    if (session.pending) return session.pending
    if (session.composing) return Promise.resolve(false)
    const text = read(session)
    if (text === session.target.quote) return Promise.resolve(true)
    if (!text) {
      setStatus('声明不能为空，请补充文字或放弃本次修改。')
      setCanDiscard(true)
      return Promise.resolve(false)
    }
    const target = session.target
    setStatus('正在保存声明…')
    setCanDiscard(false)
    const saving = saveRef.current(target, text, true).then(original => {
      if (current.current !== session) return false
      if (!original || original.text.slice(target.start, target.start + text.length) !== text) {
        setStatus('未能保存声明。请核对文书版本后重试，或复制当前文字后放弃修改。')
        setCanDiscard(true)
        return false
      }
      const end = target.start + text.length
      session.target = { ...target, original, end, quote: text,
        sentenceIndex: statementRanges(original.text).find(range => range.start <= target.start && range.end > target.start)?.sentenceIndex }
      setStatus('声明已保存 · 待重核')
      return true
    }).catch(() => {
      setStatus('未能保存声明，请重试。')
      setCanDiscard(true)
      return false
    }).finally(() => { session.pending = undefined })
    session.pending = saving
    return saving
  }
  const schedule = (session: Session) => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(async () => {
      if (current.current !== session || session.composing) return
      // 正在提交的请求以旧基线完成后，再保存此期间输入的文字。
      if (session.pending && !await session.pending) return
      if (current.current === session) await submit(session)
    }, 550)
  }
  const close = () => {
    window.clearTimeout(timer.current)
    current.current = undefined
    setActive(undefined)
    setStatus('')
    setCanDiscard(false)
  }
  const flush = () => leaving.current ?? (leaving.current = finish().finally(() => { leaving.current = undefined }))
  const finish = async () => {
    window.clearTimeout(timer.current)
    const session = current.current
    if (!session) return true
    if (session.composing) { setStatus('请先完成正在输入的文字。'); return false }
    if (session.pending && !await session.pending) return false
    // 切换目标或离开前阻止新输入，否则请求返回时可能还有未提交的字符。
    session.mark.contentEditable = 'false'
    const saved = await submit(session)
    if (saved) close()
    else session.mark.contentEditable = 'plaintext-only'
    return saved
  }
  const activate = async (element: ReviewElement) => {
    const request = ++activation.current
    if (current.current?.anchor.id === element.id) { current.current.mark.focus(); return }
    const previous = current.current
    if (previous) {
      if (!await flush() || request !== activation.current) return
      const sameParagraph = previous.anchor.paragraphId === element.paragraphId
      const moved = previous.anchor.end !== previous.target.end || previous.anchor.quote !== previous.target.quote
      if (sameParagraph && moved && element.start < previous.anchor.end && previous.anchor.start < element.end) {
        setStatus('所选声明与刚修改的范围重叠，请从正文重新选择。')
        return
      }
      const shifted = sameParagraph && element.start >= previous.anchor.end ? previous.target.end - previous.anchor.end : 0
      setNextTarget({ anchor: element, start: element.start + shifted })
      return
    }
    const mark = document.createElement('mark')
    mark.className = 'mk hit declaration-editor-mark'
    mark.contentEditable = 'plaintext-only'
    mark.setAttribute('role', 'textbox')
    mark.setAttribute('aria-label', '修改声明')
    mark.spellcheck = false
    mark.textContent = element.quote
    const session = { mark, target: element, anchor: element, composing: false }
    mark.addEventListener('beforeinput', event => {
      if (['insertParagraph', 'insertLineBreak'].includes(event.inputType)) event.preventDefault()
    })
    mark.addEventListener('compositionstart', () => { session.composing = true; window.clearTimeout(timer.current) })
    mark.addEventListener('compositionend', () => { session.composing = false; schedule(session) })
    mark.addEventListener('input', () => {
      if (!session.composing) schedule(session)
      setCanDiscard(true)
      setStatus('修改待保存')
    })
    current.current = session
    setActive(session)
    setStatus('')
  }
  useEffect(() => {
    if (!enabled) return
    const preventLoss = (event: BeforeUnloadEvent) => {
      const session = current.current
      if (!session || (!session.composing && !session.pending && read(session) === session.target.quote)) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', preventLoss)
    return () => {
      window.removeEventListener('beforeunload', preventLoss)
      window.clearTimeout(timer.current)
    }
  }, [enabled])
  return { active, status, canDiscard, activate, flush, discard: close, nextTarget, clearNextTarget: () => setNextTarget(undefined) }
}
