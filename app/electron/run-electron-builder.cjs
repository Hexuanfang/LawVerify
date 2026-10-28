const path = require('node:path')
const { spawnSync } = require('node:child_process')

const appRoot = path.resolve(__dirname, '..')
const cacheRoot = path.join(appRoot, '.cache', 'electron-builder')
const electronBuilderBin = path.join(appRoot, 'node_modules', 'electron-builder', 'cli.js')
const args = process.argv.slice(2)
const requireSignature = process.env.LAWVERIFY_REQUIRE_SIGNATURE === '1' || args.includes('--check-signing')

if (requireSignature) {
  const hasConfiguredCertificate = process.env.WIN_CSC_LINK || process.env.CSC_LINK
  const discovery = !hasConfiguredCertificate && process.env.CSC_IDENTITY_AUTO_DISCOVERY !== 'false'
    ? spawnSync('powershell.exe', ['-NoProfile', '-Command',
      '$certs = @(Get-ChildItem Cert:\\CurrentUser\\My,Cert:\\LocalMachine\\My -CodeSigningCert | Where-Object { $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date) }); if ($certs.Count -eq 0) { exit 1 }'],
    { stdio: 'ignore', windowsHide: true })
    : null
  if (!hasConfiguredCertificate && discovery?.status !== 0) {
    console.error('Signed build requires a valid code-signing certificate. Configure WIN_CSC_LINK or install a code-signing certificate with its private key.')
    process.exit(1)
  }
}
if (args.includes('--check-signing')) process.exit(0)

if (requireSignature) {
  args.push('-c.win.signAndEditExecutable=true', '-c.forceCodeSigning=true')
}

const result = spawnSync(process.execPath, [electronBuilderBin, ...args], {
  cwd: appRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_BUILDER_CACHE: cacheRoot,
  },
})

if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

if (requireSignature) {
  const { version, build } = require('../package.json')
  const outputIndex = args.findIndex((arg) => /^--?(?:c|config)\.directories\.output(?:=|$)/.test(arg))
  const outputArg = args[outputIndex]
  const outputValue = outputArg?.includes('=')
    ? outputArg.slice(outputArg.indexOf('=') + 1)
    : outputIndex >= 0 ? args[outputIndex + 1] : undefined
  const output = path.resolve(appRoot, outputValue || build.directories.output || 'release')
  for (const file of [`LawVerify-Setup-${version}.exe`, 'win-unpacked/LawVerify.exe']) {
    const verified = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, 'inspect-windows-signature.ps1'),
      '-InstallerPath', path.join(output, file), '-RequireValid',
    ], { stdio: 'inherit', windowsHide: true })
    if (verified.status !== 0) process.exit(verified.status ?? 1)
  }
}
