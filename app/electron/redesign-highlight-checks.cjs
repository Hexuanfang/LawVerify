const assert = require('node:assert/strict')

async function sendHighlightClick({ evaluate, wait, window }, expression) {
  await wait(expression)
  window.webContents.focus()
  const point = await evaluate(`(async () => {
    (${expression}).scrollIntoView({ block: 'center', inline: 'nearest' });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const mark = (${expression});
    const rect = mark.getClientRects()[0];
    const canvas = mark.closest('.doc-scroll').getBoundingClientRect();
    const left = Math.max(rect.left, canvas.left, 0);
    const right = Math.min(rect.right, canvas.right, innerWidth);
    const top = Math.max(rect.top, canvas.top, 0);
    const bottom = Math.min(rect.bottom, canvas.bottom, innerHeight);
    return left < right && top < bottom ? { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) } : null;
  })()`)
  assert.ok(point, '核验高亮应滚动到可点击区域')
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
}

module.exports = { sendHighlightClick }
