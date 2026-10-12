# LawVerify 法院案例库与法律条文库规划

## 1. 模块定位

在现有 `总览 / 案件与证据 / 核验编辑` 三个一级模块之外，新增一个一级入口：

- `知识库`

`知识库` 不是单纯的信息查询页，而是服务于律师办案与质证写作的专业知识中心。其下包含两个核心子库：

- `法院案例库`
- `法律条文库`

两者的目标不是替代通用法律检索网站，而是为当前案件提供“可检索、可摘录、可引用、可回溯”的办案支撑能力，并与质证书生成、核验编辑形成闭环。

## 2. 业务目标

### 2.1 法院案例库

解决三个问题：

- 帮律师快速找到与当前争议焦点相近的裁判案例
- 提取可直接用于说理的裁判观点、裁判规则和裁判要点
- 将案例要点作为“法律论证引用”绑定到质证书段落

### 2.2 法律条文库

解决四个问题：

- 快速定位现行有效的法律、司法解释、规范性文件
- 按条、款、项粒度查看法条内容与版本
- 将具体法条片段插入到质证书或核验批注中
- 建立“争议焦点 -> 法条 -> 案例”的关联视图

## 3. 信息架构

### 3.1 一级导航

建议前端一级导航从：

- `总览`
- `案件与证据`
- `核验编辑`

扩展为：

- `总览`
- `案件与证据`
- `核验编辑`
- `知识库`

### 3.2 知识库内部结构

`知识库` 页内使用二级标签：

- `案例检索`
- `法条检索`
- `我的引用`

其中：

- `案例检索`：面向法院案例库
- `法条检索`：面向法律条文库
- `我的引用`：显示当前案件已经收藏、插入、绑定过的案例观点和法条片段

### 3.3 与现有工作台的关系

- 在 `案件与证据` 中，用于围绕案件焦点做前置检索和收藏
- 在 `核验编辑` 中，作为右侧附加知识引用面板，为段落提供案例/法条支撑
- 在后续“质证书起草”流程中，用于生成带法律依据的初稿

## 4. 核心使用场景

### 4.1 场景一：围绕争议焦点查案例

流程：

1. 用户进入某个案件
2. 系统读取案件争议焦点、证据摘要、角色立场
3. 在案例库中自动推荐相似案例
4. 用户收藏可用案例观点
5. 在生成质证书或修改段落时，一键插入案例引用

### 4.2 场景二：围绕某段质证意见补法律依据

流程：

1. 用户在 `核验编辑` 中点击某个段落
2. 右侧除了显示证据原件，还可切到 `法律依据` 视图
3. 系统根据段落文本推荐相关法条和案例
4. 用户选择一个或多个条文片段/裁判观点进行绑定
5. 段落右侧显示“证据引用”与“法律引用”两个维度

### 4.3 场景三：形成可回溯的法律论证链

每个段落未来应可同时拥有三类支撑：

- 事实依据：证据原件
- 法律依据：法条片段
- 裁判参照：案例观点

最终形成：

`段落观点 -> 证据来源 -> 法条依据 -> 类案支撑`

## 5. 法院案例库设计

### 5.1 数据范围

首期建议优先覆盖：

- 民事裁判文书
- 民商事执行、再审中的典型裁判
- 最高院指导性案例
- 最高院公报案例
- 地方法院典型案例

### 5.2 核心字段

建议案例实体至少包含：

- `id`
- `title`
- `caseNumber`
- `courtName`
- `courtLevel`
- `region`
- `trialLevel`
- `caseType`
- `cause`
- `judgmentDate`
- `effectiveDate`
- `partiesSummary`
- `factSummary`
- `issueSummary`
- `holdingSummary`
- `reasoningSummary`
- `resultSummary`
- `fullText`
- `sourceUrl`
- `sourceType`
- `keywords[]`
- `focusTags[]`
- `referencedStatutes[]`
- `citationParagraphs[]`

### 5.3 检索方式

支持四层检索：

