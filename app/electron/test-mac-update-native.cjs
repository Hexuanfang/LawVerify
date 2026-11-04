const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { prepareMacUpdate, launchMacUpdate } = require('./mac-update.cjs')

assert.equal(process.platform, 'darwin', 'Native update verification requires macOS')

function command(binary, args) {
  return execFileSync(binary, args, { encoding: 'utf8', timeout: 120000 })
}

async function waitFor(check) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error('Native update timed out')
}

async function exercise(failStartup) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lawverify-mac-native-')))
  const profile = path.join(root, 'profile')
  const target = path.join(root, 'installed', 'LawVerify.app')
  const payload = path.join(root, 'payload')
  const source = path.join(payload, 'LawVerify.app')
  const arch = process.arch
  let job
  try {
    fs.mkdirSync(profile)
    for (const [bundle, version, old] of [[target, '0.1.59', true], [source, '0.1.60', false]]) {
      fs.mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true })
      fs.mkdirSync(path.join(bundle, 'Contents', 'Resources'))
      fs.writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.zhijing.lawverify</string>
<key>CFBundleExecutable</key><string>LawVerify</string>
<key>CFBundleName</key><string>LawVerify</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>`)
      fs.writeFileSync(path.join(bundle, 'Contents', 'Resources', 'marker'), old ? 'old' : 'new')
      const cFile = path.join(root, old ? 'old.c' : 'new.c')
      fs.writeFileSync(cFile, `#include <stdio.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  const char *profile = ${JSON.stringify(profile)};
  char file[4096]; const char *job = 0;
  for(int i=1;i<argc;i++) if(strncmp(argv[i],"--lawverify-update-job=",23)==0) job=argv[i]+23;
  if (${old ? 1 : 0}) {
    snprintf(file,sizeof(file),"%s/old-restarted",profile); FILE *out=fopen(file,"w"); if(out){fputs("old",out);fclose(out);} return 0;
  }
  if(!job) return 1;
  snprintf(file,sizeof(file),"%s/updates/mac/%s/new-pid",profile,job);
  FILE *pid=fopen(file,"w"); if(!pid) return 2; fprintf(pid,"%d\\n",getpid()); fclose(pid);
  if (${failStartup ? 1 : 0}) return 1;
  snprintf(file,sizeof(file),"%s/updates/mac/%s/startup-ok",profile,job);
  FILE *ready=fopen(file,"w"); if(!ready) return 3; fprintf(ready,"%s\\n",job); fclose(ready);
  sleep(2); return 0;
}`)
      command('/usr/bin/clang', [cFile, '-o', path.join(bundle, 'Contents', 'MacOS', 'LawVerify')])
      command('/usr/bin/codesign', ['--force', '--sign', '-', bundle])
    }
    const dmg = path.join(root, 'update.dmg')
    command('/usr/bin/hdiutil', ['create', '-srcfolder', payload, '-volname', 'LawVerifyAutoUpdateTest', '-format', 'UDZO', dmg])
    job = await prepareMacUpdate({
      installerPath: dmg, execPath: path.join(target, 'Contents', 'MacOS', 'LawVerify'),
      userData: profile, version: '0.1.60', arch, channel: 'test',
    })
    await launchMacUpdate(job, 99999999, { exitTimeout: 5, startupTimeout: 8 })
    await waitFor(() => {
      const status = fs.readFileSync(path.join(job.directory, 'status'), 'utf8').trim()
      return ['complete', 'rolled-back', 'failed'].includes(status)
    })
    assert.equal(fs.readFileSync(path.join(job.directory, 'status'), 'utf8').trim(), failStartup ? 'rolled-back' : 'complete')
    assert.equal(fs.readFileSync(path.join(target, 'Contents', 'Resources', 'marker'), 'utf8'), failStartup ? 'old' : 'new')
    if (failStartup) await waitFor(() => fs.existsSync(path.join(profile, 'old-restarted')))
    console.log(`PASS native Mac ${arch}: actual DMG mount, ditto, codesign, LaunchServices and ${failStartup ? 'failed-start rollback' : 'startup-confirmed replacement'}`)
  } finally {
    // Helper is done before removing only this isolated fixture, not user data.
    fs.rmSync(root, { recursive: true, force: true })
  }
}

(async () => {
  await exercise(false)
  await exercise(true)
})().catch(error => { console.error(error); process.exit(1) })
