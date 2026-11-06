import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from './api'

export const assistantAgents = [
  { id: 'case', label: '案件助手', description: '案情沟通与综合分析' },
  { id: 'evidence', label: '证据分析', description: '证明力、证据链与矛盾' },
  { id: 'strategy', label: '诉讼策略', description: '主张、抗辩与举证思路' },
] as const
export const assistantSkills = [
  { id: 'timeline', label: '时间线', description: '梳理事件与对应证据' },
  { id: 'evidence_gaps', label: '补证清单', description: '逐项明确证据缺口' },
  { id: 'cross_examination', label: '质证提纲', description: '围绕证明目的组织质证' },
  { id: 'risk_review', label: '风险审查', description: '识别事实与程序风险' },
] as const
export type AssistantSelection = {
  model?: string
  agent: typeof assistantAgents[number]['id']
  skill?: typeof assistantSkills[number]['id']
}

export function AssistantPicker({ label, title, items, value, disabled, open: controlledOpen, onOpen, onSelect }: {
  label: string; title: string; items: ReadonlyArray<{ id: string; label: string; description?: string }>
  value?: string; disabled?: boolean; open?: boolean; onOpen?: (open: boolean) => void; onSelect: (id: string) => void
}) {
  const [localOpen, setLocalOpen] = useState(false)
  const open = controlledOpen ?? localOpen
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(null)

  // 面板内的绝对定位菜单会被祖先 overflow 裁剪、并被 sticky 层叠上下文限制，
  // 统一挂到 body 上用 fixed 定位，避免被文书区或相邻面板盖住。
  const reposition = useCallback(() => {
    const rect = button.current?.getBoundingClientRect()
    if (!rect) return
    const width = Math.min(260, Math.max(200, window.innerWidth - 24))
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))
    const menuHeight = Math.min(280, Math.max(120, items.length * 46 + 44))
    const below = window.innerHeight - rect.bottom
    const top = below >= menuHeight + 12
      ? rect.bottom + 6
      : Math.max(12, rect.top - menuHeight - 6)
    setPosition({ top, left, width })
  }, [items.length])

  useLayoutEffect(() => {
    if (!open) return
    reposition()
    const sync = () => reposition()
    window.addEventListener('scroll', sync, true)
    window.addEventListener('resize', sync)
    return () => {
      window.removeEventListener('scroll', sync, true)
      window.removeEventListener('resize', sync)
    }
  }, [open, reposition])

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      const target = event.target as Node
      if (root.current?.contains(target)) return
      if (menu.current?.contains(target)) return
      setLocalOpen(false)
      onOpen?.(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open, onOpen])

  const choose = (id: string) => {
    onSelect(id)
    setLocalOpen(false)
    onOpen?.(false)
    button.current?.focus()
  }

  return <div className="assistant-picker" ref={root} onKeyDown={event => {
    if (event.key === 'Escape' && open) {
      setLocalOpen(false)
      onOpen?.(false)
      button.current?.focus()
      event.stopPropagation()
    }
    if (open && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const choices = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('.assistant-picker-menu button') ?? [])
      if (!choices.length) return
      const index = choices.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
        : event.key === 'ArrowDown' ? (index + 1) % choices.length : (index - 1 + choices.length) % choices.length
      choices[next]?.focus()
    }
  }}>
    <button ref={button} className="assistant-control" type="button" disabled={disabled}
      aria-label={title} aria-expanded={open} aria-haspopup="dialog"
      onClick={() => {
        const next = !open
        setLocalOpen(next)
        onOpen?.(next)
      }}>
      <span>{label}</span>
      <svg className="assistant-control-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
    {open && position ? createPortal(
      <div
        ref={menu}
        className="assistant-picker-menu"
        style={{ top: position.top, left: position.left, width: position.width }}
        role="dialog"
        aria-label={title}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            setLocalOpen(false)
            onOpen?.(false)
            button.current?.focus()
            event.stopPropagation()
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            const choices = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('.assistant-picker-menu button') ?? [])
            if (!choices.length) return
            const index = choices.indexOf(document.activeElement as HTMLButtonElement)
            const next = event.key === 'ArrowDown'
              ? (index + 1) % choices.length
              : (index - 1 + choices.length) % choices.length
            choices[next]?.focus()
          }
        }}
      >
        <strong>{title}</strong>
        {items.length ? items.map(item => <button key={item.id} type="button" aria-pressed={value === item.id}
          onClick={() => choose(item.id)}>
          <span>{item.label}</span>{item.description ? <small>{item.description}</small> : null}
          {value === item.id ? <b aria-hidden="true">✓</b> : null}
        </button>) : <p>暂无可用模型，请联系管理员配置。</p>}
      </div>,
      document.body,
    ) : null}
  </div>
}

