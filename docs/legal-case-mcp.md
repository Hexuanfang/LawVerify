# 多法源案例检索接入说明

LawVerify 当前已将用户端“AI 交互撰写文书”和“案例参照”共用的案例推荐链路升级为多法源聚合检索，支持：

- 元典 MCP
- 威科先行 MCP
- 北大法宝 MCP

三家案例库会在服务端并行检索，统一归一化后返回到桌面端“案例参照”面板，并继续参与自动绑定、段落引用和文书写作联动。

## 接入位置

核心链路文件：

- `server/src/service.ts`
- `server/src/integrations/yuandian-mcp.ts`
- `server/src/integrations/wk-mcp.ts`
- `server/src/integrations/pkulaw-mcp.ts`
- `server/src/integrations/case-search-mcp-core.ts`
- `app/src/App.tsx`

## 环境变量

在 `server/.env.local` 中按需配置：

```env
# 元典
YUANDIAN_MCP_URL=https://open.chineselaw.com/mcp
YUANDIAN_API_KEY=
YUANDIAN_CASE_SEARCH_TOOL=

# 威科先行
WK_MCP_URL=https://mcp.wkinfo.com.cn/mcp-servers/integrated/
WK_API_KEY=
WK_CASE_SEARCH_TOOL=

# 北大法宝
# 注意：北大法宝必须填写你在开发者控制台里复制的“真实服务 URL”
# 每个已购服务的 URL 都是唯一的，不能直接照搬文档里的占位地址
# 常见形态示例：
# https://apim-gateway.pkulaw.com/你的服务标识
# 某些平台（如 Dify）要求在末尾额外加 /mcp，但服务端直连时请以控制台给出的原始 URL 为准
PKULAW_MCP_URL=
PKULAW_API_KEY=
PKULAW_CASE_SEARCH_TOOL=
```

说明：

- 只配置某一家时，系统只启用该数据源。
- 配置多家时，系统会并行检索并按 `sourceUrl` 或 `案号 + 标题` 去重。
- 任一外部库异常不会阻断整体返回，系统会自动回退到其余外部库和本地案例库。
- 北大法宝接入前，需先在其开发者控制台完成两步：复制已购服务对应的真实 URL，并生成 Token 认证；项目中使用 `Authorization: Bearer <TOKEN>` 方式调用。

## 运行效果

1. 桌面端段落、句组或案件焦点变化时，会请求 `/api/v1/knowledge/recommend/cases`
2. 服务端会汇总多家外部案例库结果
3. 返回结果在“案例参照”面板中显示来源标识
4. 用户点击“查看详情 / 绑定到段落”后，远程案例会落入本地 `knowledgeCases`

## 验证建议

可直接调用：

```http
POST /api/v1/knowledge/recommend/cases
Content-Type: application/json

{
  "caseId": "当前案件ID",
  "paragraphText": "消费者购买健身房预付卡后门店关闭，要求退款及股东承担责任",
  "focus": "预付式消费退款、股东责任、违约责任"
}
```

验证点：

- 返回结果中能看到不同 `sourceType`
- 未配置外部 Key 时，仍能返回本地案例
- 某一家外部库故障时，不影响其他数据源返回
