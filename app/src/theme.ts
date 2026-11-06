export type ThemeMode = 'light' | 'dark'

const THEME_STORAGE_KEY = 'lawverify-theme'

function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark'
}

/** 读取用户上次选择的主题；未选择过时回退到亮色主题。 */
export function readStoredTheme(): ThemeMode | null {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    return isThemeMode(stored) ? stored : null
  } catch {
    return null
  }
}

export function getInitialTheme(): ThemeMode {
  return readStoredTheme() ?? 'light'
}

/** 将主题写入 html[data-theme] 并持久化，供 CSS 变量切换。 */
export function applyTheme(theme: ThemeMode): void {
  if (typeof document === 'undefined') {
    return
  }

  document.documentElement.dataset.theme = theme

  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // 存储不可用时仅保留本次会话的主题。
  }
}