- 关键词全文检索：案号、法院、标题、裁判观点
- 结构化筛选：法院层级、地区、案由、审级、年份
- 焦点检索：按争议焦点标签过滤
- 相似推荐：按当前案件描述、当前段落文本做语义召回

### 5.4 结果页结构

案例检索结果建议采用“三栏式”：

- 左侧：筛选器
- 中间：案例结果列表
- 右侧：案例详情与摘录区

案例详情重点展示：

- 基本信息
- 裁判要旨
- 争议焦点
- 裁判理由
- 可引用片段
- 所援引法条

### 5.5 可引用单元

案例不应只按整篇引用，建议拆成更细粒度：

- `裁判要旨`
- `裁判理由片段`
- `争议焦点结论`

这样在质证段落中引用时，引用对象是具体观点片段，而不是整份判决书。

## 6. 法律条文库设计

### 6.1 数据范围

首期建议覆盖：

- 法律
- 行政法规
- 司法解释
- 规范性文件
- 指导性意见

后续再补：

- 地方性法规
- 地方高院审判指引
- 部门规章

### 6.2 核心字段

建议条文实体拆为两层：

#### 法律文件

- `id`
- `title`
- `docType`
- `issuer`
- `effectiveStatus`
- `effectiveDate`
- `publishDate`
- `revisionDate`
- `version`
- `sourceUrl`
- `fullText`
- `keywords[]`

#### 条文片段

- `articleId`
- `documentId`
- `chapterTitle`
- `sectionTitle`
- `articleNumber`
- `clauseNumber`
- `itemNumber`
- `content`
- `plainText`
- `aliases[]`
- `topicTags[]`
- `embeddingText`

### 6.3 条文库关键能力

- 按法条编号精准定位，如“民事诉讼法第六十六条”
- 按自然语言检索，如“电子数据真实性认定”
- 展示历史版本与现行版本
- 展示相关司法解释与配套规范
- 支持按片段引用，而非仅引用整部法律

### 6.4 条文详情页结构

建议包含：

- 基本信息
- 生效状态
- 版本切换
- 条文目录树
- 当前条文正文
- 相关司法解释
- 相关案例推荐
- 可引用片段区

## 7. 与质证书和核验编辑的联动

### 7.1 段落引用模型升级

当前段落已支持 `links[]` 形式的证据引用。下一步建议扩展为统一引用模型：

- `evidenceLinks[]`
- `statuteLinks[]`
- `caseLinks[]`

或者采用一个统一数组：

- `references[]`

其中每条引用包含：

- `id`
- `type`：`evidence | statute | case`
- `targetId`
- `locator`
- `quote`
- `label`
- `sourceTitle`

如果后续希望前端交互统一、右侧卡片统一、审计能力统一，建议直接走 `references[]`。

### 7.2 核验工作台交互

在 `核验编辑` 右侧增加一个顶部切换：

- `证据原件`
- `法律依据`
- `案例参照`

当选中段落时：

- `证据原件`：显示当前证据引用卡片与原件预览
- `法律依据`：显示绑定法条和推荐法条
- `案例参照`：显示绑定案例观点和推荐案例

### 7.3 文稿中的表现形式

建议在段落或句子后展示三类轻量标签：

- `[证据]`
- `[法条]`
- `[案例]`

点击后右侧切换到相应引用面板，并定位到具体片段。

## 8. 后端数据模型建议

建议新增以下实体：

- `KnowledgeCase`
- `KnowledgeCaseExcerpt`
- `KnowledgeStatuteDocument`
- `KnowledgeStatuteArticle`
- `KnowledgeReference`
- `CaseKnowledgeBookmark`

### 8.1 KnowledgeCase

用于存案例基础信息和全文。

### 8.2 KnowledgeCaseExcerpt

用于存可引用的案例片段：

- `id`
- `caseId`
- `excerptType`：`holding | reasoning | issue`
- `locator`
- `content`
- `summary`
- `keywords[]`

### 8.3 KnowledgeStatuteDocument

用于存法律文件元数据和版本信息。

### 8.4 KnowledgeStatuteArticle

用于存条、款、项粒度的法条内容，方便精确引用与搜索。

### 8.5 KnowledgeReference

