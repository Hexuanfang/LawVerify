export const caseRoleLabels = {
  plaintiff: '原告',
  defendant: '被告',
  third_party: '第三人',
  applicant: '申请人',
  respondent: '被申请人',
  other: '其他',
} as const

export type CaseRole = keyof typeof caseRoleLabels
export const caseRoles = Object.keys(caseRoleLabels) as CaseRole[]
