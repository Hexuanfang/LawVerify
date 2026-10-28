import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { z } from 'zod'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const cloudServerRoot = path.resolve(currentDir, '..')

for (const fileName of ['.env', '.env.local']) {
  const envPath = path.join(cloudServerRoot, fileName)
  if (!existsSync(envPath)) {
    continue
  }

  dotenv.config({
    path: envPath,
    override: true,
  })
}

const booleanFromEnv = z
  .union([z.boolean(), z.string()])
  .transform((value) => {
    if (typeof value === 'boolean') {
      return value
    }

    return value === 'true' || value === '1'
  })

const schema = z.object({
  CLOUD_PORT: z.coerce.number().int().positive().default(8788),
  CLOUD_HOST: z.string().default('0.0.0.0'),
  CLOUD_APP_NAME: z.string().default('LawVerify Cloud'),
  CLOUD_WEB_ORIGIN: z.string().default('http://127.0.0.1:4273,http://localhost:4273,https://lawagent.zhijing.fun'),
  CLOUD_PUBLIC_BASE_URL: z.string().default('https://lawagent.zhijing.fun'),
  RELEASE_DOWNLOAD_BASE_URL: z.string().url().startsWith('https://').optional(),
  ADMIN_EMAILS: z.string().default('admin,972167580@qq.com'),
  JSON_LIMIT: z.string().default('2mb'),
  DATABASE_URL: z.string().optional(),
  AUTO_RUN_MIGRATIONS: booleanFromEnv.default(false),
  MIGRATIONS_DIR: z.string().optional(),
  DEV_PAYMENT_SIMULATION: booleanFromEnv.default(false),
  AI_GATEWAY_ENABLED: booleanFromEnv.default(false),
  LLM_BASE_URL: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().optional(),
  LLM_VISION_BASE_URL: z.string().optional(),
  LLM_VISION_API_KEY: z.string().optional(),
  LLM_VISION_MODEL: z.string().optional(),
  LLM_TIMEOUT_MS: z.coerce.number().positive().default(120000),
  EMBEDDING_BASE_URL: z.string().optional(),
  EMBEDDING_API_KEY: z.string().optional(),
  EMBEDDING_MODEL: z.string().optional(),
  EMBEDDING_DIMENSION: z.coerce.number().int().positive().default(1024),
  YUANDIAN_API_KEY: z.string().optional(),
  YUANDIAN_MCP_URL: z.string().default('https://open.chineselaw.com/mcp'),
  WK_API_KEY: z.string().optional(),
  WK_MCP_URL: z.string().default('https://mcp.wkinfo.com.cn/mcp-servers/integrated/'),
  PKULAW_API_KEY: z.string().optional(),
  PKULAW_MCP_URL: z.string().optional(),
  JWT_SECRET: z.string().default('lawverify-cloud-dev-secret'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  ALIPAY_APP_ID: z.string().optional(),
  ALIPAY_PRIVATE_KEY: z.string().optional(),
  ALIPAY_PUBLIC_KEY: z.string().optional(),
  ALIPAY_GATEWAY: z.string().default('https://openapi.alipay.com/gateway.do'),
  ALIPAY_NOTIFY_URL: z.string().optional(),
  WECHAT_PAY_APP_ID: z.string().optional(),
  WECHAT_PAY_MCH_ID: z.string().optional(),
  WECHAT_PAY_PRIVATE_KEY: z.string().optional(),
  WECHAT_PAY_SERIAL_NO: z.string().optional(),
  WECHAT_PAY_PLATFORM_SERIAL_NO: z.string().optional(),
  WECHAT_PAY_PLATFORM_PUBLIC_KEY: z.string().optional(),
  WECHAT_PAY_API_V3_KEY: z.string().optional(),
  WECHAT_PAY_NOTIFY_URL: z.string().optional(),
  WECHAT_PAY_API_BASE: z.string().default('https://api.mch.weixin.qq.com'),
})

const parsed = schema.parse(process.env)
const corsOrigins = parsed.CLOUD_WEB_ORIGIN.split(',').map((item) => item.trim()).filter(Boolean)

export const config = {
  ...parsed,
  cloudServerRoot,
  corsOrigins,
  primaryWebOrigin: corsOrigins[0] ?? 'http://127.0.0.1:4273',
}
