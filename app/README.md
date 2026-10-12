# 律师证据质证助手

当前版本已升级为前后端分离架构：

- `app/`：前端 Web 工作台 + Electron 客户端
- `server/`：后端 API 服务
- `docs/architecture.md`：系统架构说明

## 已实现能力

1. 专业登录页与工作台布局
2. 案件文件夹管理
3. 证据导入、OCR 占位文本、人工修订
4. AI 质证书生成与积分扣减
5. 左右分屏核验、批注、重绑、解绑
6. Word / PDF 导出
7. Express 后端接口与文件持久化
8. Electron 客户端壳层

## 启动方式

先安装依赖：

```bash
cd server
npm install

cd ../app
npm install
```

启动前后端联调：

```bash
cd app
npm run dev:stack
```

启动前后端 + Electron：

```bash
cd app
npm run dev:desktop
```

单独启动前端：

```bash
cd app
npm run dev:web
```

单独启动后端：

```bash
cd server
npm run dev
```

## 架构说明

详见：

- [系统架构文档](file:///d:/trae_projects/lexVerify/docs/architecture.md)
- [Windows 安装包签名说明](file:///d:/trae_projects/lexVerify/docs/windows-code-signing.md)

## 下一步建议

1. 将后端持久化从 JSON 文件升级为数据库
2. 接入真实 OCR / 文档解析能力
3. 接入 LLM 输出 EvidenceLink
4. 接入对象存储保存原始证据文件
5. 接入正式账号与权限系统