export function VoiceInputButton({ disabled, onText, onError, onBusy, iconOnly }: {
  disabled?: boolean; onText: (text: string) => void; onError: (error: string) => void; onBusy?: (busy: boolean) => void
  iconOnly?: boolean
}) {
  const [phase, setPhase] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const active = useRef(true)
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const request = useRef<AbortController | null>(null)
  const callbacks = useRef({ onText, onError, onBusy })
  callbacks.current = { onText, onError, onBusy }
  const release = () => {
    if (timer.current) clearTimeout(timer.current)
    stream.current?.getTracks().forEach(track => track.stop())
    stream.current = null
  }
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      if (recorder.current?.state === 'recording') recorder.current.stop()
      request.current?.abort()
      release()
      callbacks.current.onBusy?.(false)
    }
  }, [])
  async function start() {
    setPhase('transcribing')
    callbacks.current.onError('')
    callbacks.current.onBusy?.(true)
    try {
      const capability = await api.assistantCapabilities()
      if (!active.current) return
      if (!capability.voice) throw new Error('语音输入尚未启用，请联系管理员配置语音识别服务。')
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('当前环境不支持录音，请在桌面端或 HTTPS 页面使用。')
      const media = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (!active.current) { media.getTracks().forEach(track => track.stop()); return }
      stream.current = media
      const mime = ['audio/webm', 'audio/mp4', 'audio/ogg'].find(type => MediaRecorder.isTypeSupported(type))
      if (!mime) throw new Error('当前环境不支持语音录制格式。')
      const audio = new MediaRecorder(media, { mimeType: mime })
      recorder.current = audio
      const chunks: Blob[] = []
      let failed = false
      let bytes = 0
      audio.ondataavailable = event => {
        bytes += event.data.size
        if (bytes > 8 * 1024 * 1024) { failed = true; audio.stop(); return }
        if (event.data.size) chunks.push(event.data)
      }
      audio.onerror = () => { failed = true; if (audio.state === 'recording') audio.stop() }
      audio.onstop = async () => {
        release()
        if (!active.current) return
        setPhase('transcribing')
        try {
          if (failed) throw new Error('录音失败或文件过大，请重新录制。')
          const blob = new Blob(chunks, { type: mime })
          if (!blob.size) throw new Error('未录制到语音，请重试。')
          request.current = new AbortController()
          const result = await api.transcribeAssistantAudio(blob, request.current.signal)
          if (active.current) callbacks.current.onText(result.text)
        } catch (error) {
          if (active.current) callbacks.current.onError(error instanceof Error ? error.message : '语音识别失败。')
        } finally {
          if (active.current) { setPhase('idle'); callbacks.current.onBusy?.(false) }
        }
      }
      audio.start(1000)
      setPhase('recording')
      timer.current = setTimeout(() => { if (audio.state === 'recording') audio.stop() }, 60000)
    } catch (error) {
      release()
      if (active.current) {
        callbacks.current.onError(error instanceof Error && error.name === 'NotAllowedError' ? '麦克风权限未开启，请在系统设置中允许录音。' : error instanceof Error ? error.message : '无法开始录音。')
        setPhase('idle'); callbacks.current.onBusy?.(false)
      }
    }
  }
  return <button className={`assistant-voice ${phase === 'recording' ? 'is-recording' : ''}`} type="button"
    disabled={phase === 'transcribing' || (disabled && phase === 'idle')} aria-label={phase === 'recording' ? '结束录音' : '语音输入'}
    aria-pressed={phase === 'recording'} onClick={() => {
      if (phase === 'recording') recorder.current?.stop()
      else void start()
    }}>
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="7" y="2" width="6" height="10" rx="3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4 9a6 6 0 0 0 12 0M10 15v3m-3 0h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
    {iconOnly ? null : phase === 'recording' ? '结束录音' : phase === 'transcribing' ? '处理中…' : '语音'}
  </button>
}
