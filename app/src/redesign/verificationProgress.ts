export const VERIFICATION_STEPS = [
  '解析原材料与证据',
  '读取文书与案件材料',
  '抽取声明与争议焦点',
  '匹配案件原材料 L1',
  '匹配法条效力 L2',
  '匹配类案 L3',
  '生成文档与保存结果',
] as const

export function verificationStep(text: string) {
  if (/原材料与证据解析/.test(text)) return 0
  if (/保存|分档|批注/.test(text)) return 6
  if (/案例|类案|裁判规则/.test(text)) return 5
  if (/法条|法律/.test(text)) return 4
  if (/读取|解析|OCR/i.test(text)) return 1
  if (/比对|核对|补齐|证明关系|整理证据/.test(text)) return 3
  if (/声明|抽取|理解|梳理|争议焦点/.test(text)) return 2
  if (/匹配|证据|材料/.test(text)) return 3
  return 1
}

export function verificationRowState(step: number, index: number, done: boolean, stopped: boolean) {
  if (done || step > index) return 'done'
  if (step < index) return 'pending'
  return stopped ? 'stopped' : 'active'
}
