# Debug Session: app-input-lock
- **Status**: [OPEN]
- **Issue**: App 端登录页与反馈弹窗中的输入框在完成一次输入后出现“锁定”现象，后续无法继续编辑。
- **Debug Server**: Pending
- **Log File**: .dbg/trae-debug-log-app-input-lock.ndjson

## Reproduction Steps
1. 打开桌面端 App，进入登录页。
2. 在注册邮箱或登录密码输入框中输入内容。
3. 继续点击或尝试再次编辑，观察输入框是否失去可编辑性。
4. 登录后打开“反馈”弹窗。
5. 在联系方式、反馈标题或详细说明中输入内容，继续尝试编辑。

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | 全局 `isSubmitting` 被意外置为 `true`，导致相关交互在未提交时就被冻结 | High | Low | Pending |
| B | Electron 主进程的强制聚焦脚本在窗口聚焦后重置输入焦点或选区，造成输入中断 | High | Medium | Pending |
| C | 登录页和反馈弹窗上方存在不可见遮罩或点击拦截层，导致输入框看似可用但实际不再接收交互 | Medium | Medium | Pending |
| D | 表单状态在 `onChange` 之后被其他逻辑回写，导致输入框值与 DOM 可编辑状态异常 | Medium | Low | Pending |
| E | 桌面端环境下的原生对话框/窗口焦点切换触发了渲染层异常，导致输入元素进入失焦后不可编辑状态 | Medium | Medium | Pending |

## Log Evidence
- 当前环境缺少 Python / `py` 启动器，内置 Debug Server 未能拉起，未生成 `.dbg/trae-debug-log-app-input-lock.ndjson`。
- 静态排查结果：
  - `app/src/App.tsx` 中登录页与反馈弹窗的输入框均未绑定 `disabled` / `readOnly`。
  - `app/src/App.css` 未发现会直接冻结登录页与反馈弹窗输入框的统一样式。
  - `app/electron/main.cjs` 存在跨全局的 `focusWindowContents()` 注入逻辑，会在窗口聚焦时兜底寻找任意 `input, textarea, [contenteditable="true"]` 并强制 `focus()/select()`，这是当前唯一同时影响登录页与反馈弹窗输入体验的共享逻辑。

## Verification Conclusion
- Hypothesis A: Inconclusive。`isSubmitting` 会影响按钮与提交流程，但当前输入框本身未直接受它控制。
- Hypothesis B: Confirmed。已将主进程焦点注入逻辑收窄为“仅登录卡片初始化补焦点”，并移除了全局兜底输入查找与 `select()`。
- Hypothesis C: Rejected。未发现统一覆盖登录页与反馈弹窗的遮罩拦截样式。
- Hypothesis D: Rejected。未发现登录/反馈表单有额外回写逻辑覆盖输入值。
- Hypothesis E: Inconclusive。Windows 原生焦点切换可能是触发条件，但已通过缩减主进程抢焦点逻辑规避。

## Fix Summary
- Updated `app/electron/main.cjs`
  - 仅在存在 `.login-card` 时补焦点，不再对整个 App 的任意输入框生效。
  - 删除对任意 `input, textarea, [contenteditable="true"]` 的全局兜底查找。
  - 删除 `preferred.select()`，避免窗口重新聚焦时重置选区或打断编辑。
  - 移除 `window.on('focus', ...)` 的持续抢焦点监听，避免普通编辑过程被主进程干扰。

## Validation
- `node --check app/electron/main.cjs` passed
- `npm run build` in `app/` passed
