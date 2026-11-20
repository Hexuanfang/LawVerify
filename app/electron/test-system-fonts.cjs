const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const appRoot = path.resolve(__dirname, '..')

test('中文使用系统字体回退，保留现有西文字体', () => {
  const definitions = fs.readFileSync(path.join(appRoot, 'src/redesign/fonts.css'), 'utf8')
  const styles = fs.readFileSync(path.join(appRoot, 'src/redesign/styles/global.css'), 'utf8')
  assert.ok(!/Noto (?:Sans|Serif) SC/.test(definitions + styles))
  assert.equal((definitions.match(/@font-face/g) || []).length, 5)
  assert.match(styles, /--font-ui:[^;]*Microsoft YaHei/)
  assert.match(styles, /--font-ui:[^;]*PingFang SC/)
  assert.match(styles, /--font-ui:[^;]*system-ui/)
  assert.match(styles, /--font-ui:[^;]*-apple-system/)
  assert.match(styles, /--font-ui:[^;]*Segoe UI/)
  assert.match(styles, /--font-doc:[^;]*SimSun/)
  assert.match(styles, /--font-doc:[^;]*Songti SC/)
  assert.match(styles, /--font-disp:[^;]*Fraunces/)
})

test('静态字体资源仅包含五个西文分片及对应许可证', () => {
  const directory = path.join(appRoot, 'public/redesign-fonts')
  const files = fs.readdirSync(directory).sort()
  const fonts = files.filter(file => file.endsWith('.woff2'))
  assert.deepEqual(fonts, Array.from({ length: 5 }, (_, index) => `font-${String(index).padStart(3, '0')}.woff2`))
  assert.ok(files.includes('fraunces-OFL.txt'))
  assert.ok(files.includes('instrumentsans-OFL.txt'))
  const css = fs.readFileSync(path.join(appRoot, 'src/redesign/fonts.css'), 'utf8')
  for (const match of css.matchAll(/redesign-fonts\/([^\s)]+)/g)) {
    assert.ok(fs.existsSync(path.join(directory, match[1])), match[1])
  }
})
