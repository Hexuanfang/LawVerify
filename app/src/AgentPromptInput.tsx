import { useImperativeHandle, useLayoutEffect, useRef, type Ref, type RefObject } from 'react'

export type AgentPromptInputHandle = {
  setValue: (value: string) => void
}

type AgentPromptInputProps = {
  ref: Ref<AgentPromptInputHandle>
  draftRef: RefObject<string>
  placeholder?: string
  disabled?: boolean
}

export function AgentPromptInput({ ref, draftRef, placeholder, disabled }: AgentPromptInputProps) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  useLayoutEffect(() => {
    if (inputRef.current) {
      inputRef.current.value = draftRef.current
    }
  }, [draftRef])

  useImperativeHandle(ref, () => ({
    setValue(nextValue) {
      draftRef.current = nextValue
      if (inputRef.current) {
        inputRef.current.value = nextValue
      }
    },
  }), [draftRef])

  return (
    <textarea
      ref={inputRef}
      className="agent-prompt-input agent-dock-prompt-input"
      aria-label="起草或改写要求"
      disabled={disabled}
      defaultValue=""
      onChange={(event) => {
        // Keep the draft available on collapse without rerendering the workbench.
        draftRef.current = event.target.value
      }}
      placeholder={placeholder}
    />
  )
}
