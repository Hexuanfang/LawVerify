import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(currentDir, '..', '..');
for (const fileName of ['.env', '.env.local']) {
    const envPath = path.join(serverRoot, fileName);
    if (!existsSync(envPath)) {
        continue;
    }
    dotenv.config({
        path: envPath,
        override: true,
    });
}
const booleanFromEnv = z
    .union([z.boolean(), z.string()])
    .transform((value) => {
    if (typeof value === 'boolean') {
        return value;
    }
    return value === 'true' || value === '1';
});
const envSchema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(8787),
    CORS_ORIGIN: z.string().default('http://127.0.0.1:5173,http://localhost:5173'),
    JSON_LIMIT: z.string().default('100mb'),
    APP_NAME: z.string().default('lawverify-server'),
    API_PREFIX: z.string().default('/api'),
    API_V1_PREFIX: z.string().default('/api/v1'),
    KNOWLEDGE_RAG_MODE: z.enum(['local', 'commercial', 'auto']).default('local'),
    DATABASE_URL: z.string().optional(),
    JWT_SECRET: z.string().default('lawverify-dev-secret'),
    JWT_EXPIRES_IN: z.string().default('12h'),
    STORAGE_DRIVER: z.enum(['local']).default('local'),
    STORAGE_LOCAL_ROOT: z.string().default('storage'),
    STORAGE_PUBLIC_BASE_URL: z.string().default('/uploads'),
    APP_RUNTIME_ROOT: z.string().optional(),
    APP_DATA_ROOT: z.string().optional(),
    WORKSPACE_DATA_DIR: z.string().optional(),
    FRONTEND_DIST_DIR: z.string().optional(),
    MIGRATIONS_DIR: z.string().optional(),
    AUTO_RUN_MIGRATIONS: booleanFromEnv.default(false),
    APP_PUBLIC_BASE_URL: z.string().default('http://localhost:8787'),
    CLOUD_API_BASE_URL: z.string().optional(),
    LLM_PROVIDER: z.enum(['deepseek', 'openai-compatible']).default('deepseek'),
    LLM_BASE_URL: z.string().optional(),
    LLM_API_KEY: z.string().optional(),
    LLM_MODEL: z.string().optional(),
    LLM_VISION_BASE_URL: z.string().optional(),
    LLM_VISION_API_KEY: z.string().optional(),
    LLM_VISION_MODEL: z.string().optional(),
    LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
    EMBEDDING_PROVIDER: z.enum(['openai-compatible']).default('openai-compatible'),
    EMBEDDING_BASE_URL: z.string().optional(),
    EMBEDDING_API_KEY: z.string().optional(),
    EMBEDDING_MODEL: z.string().optional(),
    EMBEDDING_DIMENSION: z.coerce.number().int().positive().optional(),
    EMBEDDING_BATCH_SIZE: z.coerce.number().int().positive().default(16),
    EMBEDDING_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
    QDRANT_URL: z.string().optional(),
    QDRANT_API_KEY: z.string().optional(),
    QDRANT_COLLECTION_KNOWLEDGE: z.string().default('knowledge_chunks'),
    QDRANT_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
    YUANDIAN_MCP_URL: z.string().default('https://open.chineselaw.com/mcp'),
    YUANDIAN_API_KEY: z.string().optional(),
    YUANDIAN_CASE_SEARCH_TOOL: z.string().optional(),
    WK_MCP_URL: z.string().default('https://mcp.wkinfo.com.cn/mcp-servers/integrated/'),
    WK_API_KEY: z.string().optional(),
    WK_CASE_SEARCH_TOOL: z.string().optional(),
    PKULAW_MCP_URL: z.string().optional(),
    PKULAW_API_KEY: z.string().optional(),
    PKULAW_CASE_SEARCH_TOOL: z.string().optional(),
    ALIPAY_APP_ID: z.string().optional(),
    ALIPAY_PRIVATE_KEY: z.string().optional(),
    ALIPAY_PUBLIC_KEY: z.string().optional(),
    ALIPAY_GATEWAY: z.string().default('https://openapi.alipay.com/gateway.do'),
    ALIPAY_NOTIFY_URL: z.string().optional(),
    WECHAT_PAY_APP_ID: z.string().optional(),
    WECHAT_PAY_MCH_ID: z.string().optional(),
    WECHAT_PAY_PRIVATE_KEY: z.string().optional(),
    WECHAT_PAY_SERIAL_NO: z.string().optional(),
    WECHAT_PAY_API_V3_KEY: z.string().optional(),
    WECHAT_PAY_NOTIFY_URL: z.string().optional(),
    WECHAT_PAY_API_BASE: z.string().default('https://api.mch.weixin.qq.com'),
    COLLABORA_PUBLIC_URL: z.string().optional(),
    COLLABORA_PROXY_PATH: z.string().default('/collabora'),
    COLLABORA_PROXY_TARGET: z.string().default('http://127.0.0.1:9980'),
    COLLABORA_WOPI_ALLOW_EDIT: booleanFromEnv.default(true),
});
const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`环境变量配置无效：${issues}`);
}
export const env = {
    ...parsed.data,
    corsOrigins: parsed.data.CORS_ORIGIN.split(',').map((item) => item.trim()).filter(Boolean),
};
