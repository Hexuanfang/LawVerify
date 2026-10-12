# 律师证据质证助手架构设计

## 1. 当前定位

项目已从单纯 MVP 原型，升级为“可向商用系统演进的模块化单体”。

当前策略不是一次性拆成大量微服务，而是先构建稳定、可测试、可演进的后端骨架：

- 保留现有前端可运行能力
- 保留现有 `/api` 兼容接口
- 新增 `/api/v1` 版本化接口
- 在后端内部引入统一配置、请求上下文、错误处理和安全中间件

## 2. 当前目录结构

```text
lawVerify/
├─ app/
│  ├─ electron/
│  └─ src/
├─ server/
│  ├─ src/
│  │  ├─ app.ts
│  │  ├─ index.ts
│  │  ├─ config/
│  │  │  └─ env.ts
│  │  ├─ core/
│  │  │  ├─ api-response.ts
│  │  │  └─ app-error.ts
│  │  ├─ middleware/
│  │  │  ├─ error-handler.ts
│  │  │  └─ request-context.ts
│  │  ├─ routes/
│  │  │  ├─ legacy.ts
│  │  │  └─ v1.ts
│  │  ├─ service.ts
│  │  ├─ store.ts
│  │  ├─ seed.ts
│  │  └─ domain.ts
│  └─ data/
└─ docs/
   ├─ architecture.md
   └─ commercial-platform-blueprint.md
```

## 3. 当前后端分层

### 3.1 接入层

- `index.ts`：服务启动入口
- `app.ts`：Express 应用装配、统一中间件、路由挂载

### 3.2 配置层

- `config/env.ts`：环境变量解析与默认值收敛

### 3.3 核心能力层

- `core/app-error.ts`：统一业务异常模型
- `core/api-response.ts`：统一成功响应结构

### 3.4 中间件层

- `request-context.ts`：注入 request id，便于审计与排障
- `error-handler.ts`：统一错误输出

### 3.5 路由层

- `routes/legacy.ts`：兼容现有前端的旧接口
- `routes/v1.ts`：面向商用演进的新接口版本

### 3.6 业务层

- `service.ts`：案件、证据、质证书、积分等核心业务逻辑

### 3.7 持久化层

- `store.ts`：当前仍为 JSON 文件存储，后续替换为 PostgreSQL

## 4. 接口策略

### 4.1 兼容接口

- 前端当前继续使用 `/api/*`
- 保证现有 Web / Electron 流程不被新架构打断

### 4.2 版本化接口

- 新增 `/api/v1/*`
- 采用统一响应结构：

```json
{
  "success": true,
  "requestId": "uuid",
  "data": {},
  "meta": {}
}
```

这为后续的 SDK、管理后台、OpenAPI 文档和多客户端接入打基础。

## 5. 当前能力边界

已具备：

- 登录样机
- 商用注册 / 登录 / 当前用户接口
- 组织与成员管理接口
- RBAC 权限中间件
- PostgreSQL 迁移脚本与数据表模型
- 文件上传与对象存储抽象
- 审计日志查询与记录
- 案件管理
- 证据管理
- 质证书生成
- 左文稿右原件的核验工作台
- 多格式证据源预览

尚未正式商用化：

- 正式认证体系
- 组织/租户/RBAC
- PostgreSQL
- 对象存储
- OCR 与 LLM 生产链路
- 支付与订阅
- 审计日志持久化

## 6. 演进路径

### 阶段一：商用基础设施

- PostgreSQL
- 用户与组织模型
- JWT / Session
- 审计日志

### 阶段二：内容处理能力

- 文件上传与对象存储
- OCR 队列
- 文档转码与预览
- LLM EvidenceLink 生成

### 阶段三：商业化与治理

- 套餐、订单、订阅
- 权限治理
- 监控告警
- 私有化部署

## 7. 架构原则

1. 先模块化单体，再按边界拆服务
2. 先保兼容，再做迁移
3. UI 继续面向律师业务，不暴露研发过程
4. 文档工作台与证据查看器是平台核心，不退化成普通后台页面
