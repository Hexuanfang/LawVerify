const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lawverify-ui-stability-'))
app.setPath('userData', directory)
app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1366, height: 900, webPreferences: { backgroundThrottling: false } })
  window.webContents.on('console-message', event => {
    if (event.level === 'error') process.stderr.write(`Renderer: ${event.message}\n`)
  })
  const checks = []
  const evaluate = code => Promise.race([
    window.webContents.executeJavaScript(code),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`Evaluation timed out: ${code.slice(0, 80)}`)), 20000)
      timer.unref()
    }),
  ])
  const wait = async expression => {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      if (await evaluate(`Promise.resolve(${expression}).then(value => Boolean(value))`)) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`Timeout: ${expression}`)
  }
  const check = async (name, action) => { process.stdout.write(`Check: ${name}\n`); await action(); checks.push(name) }
  try {
    await window.loadURL('http://127.0.0.1:8787/__stability')
    await wait('window.testReady && window.testEditor')
    await check('10,000 evidence rows keep fewer than 40 live rows', async () => {
      assert.ok(await evaluate("document.querySelectorAll('[data-row]').length") < 40)
      await evaluate("document.querySelector('.virtual-evidence-list').scrollTop = 599800")
      await wait("document.querySelector('[data-row=\"9999\"]')")
    })
    await check('continuous typing persists a local draft before blur', async () => {
      await evaluate("window.failSave=true;window.testEditor.commands.setContent('<p>Unsaved draft.</p>')")
      await wait("window.stabilityTests.readDraft(window.stabilityTests.draftKey('stability@test.invalid','certificate','paragraph')).then(draft=>draft?.text==='Unsaved draft.')")
    })
    await check('recovery does not silently overwrite a document', async () => {
      await evaluate('window.stabilityTests.unmountEditor()')
      await wait('!window.testEditor')
      await evaluate('window.mountEditor()')
      await wait("document.querySelector('.draft-recovery button')")
      assert.equal(await evaluate('window.testEditor.getText()'), 'Initial.')
      assert.equal(await evaluate('window.testEditor.isEditable'), false)
      await evaluate("document.querySelector('.draft-recovery button').click()")
      await wait("window.testEditor.getText()==='Unsaved draft.'")
    })
    await check('a stale save cannot remove a newer local revision', async () => {
      assert.equal(await evaluate(`(async()=>{
        const {writeDraft,removeDraft,readDraft}=window.stabilityTests;
        const old={key:'revision-test',revision:'old',text:'old',richText:'old',baseText:'',baseRichText:''};
        await writeDraft(old);await writeDraft({...old,revision:'new',text:'new'});
        await removeDraft(old.key,old.revision);const result=await readDraft(old.key);
        await removeDraft(old.key,'new');return result.revision;
      })()`), 'new')
    })
    await check('successful retry clears only the saved draft', async () => {
      await wait("document.querySelector('.draft-recovery button')?.textContent==='重试保存'")
      await evaluate("window.failSave=false;document.querySelector('.draft-recovery button').click()")
      await wait("window.stabilityTests.readDraft(window.stabilityTests.draftKey('stability@test.invalid','certificate','paragraph')).then(draft=>!draft)")
    })
    await check('undo before saving does not commit an obsolete draft', async () => {
      await evaluate("window.testEditor.commands.setContent('<p>Temporary change.</p>')")
      await wait("window.stabilityTests.readDraft(window.stabilityTests.draftKey('stability@test.invalid','certificate','paragraph')).then(draft=>draft?.text==='Temporary change.')")
      await evaluate("window.testEditor.commands.setContent('<p>Unsaved draft.</p>')")
      await wait("window.commits.at(-1)?.text==='Unsaved draft.' && window.commits.length>=3")
      assert.equal(await evaluate('window.commits.at(-1).text'), 'Unsaved draft.')
    })
    await check('rapid edits during an in-flight save preserve the latest revision', async () => {
      await evaluate("window.testEditor.commands.setContent('<p>First update.</p>')")
      await new Promise(resolve => setTimeout(resolve, 1550))
      await evaluate("window.testEditor.commands.setContent('<p>Latest update.</p>')")
      await wait("window.commits.at(-1)?.text==='Latest update.'")
      await wait("window.stabilityTests.readDraft(window.stabilityTests.draftKey('stability@test.invalid','certificate','paragraph')).then(draft=>!draft)")
    })
    await check('Word import executes in a browser worker', async () => {
      const text = await evaluate(`(async()=>{
        const response=await fetch('/__fixture.docx');
        const file=new File([await response.arrayBuffer()],'fixture.docx');
        return (await window.stabilityTests.importWordContent(file)).text;
      })()`)
      assert.match(text, /Word worker verification/)
    })
    await check('bounded preview rejects a chunked oversized response', async () => {
      assert.equal(await evaluate(`(async()=>{
        try{await window.stabilityTests.readBoundedSource(new Response(new Uint8Array(10)),4);return false}
        catch{return true}
      })()`), true)
    })
    await check('PDF creates a single bounded canvas and navigates pages', async () => {
      await evaluate('window.stabilityTests.mountPdf()')
      await wait("document.querySelector('.pdf-preview-toolbar span')?.textContent==='1 / 2' && !document.querySelector('.pdf-preview [role=\"status\"]')")
      assert.equal(await evaluate("document.querySelectorAll('.pdf-preview canvas').length"), 1)
      await evaluate("document.querySelectorAll('.pdf-preview-toolbar button')[1].click()")
      await wait("document.querySelector('.pdf-preview-toolbar span')?.textContent==='2 / 2' && !document.querySelector('.pdf-preview [role=\"status\"]')")
      assert.ok(await evaluate("document.querySelector('.pdf-preview canvas').width*document.querySelector('.pdf-preview canvas').height") <= 4010000)
      await evaluate('window.stabilityTests.unmountPdf()')
      await wait("!document.querySelector('.pdf-preview')")
    })
    await check('a React rendering error stays inside its boundary', async () => {
      await evaluate('window.stabilityTests.throwBoundary()')
      await wait("document.querySelector('#boundary .stability-fallback')")
      assert.ok(await evaluate("Boolean(document.querySelector('[data-row]') && window.testEditor)"))
    })
    await check('repeated evidence scrolling records actual interaction latency', async () => {
      window.showInactive()
      const timings = await evaluate(`(async()=>{
        const list=document.querySelector('.virtual-evidence-list'),samples=[];
        for(let i=0;i<100;i++){
          const start=performance.now();list.scrollTop=i%2?599800:0;
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
          samples.push(performance.now()-start);
        }
        return samples.sort((a,b)=>a-b);
      })()`)
      process.stdout.write(`Evidence scrolling P95: ${timings[94].toFixed(1)}ms (${timings.length} samples, Electron software rendering)\n`)
      assert.ok(timings[94] < 500, 'Severe UI stall during evidence scrolling')
      assert.ok(await evaluate("document.querySelectorAll('[data-row]').length") < 40)
      window.hide()
    })
    const soakMinutes = Number(process.env.LAWVERIFY_SOAK_MINUTES ?? 0)
    if (soakMinutes > 0) {
      await check(`soak for ${soakMinutes} minutes with scrolling, editing and PDF mounts`, async () => {
        const deadline = Date.now() + soakMinutes * 60000
        let cycles = 0
        let nextSample = Date.now()
        const samples = []
        while (Date.now() < deadline) {
          await evaluate(`window.testEditor.commands.setContent('<p>Soak cycle ${cycles}.</p>');window.stabilityTests.mountPdf()`)
          await wait("document.querySelector('.pdf-preview-toolbar span')?.textContent==='1 / 2' && !document.querySelector('.pdf-preview [role=\"status\"]')")
          await evaluate('window.stabilityTests.unmountPdf()')
          await new Promise(resolve => setTimeout(resolve, 2000))
          assert.ok(await evaluate("document.querySelectorAll('[data-row]').length") < 40)
          cycles++
          if (Date.now() >= nextSample) {
            const metrics = app.getAppMetrics()
            const sample = { time: new Date().toISOString(), cycles, rendererKB: metrics.find(metric => metric.type === 'Tab')?.memory.workingSetSize ?? 0 }
            samples.push(sample)
            process.stdout.write(`Soak memory sample: ${JSON.stringify(sample)}\n`)
            nextSample = Date.now() + 30 * 60000
          }
        }
        process.stdout.write(`Soak cycles: ${cycles}; process memory: ${JSON.stringify(app.getAppMetrics().map(metric=>({type:metric.type,workingSet:metric.memory.workingSetSize})))}\n`)
        if (samples.length >= 3) {
          const first = samples[1].rendererKB
          const last = samples.at(-1).rendererKB
          assert.ok(last - first < 128 * 1024, 'Renderer working set grew more than 128MB after warm-up; investigate before release')
        }
      })
    }
    await check('a real renderer crash preserves the confirmed local draft', async () => {
      await evaluate("window.failSave=true;window.testEditor.commands.setContent('<p>Crash recovery draft.</p>')")
      await wait("window.stabilityTests.readDraft(window.stabilityTests.draftKey('stability@test.invalid','certificate','paragraph')).then(draft=>draft?.text==='Crash recovery draft.')")
      const gone = new Promise(resolve => window.webContents.once('render-process-gone', resolve))
      window.webContents.forcefullyCrashRenderer()
      await gone
      await window.loadURL('http://127.0.0.1:8787/__stability')
      await wait("window.testReady && window.testEditor && document.querySelector('.draft-recovery button')")
      assert.equal(await evaluate('window.testEditor.getText()'), 'Initial.')
      assert.equal(await evaluate("document.querySelector('.draft-recovery details').textContent.includes('Crash recovery draft.')"), true)
    })
    assert.deepEqual(await evaluate('window.testFailures'), [])
    process.stdout.write(`${JSON.stringify({ checks: checks.length, passed: checks }, null, 2)}\n`)
    window.destroy()
    app.exit(0)
  } catch (error) {
    process.stderr.write(`State: ${JSON.stringify(await evaluate(`(async()=>({
      editor:window.testEditor?.getText(), commits:window.commits, failures:window.testFailures,
      warning:document.querySelector('.draft-recovery')?.textContent,
      draft:await window.stabilityTests.readDraft(window.stabilityTests.draftKey('stability@test.invalid','certificate','paragraph'))
    }))()`).catch(() => ({})))}\n`)
    process.stderr.write(`${error.stack}\n`)
    app.exit(1)
  }
})
process.on('exit', () => {
  try { fs.rmSync(directory, { recursive: true, force: true }) } catch {}
})
