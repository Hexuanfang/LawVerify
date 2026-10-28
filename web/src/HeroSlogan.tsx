import { useEffect, useState } from 'react'

const alternativeSlogans = [
  '少一点重复。\n多一点专业判断。',
  '让证据有条理。\n让判断有底气。',
  '把材料理清。\n把论证写实。',
  '专注每次判断。\n认真每处引用。',
]

export function HeroSlogan({ title }: { title: string }) {
  const slogans = [...new Set([title, ...alternativeSlogans])].slice(0, 4)
  const [current, setCurrent] = useState(0)
  const [paused, setPaused] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)

  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onMotion = () => setReducedMotion(motion.matches)
    const onVisibility = () => setVisible(document.visibilityState === 'visible')
    motion.addEventListener('change', onMotion)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      motion.removeEventListener('change', onMotion)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  useEffect(() => {
    if (paused || hovered || focused || !visible || reducedMotion) return
    const timer = window.setTimeout(() => setCurrent((index) => (index + 1) % slogans.length), 5500)
    return () => window.clearTimeout(timer)
  }, [current, paused, hovered, focused, visible, reducedMotion, slogans.length])

  return (
    <div className="hero-slogan"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
      }}>
      <h1 className="hero-slogan-title" aria-live="off">
        {/* All slides share a grid cell so the longest title reserves its height. */}
        {slogans.map((slogan, index) => (
          <span className="hero-slogan-slide" key={slogan}
            data-active={current === index} aria-hidden={current !== index}>
            {slogan.split('\n').map((line, lineIndex) => (
              <span className={`hero-title-line${lineIndex > 0 ? ' hero-title-accent' : ''}`} key={line}>{line}</span>
            ))}
          </span>
        ))}
      </h1>
      <div className="hero-slogan-controls" role="group" aria-label="标语轮播"
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          setCurrent((index) => (index + (event.key === 'ArrowRight' ? 1 : slogans.length - 1)) % slogans.length)
        }}>
        {slogans.map((slogan, index) => (
          <button className="hero-slogan-dot" type="button" key={slogan}
            aria-label={`切换标语：${slogan.replace('\n', '')}`}
            aria-pressed={current === index} onClick={() => setCurrent(index)} />
        ))}
        {!reducedMotion && (
          <button className="hero-slogan-pause" type="button"
            aria-label={paused ? '播放标语轮播' : '暂停标语轮播'}
            aria-pressed={paused} onClick={() => setPaused((value) => !value)}>
            {paused ? '播放' : '暂停'}
          </button>
        )}
      </div>
    </div>
  )
}