用于把具体案件段落与某条法条片段/案例片段绑定。

建议字段：

- `id`
- `caseId`
- `certificateId`
- `paragraphId`
- `referenceType`
- `targetId`
- `targetLocator`
- `quote`
- `note`
- `createdBy`
- `createdAt`

## 9. 最小可落地 API

建议优先落到 `/api/v1` 下。

### 9.1 案例库

- `GET /api/v1/knowledge/cases`
- `GET /api/v1/knowledge/cases/:caseId`
- `GET /api/v1/knowledge/cases/:caseId/excerpts`

查询参数建议支持：

- `keyword`
- `courtLevel`
- `region`
- `caseType`
- `cause`
- `year`
- `focusTag`
- `page`
- `pageSize`

### 9.2 条文库

- `GET /api/v1/knowledge/statutes`
- `GET /api/v1/knowledge/statutes/:documentId`
- `GET /api/v1/knowledge/statutes/:documentId/articles`

查询参数建议支持：

- `keyword`
- `docType`
- `effectiveStatus`
- `issuer`
- `version`
- `page`
- `pageSize`

### 9.3 引用绑定

- `POST /api/v1/knowledge/references`
- `PATCH /api/v1/knowledge/references/:referenceId`
- `DELETE /api/v1/knowledge/references/:referenceId`
- `GET /api/v1/certificates/:certificateId/paragraphs/:paragraphId/references`

### 9.4 推荐能力

- `POST /api/v1/knowledge/recommend/cases`
- `POST /api/v1/knowledge/recommend/statutes`

入参可以是：

- 当前案件焦点
- 当前段落文本
- 当前证据摘要

首期可以先做规则召回和关键词匹配，后续再接语义检索。

## 10. 前端页面结构建议

### 10.1 知识库首页

推荐区块：

- 今日常用法条
- 最近收藏案例
- 当前案件相关推荐

### 10.2 案例检索页

包含：

- 搜索框
- 高级筛选
- 结果列表
- 详情抽屉
- 一键收藏
- 一键插入当前段落

### 10.3 法条检索页

包含：

- 搜索框
- 文种筛选
- 条文目录树
- 条文正文
- 版本切换
- 一键引用

### 10.4 我的引用页

展示当前用户或当前案件下已经引用过的：

- 案例观点
- 法条片段
- 最近使用记录

## 11. 数据接入与索引策略

首期建议按三层处理：

### 11.1 采集层

- 导入公开裁判文书
- 导入法律法规与司法解释文本
- 保留 `sourceUrl` 与导入批次信息

### 11.2 清洗层

- 统一标题、编号、日期、法院名称
- 拆分案例摘要、裁判理由、法条条款
- 生成关键词、焦点标签

### 11.3 检索层

首期：

- PostgreSQL 全文检索或 OpenSearch

二期：

- 增加向量索引，用于相似案例和相似法条推荐

## 12. 分期实施建议

### P0：结构先行

- 新增 `知识库` 一级导航
- 做静态页面骨架
- 补后端 mock 数据接口
- 完成案例/法条/引用的数据结构定义

### P1：首批可用

- 支持案例检索
- 支持法条检索
- 支持将案例片段和法条片段绑定到段落
- 支持在核验工作台右侧切换查看

### P2：智能推荐

- 基于案件焦点推荐案例
- 基于段落文本推荐法条
- 推荐“法条 + 案例”组合引用

### P3：商用增强

- 收藏夹、知识包、团队共享
- 知识引用审计日志
- 多版本法条对照
- 律所私有案例沉淀

## 13. 结论

“法院案例库”和“法律条文库”不应被设计成独立的信息页面，而应成为 LawVerify 的专业知识支撑层。

最合适的产品路径是：

1. 先新增 `知识库` 一级导航，承接案例检索与法条检索
2. 再把引用能力接入 `核验编辑`
3. 最终把它们变成质证书生成、修改、核验全过程中的可回溯法律依据系统

这样，平台最终交付的就不只是“证据核验工具”，而是“事实依据 + 法律依据 + 类案参照”三位一体的律师作业平台。
