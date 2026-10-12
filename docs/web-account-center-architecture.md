# LawVerify 平台官网与账户中心一体化方案

## 1. 目标定位

LawVerify 采用：

- `EXE 桌面端` 负责案件、证据、文书、知识库工作台
- `官网 Web` 负责品牌展示、下载入口、价格套餐、帮助中心
- `账户中心` 作为官网登录后的子模块，统一承接充值、订单、使用情况、发票、账户资料
- `云端服务` 负责账号、支付、订单、积分、发票、下载分发、使用统计

本地联调约定：

- `LawVerify 平台官网 / 账户中心` 默认使用 `http://127.0.0.1:4273`
- `公司官网` 应保持独立域名或独立端口，不与平台站点复用本地入口

最终产品形态对齐成熟 SaaS：

- 官网是统一入口
- 账户中心不是独立站，而是官网中的登录后模块
- 桌面端只负责业务体验，不承担正式支付与回调

## 2. 信息架构

### 2.1 官网前台

- 首页
- 产品介绍
- 价格套餐
- 下载中心
- 帮助文档
- 关于我们 / 联系我们

### 2.2 官网中的账户中心

- 控制台首页
- 充值与套餐购买
- 订单记录
- 使用情况
- 发票管理
- 账户资料
- 企业信息

### 2.3 内部运营后台

- 用户管理
- 订单管理
- 套餐管理
- 发票审核
- 对账与异常单
- 下载版本管理

## 3. 建议路由设计

```text
/
/product
/pricing
/download
/docs
/about
/contact
/login
/register

/console
/console/billing
/console/orders
/console/usage
/console/invoices
/console/profile
/console/company
/console/downloads

/admin
/admin/users
/admin/orders
/admin/plans
/admin/invoices
/admin/releases
```

说明：

- 未登录用户访问 `console/*` 时跳转登录
- EXE 点击“充值入口”时，直接打开 `https://{domain}/console/billing`
- EXE 点击“查看订单”时，直接打开 `https://{domain}/console/orders`

## 4. 页面清单

## 4.1 官网首页

目标：

- 讲清产品价值
- 提供下载安装入口
- 引导登录 / 注册 / 购买

核心模块：

- 顶部导航
- Hero 区域
- 核心能力介绍
- 律师工作流场景展示
- 价格套餐入口
- 下载入口
- 常见问题
- 页脚

## 4.2 价格套餐页

目标：

- 清晰展示个人版 / 专业版 / 团队版
- 说明积分、权益、支持范围
- 引导立即购买

展示内容：

- 套餐名称
- 月付 / 年付
- 积分额度或调用额度
- 是否含企业功能
- 是否支持发票
- 是否支持团队席位

## 4.3 下载中心

目标：

- 提供 Windows 安装包下载
- 展示版本信息与更新日志

展示内容：

- 最新稳定版
- 历史版本
- 文件大小
- 更新时间
- SHA256 校验值
- 更新说明

## 4.4 账户中心首页

目标：

- 给用户一个账户总览

展示内容：

- 当前套餐
- 积分余额
- 最近使用量
- 最近订单
- 最近发票状态
- 下载客户端入口

## 4.5 充值与套餐购买页

目标：

- 购买套餐
- 续费
- 积分充值

展示内容：

- 当前权益
- 套餐卡片
- 支付方式选择
- 待支付订单
- 最近充值记录

行为：

- 创建支付宝 / 微信订单
- 展示二维码或跳转支付页
- 支付成功后更新账户权益与积分

## 4.6 订单记录页

目标：

- 查看完整购买记录

展示内容：

- 订单号
- 订单类型
- 套餐名称
- 支付方式
- 金额
- 积分
- 状态
- 创建时间
- 支付时间
- 发票状态

行为：

- 查看订单详情
- 查看支付状态
- 申请开票

## 4.7 使用情况页

目标：

- 让用户清楚知道积分去了哪里、权益还剩多少

展示内容：

- 当前积分余额
- 套餐有效期
- 时间范围内消耗统计
- 按功能分类的消耗统计
- 最近积分流水

可选增强：

- 区分“文书生成”“证据理解”“知识库关联”等消耗类型

## 4.8 发票管理页

目标：

- 支撑正式商业交付

展示内容：

- 发票抬头
- 纳税人识别号
- 开票金额
- 申请状态
- 发票类型
- 发票文件下载

行为：

- 新增 / 编辑开票主体
- 提交开票申请
- 下载电子发票

## 4.9 账户资料页

展示内容：

- 姓名
- 手机号
- 邮箱
- 密码修改
- 登录设备
- 安全设置

## 4.10 企业信息页

展示内容：

- 企业名称
- 纳税人识别号
- 联系人
- 联系电话
- 开票地址
- 银行信息

## 5. 桌面端与官网联动

## 5.1 EXE 负责什么

- 登录桌面工作台
- 显示当前用户昵称、积分、套餐权益
- 在本地执行业务作业
- 必要时跳转到官网账户中心

## 5.2 EXE 不负责什么

- 不负责正式支付
- 不接支付回调
- 不处理发票
- 不作为订单中心

## 5.3 建议联动方式

### 充值入口

- EXE 打开浏览器访问：
  - `/console/billing`

### 订单入口

- EXE 打开浏览器访问：
  - `/console/orders`

### 账户刷新

- 支付成功后，EXE 调用云端接口同步：
  - 当前套餐
  - 当前积分余额
  - 最近订单状态

