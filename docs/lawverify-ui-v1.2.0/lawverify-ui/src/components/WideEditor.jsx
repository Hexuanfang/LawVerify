import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export default function WideEditor({ title, label, initial = '', hint, original, placeholder, saveLabel, canClear, onSave, onClose }) {
  const dialog = useRef(null);
  const input = useRef(null);
  const titleId = useId();
  const inputId = useId();
  const [value, setValue] = useState(initial);

  useLayoutEffect(() => {
    const element = dialog.current;
    element.showModal();
    input.current.focus();
    return () => element.close();
  }, []);

  return createPortal(
    <dialog className="wide-editor" ref={dialog} aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <form onSubmit={(event) => { event.preventDefault(); onSave(value); }}>
        <header>
          <h2 id={titleId}>{title}</h2>
          {hint && <p>{hint}</p>}
        </header>
        <div className="wide-editor-content">
          {original && <details className="wide-editor-original"><summary>查看原文</summary><p>{original}</p></details>}
          <label htmlFor={inputId}>{label}</label>
          <textarea id={inputId} ref={input} value={value} placeholder={placeholder} onChange={(event) => setValue(event.target.value)} />
        </div>
        <footer>
          <button type="button" className="btn btn-gh" onClick={onClose}>取消</button>
          <button className="btn btn-pri" disabled={!canClear && !value.trim()}>{saveLabel}</button>
        </footer>
      </form>
    </dialog>,
    document.body,
  );
}
