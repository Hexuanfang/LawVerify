import { env } from '../config/env.js';
function normalizeBaseUrl(baseUrl) {
    return baseUrl.replace(/\/$/, '');
}
export function isLlmConfigured() {
    return Boolean(env.LLM_BASE_URL && env.LLM_API_KEY && env.LLM_MODEL);
}
export function getLlmRuntimeStatus() {
    return {
        configured: isLlmConfigured(),
        provider: env.LLM_PROVIDER,
        model: env.LLM_MODEL ?? null,
        baseUrl: env.LLM_BASE_URL ?? null,
        timeoutMs: env.LLM_TIMEOUT_MS,
    };
}
export async function createChatCompletion(options) {
    if (!isLlmConfigured()) {
        throw new Error('LLM 尚未配置，请先设置 LLM_BASE_URL、LLM_API_KEY 与 LLM_MODEL。');
    }
    const response = await fetch(`${normalizeBaseUrl(env.LLM_BASE_URL)}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.LLM_API_KEY}`,
        },
        body: JSON.stringify({
            model: env.LLM_MODEL,
            messages: options.messages,
            temperature: options.temperature ?? 0.1,
            max_tokens: options.maxTokens,
            response_format: options.responseFormat === 'json_object'
                ? { type: 'json_object' }
                : undefined,
            stream: false,
        }),
        signal: AbortSignal.timeout(env.LLM_TIMEOUT_MS),
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`LLM 调用失败（${response.status}）：${detail || response.statusText}`);
    }
    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) {
        throw new Error('LLM 未返回有效内容。');
    }
    return {
        content,
        model: env.LLM_MODEL,
        provider: env.LLM_PROVIDER,
    };
}
export async function* createChatCompletionStream(options) {
    if (!isLlmConfigured()) {
        throw new Error('LLM 尚未配置，请先设置 LLM_BASE_URL、LLM_API_KEY 与 LLM_MODEL。');
    }
    const response = await fetch(`${normalizeBaseUrl(env.LLM_BASE_URL)}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.LLM_API_KEY}`,
        },
        body: JSON.stringify({
            model: env.LLM_MODEL,
            messages: options.messages,
            temperature: options.temperature ?? 0.1,
            max_tokens: options.maxTokens,
            response_format: options.responseFormat === 'json_object'
                ? { type: 'json_object' }
                : undefined,
            stream: true,
        }),
        signal: AbortSignal.timeout(env.LLM_TIMEOUT_MS),
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`LLM 调用失败（${response.status}）：${detail || response.statusText}`);
    }
    if (!response.body) {
        throw new Error('LLM 未返回可读取的流式响应。');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        let separatorIndex = buffer.indexOf('\n\n');
        while (separatorIndex >= 0) {
            const eventBlock = buffer.slice(0, separatorIndex);
            buffer = buffer.slice(separatorIndex + 2);
            const payload = eventBlock
                .split(/\r?\n/)
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trim())
                .join('');
            if (payload === '[DONE]') {
                return;
            }
            if (payload) {
                const chunk = JSON.parse(payload);
                const content = chunk.choices?.[0]?.delta?.content;
                if (content) {
                    yield content;
                }
            }
            separatorIndex = buffer.indexOf('\n\n');
        }
        if (done) {
            break;
        }
    }
}
export async function pingLlm() {
    const startedAt = Date.now();
    const result = await createChatCompletion({
        messages: [
            {
                role: 'system',
                content: '你是法律证据匹配系统的模型联调助手。请简短回复“ok”。',
            },
            {
                role: 'user',
                content: '请回复 ok',
            },
        ],
        maxTokens: 20,
        temperature: 0,
    });
    return {
        ...result,
        latencyMs: Date.now() - startedAt,
    };
}
