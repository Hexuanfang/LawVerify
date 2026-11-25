const assert = require('node:assert/strict')

const bodyParagraphs = `Array.from(document.querySelectorAll('.whole-document-content [data-para-id][data-layout-story="body"]'))`
const editorReady = `document.querySelector('.whole-document-content[data-editable=true] .superdoc-page')`

async function selectDocxRange({ evaluate, wait, window }, first, last = first, startOffset = 0, endOffset = null) {
  await wait(`(${first}) && (${last})`)
  window.webContents.focus()
  const points = await evaluate(`(async () => {
    const first = (${first}); const last = (${last});
    first.scrollIntoView({block:'center',inline:'nearest'});
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const point = (paragraph, offset) => {
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
      const text = [];
      while (walker.nextNode()) if (walker.currentNode.parentElement.closest('.superdoc-text-run')) text.push(walker.currentNode);
      if (!text.length) {
        const box = paragraph.getBoundingClientRect();
        return {x:Math.round(box.x+2),y:Math.round(box.y+box.height/2)};
      }
      let remaining = offset ?? text.reduce((sum, node) => sum + node.length, 0);
      const node = text.find(item => { if (remaining <= item.length) return true; remaining -= item.length; return false });
      if (!node) return null;
      const range = document.createRange();
      range.setStart(node, remaining); range.collapse(true);
      const box = range.getBoundingClientRect();
      return {x:Math.round(box.x),y:Math.round(box.y+box.height/2)};
    };
    return [point(first, ${JSON.stringify(startOffset)}),point(last, ${JSON.stringify(endOffset)})];
  })()`)
  const [from, to] = points
  assert.ok(from && to, '可见的 Word 段落应提供可选中的文字位置')
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...from })
  if (from.x !== to.x || from.y !== to.y) window.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', modifiers: ['leftButtonDown'], ...to })
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...to })
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
}

module.exports = { bodyParagraphs, editorReady, selectDocxRange }
