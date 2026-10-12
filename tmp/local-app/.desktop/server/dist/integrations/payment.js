import { createCipheriv, createHash, createPrivateKey, createSign, randomBytes } from 'node:crypto';
import { AppError } from '../core/app-error.js';
import { env } from '../config/env.js';
function normalizePemBlock(value, label) {
    const text = value?.trim();
    if (!text) {
        return '';
    }
    const normalized = text.replace(/\\n/g, '\n').trim();
    if (normalized.includes('BEGIN')) {
        return normalized;
    }
    const wrapped = normalized.match(/.{1,64}/g)?.join('\n') ?? normalized;
    return `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----`;
}
function ensureHttpsUrl(value) {
    const text = value?.trim();
    if (!text) {
        return '';
    }
    try {
        const parsed = new URL(text);
        return parsed.protocol === 'https:' ? parsed.toString() : '';
    }
    catch {
        return '';
    }
}
function formatFenToYuan(amountFen) {
    return (amountFen / 100).toFixed(2);
}
function createNonce(size = 16) {
    return randomBytes(size).toString('hex');
}
function signWithPrivateKey(content, privateKeyPem) {
    const signer = createSign('RSA-SHA256');
    signer.update(content, 'utf8');
    signer.end();
    return signer.sign(createPrivateKey(privateKeyPem), 'base64');
}
function alipayConfigured() {
    return Boolean(env.ALIPAY_APP_ID?.trim()
        && normalizePemBlock(env.ALIPAY_PRIVATE_KEY, 'PRIVATE KEY')
        && normalizePemBlock(env.ALIPAY_PUBLIC_KEY, 'PUBLIC KEY'));
}
function wechatConfigured() {
    return Boolean(env.WECHAT_PAY_APP_ID?.trim()
        && env.WECHAT_PAY_MCH_ID?.trim()
        && env.WECHAT_PAY_SERIAL_NO?.trim()
        && normalizePemBlock(env.WECHAT_PAY_PRIVATE_KEY, 'PRIVATE KEY')
        && env.WECHAT_PAY_NOTIFY_URL?.trim()
        && env.WECHAT_PAY_API_V3_KEY?.trim().length === 32);
}
export function getPaymentProviderStatuses() {
    return [
        {
            id: 'alipay',
            label: '支付宝',
            enabled: alipayConfigured(),
            reason: alipayConfigured() ? undefined : '支付宝支付参数未配置完整。',
        },
        {
            id: 'wechat',
            label: '微信支付',
            enabled: wechatConfigured(),
            reason: wechatConfigured() ? undefined : '微信支付参数未配置完整，且微信 Native 需配置可访问的 HTTPS 通知地址。',
        },
    ];
}
function buildAlipaySignedParams(method, bizContent) {
    const privateKey = normalizePemBlock(env.ALIPAY_PRIVATE_KEY, 'PRIVATE KEY');
    if (!env.ALIPAY_APP_ID?.trim() || !privateKey) {
        throw new AppError('支付宝支付参数未配置完整。', 400, 'ALIPAY_NOT_CONFIGURED');
    }
    const params = {
        app_id: env.ALIPAY_APP_ID.trim(),
        method,
        charset: 'utf-8',
        sign_type: 'RSA2',
        timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
        version: '1.0',
        biz_content: JSON.stringify(bizContent),
    };
    const notifyUrl = ensureHttpsUrl(env.ALIPAY_NOTIFY_URL);
    if (notifyUrl) {
        params.notify_url = notifyUrl;
    }
    const signContent = Object.keys(params)
        .sort()
        .map((key) => `${key}=${params[key]}`)
        .join('&');
    params.sign = signWithPrivateKey(signContent, privateKey);
    return params;
}
async function postAlipay(method, bizContent) {
    const gateway = env.ALIPAY_GATEWAY?.trim() || 'https://openapi.alipay.com/gateway.do';
    const params = buildAlipaySignedParams(method, bizContent);
    const body = new URLSearchParams(params);
    const response = await fetch(gateway, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
        },
        body,
    });
    if (!response.ok) {
        throw new AppError(`支付宝网关请求失败：${response.status}`, 502, 'ALIPAY_GATEWAY_ERROR');
    }
    return response.json();
}
async function createAlipayRechargeOrder(input) {
    const payload = await postAlipay('alipay.trade.precreate', {
        out_trade_no: input.outTradeNo,
        total_amount: formatFenToYuan(input.amountFen),
        subject: input.title,
        body: input.description,
    });
    const response = payload.alipay_trade_precreate_response;
    if (!response) {
        throw new AppError('支付宝返回数据异常。', 502, 'ALIPAY_INVALID_RESPONSE');
    }
    const code = typeof response.code === 'string' ? response.code : '';
    if (code !== '10000') {
        const message = typeof response.sub_msg === 'string'
            ? response.sub_msg
            : typeof response.msg === 'string'
                ? response.msg
                : '支付宝预下单失败。';
        throw new AppError(message, 502, 'ALIPAY_PRECREATE_FAILED');
    }
    const qrCodeContent = typeof response.qr_code === 'string' ? response.qr_code.trim() : '';
    if (!qrCodeContent) {
        throw new AppError('支付宝未返回扫码地址。', 502, 'ALIPAY_QR_MISSING');
    }
    return {
        providerOrderId: typeof response.out_trade_no === 'string' ? response.out_trade_no : input.outTradeNo,
        qrCodeContent,
        paymentUrl: qrCodeContent,
        providerMessage: typeof response.msg === 'string' ? response.msg : '等待支付',
    };
}
async function queryAlipayRechargeOrder(outTradeNo) {
    const payload = await postAlipay('alipay.trade.query', {
        out_trade_no: outTradeNo,
    });
    const response = payload.alipay_trade_query_response;
    if (!response) {
        throw new AppError('支付宝查询返回异常。', 502, 'ALIPAY_QUERY_INVALID_RESPONSE');
    }
    const code = typeof response.code === 'string' ? response.code : '';
    if (code !== '10000' && code !== '40004') {
        const message = typeof response.sub_msg === 'string'
            ? response.sub_msg
            : typeof response.msg === 'string'
                ? response.msg
                : '支付宝订单查询失败。';
        throw new AppError(message, 502, 'ALIPAY_QUERY_FAILED');
    }
    const tradeStatus = typeof response.trade_status === 'string' ? response.trade_status : '';
    if (tradeStatus === 'TRADE_SUCCESS' || tradeStatus === 'TRADE_FINISHED') {
        return {
            status: 'paid',
            providerOrderId: typeof response.trade_no === 'string' ? response.trade_no : undefined,
            providerMessage: tradeStatus,
            paidAt: typeof response.send_pay_date === 'string'
                ? new Date(response.send_pay_date.replace(' ', 'T')).toISOString()
                : new Date().toISOString(),
        };
    }
    if (tradeStatus === 'WAIT_BUYER_PAY' || code === '40004') {
        return {
            status: 'pending',
            providerOrderId: typeof response.trade_no === 'string' ? response.trade_no : undefined,
            providerMessage: tradeStatus || 'WAIT_BUYER_PAY',
        };
    }
    if (tradeStatus === 'TRADE_CLOSED') {
        return {
            status: 'closed',
            providerOrderId: typeof response.trade_no === 'string' ? response.trade_no : undefined,
            providerMessage: tradeStatus,
        };
    }
    return {
        status: 'failed',
        providerOrderId: typeof response.trade_no === 'string' ? response.trade_no : undefined,
        providerMessage: tradeStatus || 'UNKNOWN',
    };
}
function buildWechatAuthorization(method, requestPath, body) {
    const mchId = env.WECHAT_PAY_MCH_ID?.trim();
    const serialNo = env.WECHAT_PAY_SERIAL_NO?.trim();
    const privateKey = normalizePemBlock(env.WECHAT_PAY_PRIVATE_KEY, 'PRIVATE KEY');
    if (!mchId || !serialNo || !privateKey) {
        throw new AppError('微信支付参数未配置完整。', 400, 'WECHAT_PAY_NOT_CONFIGURED');
    }
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = createNonce();
    const message = `${method}\n${requestPath}\n${timestamp}\n${nonce}\n${body}\n`;
    const signature = signWithPrivateKey(message, privateKey);
    return {
        authorization: `WECHATPAY2-SHA256-RSA2048 mchid="${mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${serialNo}"`,
        timestamp,
        nonce,
    };
}
async function callWechatApi(method, requestPath, body) {
    const baseUrl = env.WECHAT_PAY_API_BASE?.trim() || 'https://api.mch.weixin.qq.com';
    const requestBody = method === 'POST' ? JSON.stringify(body ?? {}) : '';
    const { authorization } = buildWechatAuthorization(method, requestPath, requestBody);
    const response = await fetch(`${baseUrl}${requestPath}`, {
        method,
        headers: {
            Accept: 'application/json',
            Authorization: authorization,
            'Content-Type': 'application/json',
            'User-Agent': 'LawVerify/desktop',
        },
        body: method === 'POST' ? requestBody : undefined,
    });
    const text = await response.text();
    if (!response.ok) {
        throw new AppError(text || `微信支付网关请求失败：${response.status}`, 502, 'WECHAT_GATEWAY_ERROR');
    }
    return (text ? JSON.parse(text) : {});
}
async function createWechatRechargeOrder(input) {
    const appId = env.WECHAT_PAY_APP_ID?.trim();
    const mchId = env.WECHAT_PAY_MCH_ID?.trim();
    const notifyUrl = ensureHttpsUrl(env.WECHAT_PAY_NOTIFY_URL);
    if (!appId || !mchId || !notifyUrl) {
        throw new AppError('微信支付参数未配置完整，需提供可访问的 HTTPS 通知地址。', 400, 'WECHAT_PAY_NOT_CONFIGURED');
    }
    const payload = await callWechatApi('POST', '/v3/pay/transactions/native', {
        appid: appId,
        mchid: mchId,
        description: input.description,
        out_trade_no: input.outTradeNo,
        notify_url: notifyUrl,
        time_expire: new Date(Date.now() + 1000 * 60 * 30).toISOString().replace(/\.\d{3}Z$/, '+08:00'),
        amount: {
            total: input.amountFen,
            currency: 'CNY',
        },
    });
    if (!payload.code_url?.trim()) {
        throw new AppError('微信支付未返回扫码地址。', 502, 'WECHAT_QR_MISSING');
    }
    return {
        providerOrderId: payload.prepay_id?.trim(),
        qrCodeContent: payload.code_url.trim(),
        paymentUrl: payload.code_url.trim(),
        providerMessage: '等待支付',
    };
}
async function queryWechatRechargeOrder(outTradeNo) {
    const mchId = env.WECHAT_PAY_MCH_ID?.trim();
    if (!mchId) {
        throw new AppError('微信支付参数未配置完整。', 400, 'WECHAT_PAY_NOT_CONFIGURED');
    }
    const requestPath = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(mchId)}`;
    const payload = await callWechatApi('GET', requestPath);
    const tradeState = payload.trade_state?.trim() || '';
    if (tradeState === 'SUCCESS') {
        return {
            status: 'paid',
            providerOrderId: payload.transaction_id?.trim(),
            providerMessage: tradeState,
            paidAt: payload.success_time?.trim() || new Date().toISOString(),
        };
    }
    if (tradeState === 'NOTPAY' || !tradeState) {
        return {
            status: 'pending',
            providerOrderId: payload.transaction_id?.trim(),
            providerMessage: tradeState || 'NOTPAY',
        };
    }
    if (tradeState === 'CLOSED' || tradeState === 'REVOKED') {
        return {
            status: 'closed',
            providerOrderId: payload.transaction_id?.trim(),
            providerMessage: tradeState,
        };
    }
    return {
        status: 'failed',
        providerOrderId: payload.transaction_id?.trim(),
        providerMessage: tradeState || 'PAYERROR',
    };
}
export async function createGatewayRechargeOrder(channel, input) {
    if (channel === 'alipay') {
        return createAlipayRechargeOrder(input);
    }
    return createWechatRechargeOrder(input);
}
export async function queryGatewayRechargeOrder(channel, outTradeNo) {
    if (channel === 'alipay') {
        return queryAlipayRechargeOrder(outTradeNo);
    }
    return queryWechatRechargeOrder(outTradeNo);
}
export function encryptWechatCallbackResource(plaintext) {
    const apiV3Key = env.WECHAT_PAY_API_V3_KEY?.trim();
    if (!apiV3Key || apiV3Key.length !== 32) {
        throw new AppError('微信支付 API v3 Key 未配置完整。', 400, 'WECHAT_PAY_NOT_CONFIGURED');
    }
    const nonce = createNonce(12);
    const associatedData = createHash('sha1').update(plaintext).digest('hex').slice(0, 16);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(apiV3Key, 'utf8'), Buffer.from(nonce, 'utf8'));
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
        nonce,
        associatedData,
        ciphertext: Buffer.concat([encrypted, tag]).toString('base64'),
    };
}
