# 元典 MCP 接入说明

## 官网接入方式

元典官方配置页：`https://open.chineselaw.com/mcp-config/`

官网给出的 MCP 接法是 `Streamable HTTP`：

```json
{
  "mcpServers": {
    "yuandian-open-platform": {
      "type": "http",
      "url": "https://open.chineselaw.com/mcp",
      "headers": {
        "Accept": "application/json, text/event-stream",
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

其中需要替换的只有一项：

- `YOUR_API_KEY`：元典开放平台分配的访问密钥

## 当前项目里的接入位置

本项目已经完成了“案例参照”链路的元典 MCP 接入，主要包括以下几层：

1. 后端 MCP 适配器  
   文件：`server/src/integrations/yuandian-mcp.ts`
   - 按官方要求使用 `https://open.chineselaw.com/mcp`
   - 请求头带上 `Authorization: Bearer ${YUANDIAN_API_KEY}`
   - 先执行 `initialize`
   - 再执行 `notifications/initialized`
   - 之后通过 `tools/list` 获取工具，再调用 `tools/call`

2. 后端案例推荐服务  
   文件：`server/src/service.ts`
   - `recommendKnowledgeCases(...)` 会把本地案例推荐和元典远程推荐合并
   - 若未配置 `YUANDIAN_API_KEY`，则自动退回本地案例库

3. 前端“案例参照”页  
   文件：`app/src/App.tsx`
   - 当前段落、句子或案件焦点变化时，会调用 `/api/v1/knowledge/recommend/cases`
   - 返回结果会直接显示在“推荐案例”区域
   - 用户点击“查看详情 / 绑定到段落”时，远程案例会先落库到本地 `knowledgeCases`

## 环境变量配置

在 `server/.env.local` 中补充以下配置：

```env
YUANDIAN_MCP_URL=https://open.chineselaw.com/mcp
YUANDIAN_API_KEY=你的元典APIKey
# 可选：如果你想固定某个工具名，可以显式指定
YUANDIAN_CASE_SEARCH_TOOL=
```

同时，`server/.env.example` 里也已加入相同占位配置，方便新环境初始化。

## 当前状态判断

当前仓库代码已经具备元典 MCP 接入能力，但本地 `server/.env.local` 尚未配置 `YUANDIAN_API_KEY`，因此运行时不会真正命中元典远程案例，只会显示本地案例推荐。

## 联调验证方法

启动服务后，任选一个案件段落，进入“案例参照”页，观察 `/api/v1/knowledge/recommend/cases` 返回结果：

- 配置了 `YUANDIAN_API_KEY`：
  - 会优先返回元典远程推荐，再与本地案例去重合并
- 未配置 `YUANDIAN_API_KEY`：
  - 仅返回本地 `knowledgeCases`

也可以直接请求后端接口验证：

```bash
POST /api/v1/knowledge/recommend/cases
Content-Type: application/json

{
  "caseId": "当前案件ID",
  "paragraphText": "当前段落文本",
  "focus": "争议焦点"
}
```

## 相关代码文件

- `server/src/integrations/yuandian-mcp.ts`
- `server/src/service.ts`
- `server/src/routes/v1.ts`
- `server/src/config/env.ts`
- `app/src/api.ts`
- `app/src/App.tsx`
