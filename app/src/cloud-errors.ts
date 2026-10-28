export function cloudErrorMessage(status: number, message?: string) {
  if ([502, 503, 504, 520, 521, 522, 523, 524, 530].includes(status)) {
    return 'LawVerify 账户服务暂时不可用，请稍后重试。已保存的本地材料不受影响。'
  }
  if (message?.trim()) return message
  if (status === 401) return '登录状态已失效，请重新登录。'
  if (status === 403) return '当前账户无权执行此操作。'
  if (status === 429) return '操作过于频繁，请稍后重试。'
  if (status >= 500) return 'LawVerify 账户服务暂时异常，请稍后重试。'
  return '账户操作未能完成，请稍后重试。'
}
