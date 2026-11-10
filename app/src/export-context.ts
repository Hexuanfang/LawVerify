import type { CaseFolder, Certificate, Evidence } from './types'

/** 导出时可选的附录与批注开关 */
export interface CertificateExportOptions {
  /** 附录一《证据编号对照表》 */
  evidenceCatalog: boolean
  /** 附录二《段落核验记录》 */
  verificationRecord: boolean
  /** 附录三《AI 辅助与人工核验声明》 */
  declaration: boolean
  /** 使用 Word 真批注；关闭时退化为灰色小字批注行 */
  useWordComments: boolean
}

export const DEFAULT_EXPORT_OPTIONS: CertificateExportOptions = {
  evidenceCatalog: true,
  verificationRecord: true,
  declaration: true,
  useWordComments: true,
}

export interface CertificateExportContext {
  certificate: Certificate
  caseFolder: { id: string; name: string; status: CaseFolder['status'] } | null
  evidences: Array<Pick<Evidence, 'id' | 'number' | 'sourceNumber' | 'name' | 'fileName' | 'type' | 'pages' | 'relativePath'>>
  /** 代理角色：原告 / 被告 */
  roleLabel: string
  /** 软件版本，取自 app/package.json */
  appVersion: string
  exportedAt: Date
  /** 导出人（登录账号） */
  operator?: string
  options: CertificateExportOptions
}

export type { CaseFolder, Certificate, Evidence }
