import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export default function SearchSelect({ label, value, options, onChange, placeholder, action = false }) {
  const id = useId();
  const trigger = useRef(null);
  const panel = useRef(null);
  const search = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState(null);
  const selected = options.find((option) => option.value === value);
  const term = query.trim().toLocaleLowerCase();
  const matches = options.filter((option) => (option.label + ' ' + (option.keywords || '')).toLocaleLowerCase().includes(term));

  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }
  function choose(option) {
    if (!option || option.disabled) return;
    close(true);
    onChange(option.value);
  }
  function show() {
    setQuery('');
    setActive(-1);
    setOpen(true);
  }
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(Math.max(rect.width, 216), window.innerWidth - 16);
      const below = window.innerHeight - rect.bottom - 10;
      const above = rect.top - 10;
      const up = below < 200 && above > below;
      setPosition({
        width, left: Math.min(Math.max(8, rect.left), window.innerWidth - width - 8),
        ...(up ? { bottom: window.innerHeight - rect.top + 5 } : { top: rect.bottom + 5 }),
        maxHeight: Math.max(64, Math.min(300, up ? above : below)),
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    search.current?.focus({ preventScroll: true });
    const outside = (event) => {
      if (!trigger.current?.contains(event.target) && !panel.current?.contains(event.target)) close();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
    };
  }, [open]);
  useEffect(() => {
    if (active >= 0) document.getElementById(id + '-' + active)?.scrollIntoView({ block: 'nearest' });
  }, [active, id]);

  return <div className={`search-select ${action ? 'search-action' : ''}`}>
    <button type="button" ref={trigger} className="search-select-trigger" aria-label={action ? label : label + '：' + (selected?.label || placeholder || '请选择')}
      aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined}
      disabled={!options.length} onClick={() => open ? close() : show()}
      onKeyDown={(event) => { if (event.key === 'ArrowDown' && !open) { event.preventDefault(); show(); } }}>
      <span>{action ? label : selected?.label || placeholder || '请选择'}</span><span className="search-select-arrow" aria-hidden="true" />
    </button>
    {open && createPortal(<div className="search-select-popover" ref={panel} style={position || undefined}>
      <input ref={search} role="combobox" aria-label={'搜索' + label} aria-expanded="true" aria-controls={id}
        aria-autocomplete="list" aria-activedescendant={active >= 0 ? id + '-' + active : undefined}
        placeholder="输入关键词搜索" value={query} onChange={(event) => { setQuery(event.target.value); setActive(-1); }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') { event.stopPropagation(); close(true); }
          if (event.key === 'Tab') close(true);
          if (event.key === 'Enter') {
            event.preventDefault();
            choose(matches[active] || matches.find((option) => !option.disabled));
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const direction = event.key === 'ArrowDown' ? 1 : -1;
            let index = active < 0 && direction < 0 ? matches.length - 1 : active + direction;
            while (matches[index]?.disabled) index += direction;
            if (matches[index]) setActive(index);
          }
        }} />
      <div className="search-select-list" id={id} role="listbox" aria-label={label}>
        {matches.map((option, i) => <button type="button" role="option" tabIndex={-1}
          id={id + '-' + i} key={option.value} aria-selected={!action && value === option.value}
          disabled={option.disabled} className={active === i ? 'active-option' : ''}
          onMouseDown={(event) => event.preventDefault()} onClick={() => choose(option)}>
          <span>{option.label}</span>{!action && value === option.value && <span aria-hidden="true">✓</span>}
        </button>)}
        {!matches.length && <p role="status">没有匹配项</p>}
      </div>
    </div>, document.body)}
  </div>;
}
