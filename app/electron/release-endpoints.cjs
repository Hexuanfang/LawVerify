const config = require('./release-endpoints.json')

function loadReleaseEndpoints() {
  const value = config.loginBaseUrl
  const address = typeof value === 'string' ? value.trim() : ''
  const url = URL.parse(address)
  if (!url || /[\s\\?#]/.test(address) || url.username || url.password
    || url.protocol !== 'https:' || url.pathname !== '/') {
    throw new Error('发布配置中的登录地址（loginBaseUrl）无效，请填写不含凭据、查询参数或片段的 HTTPS 源地址。')
  }
  return { loginBaseUrl: url.origin }
}

module.exports = { loadReleaseEndpoints }