## 6. 项目结构建议

建议在当前仓库中采用统一 monorepo：

```text
lawVerify/
  app/                  # Electron 桌面端
  server/               # 当前本地业务服务
  web/                  # 官网 + 账户中心
  cloud-server/         # 云端账户/支付/订单/发票 API
  admin-console/        # 内部运营后台
  packages/shared/      # 类型、常量、权限、套餐配置
```

说明：

- `web/` 承担官网与账户中心，不再拆成两个站
- `cloud-server/` 提供正式云端接口
- `server/` 保留本地工作台服务能力
- `packages/shared/` 统一订单状态、套餐、用户类型、发票状态枚举

## 7. 核心数据库表设计

以下为云端正式表。

## 7.1 用户与组织

- `users`
- `organizations`
- `organization_memberships`
- `user_sessions`

## 7.2 套餐与权益

- `plans`
  - 套餐定义
- `plan_prices`
  - 套餐价格
- `subscriptions`
  - 当前订阅
- `entitlements`
  - 用户当前权益快照

## 7.3 订单与支付

- `orders`
  - 订单主表
- `order_items`
  - 订单明细
- `payment_orders`
  - 第三方支付单
- `payment_callbacks`
  - 回调原文与验签结果
- `refund_orders`
  - 退款记录

关键字段建议：

- 订单号
- 用户 ID
- 组织 ID
- 订单类型
- 套餐 ID
- 金额
- 币种
- 状态
- 第三方通道
- 第三方交易号
- 创建时间
- 支付时间
- 关闭时间

## 7.4 积分与使用量

- `point_accounts`
- `point_ledger_entries`
- `usage_records`
- `usage_quotas`

说明：

- `point_accounts` 记录余额
- `point_ledger_entries` 记录每次变动
- `usage_records` 记录具体功能消耗
- `usage_quotas` 记录套餐期内可用量

## 7.5 发票

- `invoice_profiles`
- `invoice_requests`
- `invoice_files`

关键字段建议：

- 发票抬头
- 税号
- 发票类型
- 发票状态
- 关联订单
- 可开票金额
- 发票文件地址

## 7.6 下载与版本

- `desktop_releases`
- `release_assets`
- `download_records`

## 7.7 审计与运营

- `audit_logs`
- `support_tickets`
- `risk_events`

## 8. 接口清单

## 8.1 官网公开接口

- `GET /api/web/site/config`
- `GET /api/web/plans`
- `GET /api/web/releases/latest`
- `GET /api/web/releases`
- `POST /api/web/contact`

## 8.2 账户中心接口

- `POST /api/account/register`
- `POST /api/account/login`
- `POST /api/account/logout`
- `GET /api/account/me`
- `GET /api/account/entitlements`
- `GET /api/account/usage/summary`
- `GET /api/account/point-ledger`

## 8.3 订单与支付接口

- `GET /api/billing/plans`
- `POST /api/billing/orders`
- `GET /api/billing/orders`
- `GET /api/billing/orders/:orderId`
- `POST /api/billing/orders/:orderId/pay`
- `POST /api/billing/payment/alipay/notify`
- `POST /api/billing/payment/wechat/notify`
- `POST /api/billing/orders/:orderId/close`
- `POST /api/billing/orders/:orderId/refund`

## 8.4 发票接口

- `GET /api/invoices/profiles`
- `POST /api/invoices/profiles`
- `PATCH /api/invoices/profiles/:profileId`
- `GET /api/invoices/requests`
- `POST /api/invoices/requests`
- `GET /api/invoices/files/:invoiceId`

## 8.5 下载中心接口

- `GET /api/releases/latest`
- `GET /api/releases`
- `GET /api/releases/:releaseId`
- `POST /api/releases/:releaseId/download`

## 8.6 EXE 联动接口

- `GET /api/client/account-summary`
- `GET /api/client/entitlements`
- `GET /api/client/orders/latest`

返回内容建议至少包含：

- 当前昵称
- 套餐名称
- 到期时间
- 积分余额
- 最近订单状态

## 9. 权限边界

### 普通用户

- 查看自身订单
- 充值与购买
- 查看自身使用量
- 提交开票

### 企业管理员

- 查看组织内订单
- 管理发票主体
- 管理团队席位
- 查看组织使用量汇总

### 运营后台

- 查看全部订单
- 处理异常单
- 审核发票
- 配置套餐
- 发布客户端下载版本

## 10. 推荐实施顺序

### 第一阶段

- `web/` 搭官网与账户中心基础框架
- `cloud-server/` 搭用户、套餐、订单、支付接口
- EXE 充值入口改为跳转官网账户中心

### 第二阶段

- 补订单中心
- 补使用情况
- 补发票管理
- 补下载中心

### 第三阶段

- 补内部运营后台
- 补退款与异常单处理
- 补企业套餐与团队席位

## 11. 当前仓库下一步建议

基于现有代码，建议立即执行：

1. 新建 `web/`
2. 新建 `cloud-server/`
3. 把当前支付原型逻辑逐步从本地服务迁到 `cloud-server/`
4. 把 EXE 中“充值入口”改成打开官网账户中心
5. 保留本地工作台服务，只做业务本地能力

这样可以保证：

- 当前 EXE 不被打断
- 支付正式走公网
- 官网与账户中心统一品牌与体验
- 后续发票、订单、使用量自然接上
