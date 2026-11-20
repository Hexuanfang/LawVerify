# AutoClaw legal 场景 agent 与 skill 调研

调查日期：2026-11-17
调查方式：tool_search（legal / law / 法条 / 案例 / 核验 / 文书 / yuandian / beida-fabao / benchmark）+ 通读 skill 正文
工作目录：/Users/shenshuang/Desktop/zhijing/AI核验前端

---

## 0. 结论摘要

AutoClaw 法律能力分两层：**原生检索工具**（legal_statute / legal_case / web_search_law / legal_overseas_source_*，经 tool_invoke 调用）和**方法论 skill**（legal-core-rules 统领，下挂检索、效力核验、QA、要素抽取、文书起草等）。没有独立的 "LawVerify" agent；法条效力核验与引用可核验的规则集中在 `legal-norm-validity-check` 与 `legal-qa`，是最可直接借给核验管线的两份文本。检索源以元典（legal_statute/legal_case/yuandian）为主锚，北大法宝为并行源，web_search_law 只做时效补线。未发现法律专用 benchmark/评估数据集；最接近的是 legal-article-retrieval 的查全率/查准率体系与 legal-norm-validity-check 的置信度标注。

---

## 1. 能力分层与 agent 边界

### 1.1 双轨结构

| 层 | 载体 | 调用方式 | 说明 |
|---|---|---|---|
| 原生工具 | legal_statute、legal_case、web_search_law、legal_overseas_source_search/fetch | tool_invoke | legal 组，facade 封装元典等库 |
| 方法论 skill | legal-core-rules 及下挂 17 个 legal 组 skill | skill:// 读取后按流程执行 | 本 Session 的 `<available_skills>` 另含 yuandian、beida-fabao、courtlistener、curia、hudoc 等安装态 skill |
| 安装态检索 skill | yuandian、beida-fabao | python 脚本经 Zwork relay | 与原生工具数据同源（元典/法宝），参数面更细 |

`legal-core-rules` 明确：国内中国大陆 Session 用国内工作流集合；海外 Public Web 用海外集合；`<available_skills>` 是当前 Session 唯一可调用目录，未出现的 Skill 不得猜名访问。完整的合同起草/审查、诉讼文书生成"应建议用户切换到法律助手"——即存在一个更完整的 Legal Agent，本环境是研究员/前端视角可见的子集。

### 1.2 本 Session 可见的 legal 组 skill 清单（tool_search 命中）

argument-chain-construction、case-retrieval、contract-review、dispute-issue-identification、evidence-evaluation、fatianshi、legal-article-retrieval、legal-core-rules、legal-document-summarization、legal-docx-cn、legal-element-extraction、legal-interpretation-argument、legal-norm-validity-check、legal-qa、legal-research-drafting、legal-risk-assessment、multi-document-summarization。

---

## 2. 检索源（输入侧）

### 2.1 legal_statute（元典法规/法条）

- action：`semantic` / `search_article` / `search_regulation` / `article_detail` / `regulation_detail`
- 关键参数：`law_name`、`article_number`、`validities`（如 现行有效）、`effect_levels`、`refer_date`（按当时生效版本）、`region`、日期区间、`top_k`（上限 50；语义默认 30，关键词默认 10）
- 硬规则：引用前核对原文；非现行有效须标注时效；引用须附返回 url
- 详情模式用 `id` 优先于 law_name+article_number

### 2.2 legal_case（元典案例）

- action：`semantic` / `keyword` / `detail`
- 权威案例：`authoritative=true` 或 `semantic.only_authoritative=true`；detail `type=ptal|qwal`
- 过滤：案由、法院、层级、省份、文书种类、裁判日期、援引法条（cited_articles）、案号
- 硬规则：引用判项或原文前必须 detail 核对；商事交易先例不在本库，改用 web_search_law；引用须附 url
- top_k 上限 50；语义默认 30，关键词默认 10

### 2.3 web_search_law

- 定位：公开法律新闻、征求意见稿、官方解读、交易披露
- 硬规则：**不能代替法规库或案例库核验原文**；摘要不能单独作为法条或效力依据
- 用途：时效轨（刚修订/刚废止/尚未生效）、官方发布页发现，配合 fetch_content 读原文

### 2.4 yuandian（安装态 skill，9 工具）

法规 5：`yuandian_law_vector_search`（语义首选）、`yuandian_rh_ft_search`、`yuandian_rh_fg_search`、`yuandian_rh_ft_detail`（`fgmc`+`ftnum` 或 `id`，`refer_date` 定时点）、`yuandian_rh_fg_detail`

案例 4：`yuandian_case_vector_search`、`yuandian_rh_qwal_search`（权威）、`yuandian_rh_ptal_search`（独有 `yyft` 援引法条反查）、`yuandian_rh_case_details`（`id`=scid 或 `ah` 案号，`type=ptal|qwal`）

判读红线（可直接移植）：
- 不凭记忆补法条、法规名、案号、法院、日期、效力或链接
- 语义/关键词命中只是线索，写入回答前必须 detail 核对；引号内文字与数据库返回逐字一致
- 法条引用至少「法规全称 + 条号 + 数据库返回原文」
- 案例引用尽量给「案件名称 / 案号 / 法院 / 裁判日期」四要素；字段缺失标「数据库未返回」
- 失败即失败：错误、空内容、限流、鉴权失败都不算检索成功
- 当前接入没有独立版本链工具，无法从返回字段确认时必须转官方发布机关原文核验

### 2.5 beida-fabao（安装态 skill，6 工具）

`search_law_articles`（案情语义找法条，约 10 条）、`search_laws`（法规级）、`get_law_article`（已知法名+条号取原文，条号阿拉伯数字，120.1 = 第一百二十条之一）、`search_cases`（权威 10 + 普通 10）、`search_cases_by_keyword`、`add_law_links`（给已有正文补法宝超链）

- 每条结果带加密 `gid`（原样传递，不从 URL 截取）；给用户核对用 `citation.url`
- 能力边界：**不提供**法规版本沿革、按时点取施行版、案例正文分段读取、引用关系反查——需时指官方渠道 flk.npc.gov.cn / 中国裁判文书网 / pkulaw.com
- 响应超 200KB 自动落盘 `outputs/pkulaw_<工具>_<指纹>.json`

### 2.6 其他检索源

| 名称 | 范围 | 与 LawVerify 的关系 |
|---|---|---|
| legal_overseas_source_search/fetch | 美/欧/日/港官方法源 | 仅用户明确要求境外法/比较法时；不得传 CN |
| courtlistener | 美国联邦/州判例 | 需用户自己的 API token |
| curia | 欧盟法院判例（CELLAR SPARQL） | 无需 key |
| hudoc | 欧洲人权法院 | browser_tool |
| fatianshi | 法天使中国合同库模板 | 起草源，非核验源 |
| web_search / fetch_content | 通用网页 | 效力交叉验证第二轨 |

### 2.7 引证格式（legal-core-rules）

ydzk.chineselaw.com 域命中写行内标记，不写裸 url：
- 法条 `[显示文字](legal://ft/<id>)`，id = 命中 `id` 字段原样（fgid_阿拉伯条号 tid），不得拼中文条号
- 法规 `[显示文字](legal://fg/<fgid>)`
- 案例 `[显示文字](legal://case/<scid 或案号>)`
- 公告 `[显示文字](legal://jw/市场:检索键)`；企业 `[显示文字](legal://tyc/接口号:主参数值)`
- 境外带 cite 字段：`[显示文字](legal://ovs/<cite值>)`

---

## 3. 可直接借给 LawVerify 核验管线的规则

### 3.1 法条效力核验 —— legal-norm-validity-check ★主线

风险等级：极高。核心原则：**效力状态必须来自真实溯源，严禁凭记忆判断某法条是否被修订或废止。**

**三维度**：时间效力（是否现行有效/修订/废止/未生效）、层级效力（制定主体是否有权）、冲突检查（上位法/同位法）。

**效力状态 7 分类**（可直接做枚举标签）：
`VALID 现行有效` / `AMENDED 已修正/修订` / `PARTIAL 部分失效` / `REPEALED 已废止` / `EXPIRED 已失效` / `PENDING 尚未生效` / `UNCERTAIN 效力存疑`

**双轨核验管线**（最值得整套搬走）：
1. 数据库时点核验（必做）：`legal_statute(action="article_detail")` 取条文原文；`regulation_detail` + `refer_date` 取历史时点。识别条号错位、版本过期、虚构条文。
2. 官方发布交叉核验：作为结论依据的现行规则检查最新修订状态；涉及时效边角时 `web_search_law` 找制定机关/人大/国务院/两高官方页 + `fetch_content` 读原文。搜索摘要不能直接证明效力。
3. 冲突处理：数据库与官方网页不一致 → 逐项核对发布日期、施行日期、修改/废止决定、适用地域、发布机关、过渡条款；数据库收录延迟时以最新官方原文为准并标注"数据库待收录"。任一轨失败继续另一轨。
4. 双轨都无法完成 → 标 UNCERTAIN，不得伪装成确定结论。
5. 工具边界：不得调用旧库 `get_law_versions`、`law_at_date`、`get_citations`、`resolve_citation`。元典没有独立版本链与引用解析工具。

**信息源可靠性分级**：
- A 级（权威，可直接引用）：国家法律法规数据库 flk.npc.gov.cn、中国政府法制信息网、全国人大官网
- B 级（可靠，建议交叉验证）：威科先行、中国裁判文书网
- C 级（参考）：法律出版社、权威教材
- D 级（慎用，不可单独作为效力判断依据）：一般网络来源、非官方汇编

**置信度标注**（HIGH/MEDIUM/LOW + 后续操作）：
- HIGH：A级来源 + 时间效力明确 + 层级无疑 + 无冲突或有明确解决规则 → 可直接用于推理
- MEDIUM：B级 / 近期有修正需确认引用条款 / 有冲突但有解决规则 / 涉过渡条款 → 可用但注明保留意见
- LOW：C/D级 / 无法确认最新修正 / 冲突无法解决 / 立法权限存疑 / 规范性文件约束力不明 → **不得作为确定性结论依据**，须建议进一步核实并找替代依据

**强制复核触发**：
1. 发布超 10 年且未查到修正记录
2. 部门规章或地方性法规作为核心依据（额外查与上位法冲突）
3. 司法解释发布时间早于其解释法律的最新修正
4. 规范性文件（红头文件）作为依据（可说理不可作裁判依据）
5. 涉及已废止法律的过渡适用

**冲突解决矩阵**（立法法）：上位法优于下位法；特别法优于一般法；新法优于旧法；新一般 vs 旧特别报制定机关裁决；地方法规 vs 部门规章由国务院提意见；部门规章之间由国务院裁决。

**常见致命错误**（可做核验管线的 negative checklist）：
E01 引用已废止法律 / E02 版本混淆 / E03 层级错误 / E04 忽视冲突 / E05 超适用范围 / E06 规范性文件误认 / E07 溯及力误判

**内置速查表**：民法典 2021-01-01 废止九部单行法（婚姻/继承/民法通则/收养/担保/合同/物权/侵权/民法总则）；外商投资法 2020-01-01 废止三资企业法。

**输出模板**：单条报告（基本信息 + 三维度表 + 最终判定 + 置信度 + 使用建议）+ 批量汇总表（序号/规范名称/引用条款/时间效力/层级效力/冲突检查/最终判定/置信度/建议）。

### 3.2 引用可核验 QA —— legal-qa ★输出前门禁

任何引用法条、案例或监管口径的答复/文书，输出前逐项核对；任一项不通过回检索补齐或如实降级，不得未核对就交付。

**案例四要素**：案件名称、案号、审理法院、裁判日期，再加来源链接。缺项回检索补齐，补不齐标「待核实」或弃用。

**法条/司解**：须有来源链接；未检索过的先检索再附；链接只能来自真实检索结果。

**付费库不能是唯一核验路径**：案例靠四要素保证可查；法条指引用户到国家法律法规数据库自查（提示免费官方渠道名称）。

**引文一致性**：引号内条文、判决说理、裁判要旨须与检索原文逐字一致且在检索结果中真实出现过；做不到改为转述并标「要旨归纳」。引用案例要旨前先取判决书全文；检索摘要不足以支撑要旨转述。判项性质（判决/裁定、连带/补充、支持/驳回）以原文为准，不得美化或反转。

**命中分层（硬性）**：要求检索特定情形案例时，每一例标注「严格命中」或「近似类比」，并写明判定所依据的关键要素；严格命中为零时如实说明，不得以类比冒充命中。

**计数诚实**：同一案件不同阶段/文号/来源计为一个案例；当事人、金额、持续时间等事实细节只能写检索来源文本里有的。

**二手来源**：判决书全文取不到时一律不加引号，改转述并标「转引自XX，未经原文核验」。

**立法动向两问**：
1. 核心依据是否为非正式效力源（法答网答问、会议纪要、倾向性意见、批复/复函）？是 → 必须有「立法动向」段
2. 是否属裁判分歧类？是 → 必须有官方答疑确认记录，未命中记「已查无官方答疑」

**链接终检**：ydzk 域写 legal:// 标记；其余带 url 的附 markdown 链接；该写标记的漏写、写成裸 url、用「可到官方库自查」代替均属违规。

### 3.3 案例可回查 —— case-retrieval + legal-research-drafting

**真实性轨**：每一个案例都必须来自真实检索，严禁凭记忆生成。语义找类案 → keyword/案号 → detail 取全文。元典语义检索的整理内容不当然等于裁判文书逐字全文。

**地位标签以检索返回为准**：指导性/公报/人民法院案例库参考/典型案例等只能采用检索工具返回的类型字段原文，不得升格。权威库查无记录一律按普通判例引用并注明无强制约束力。

**观点方向确认**：援引前确认其为该案生效裁判的立场；被上级法院纠正、撤销或否定的原审认定不得作为支持性依据。

**效力层级序**：指导性案例（应当参照）> 人民法院案例库入库案例（应当参照）> 公报案例 > 典型案例/最高法案例 > 高院参考性案例 > 上级法院案例 > 本院案例 > 其他。在先顺位足量时原则上不再提交后一顺位。

**程序序**：民再 > 民终 > 民初 > 民申。未生效判决不具有被参考资格。

**三重核验后才可入报告**：
1. 确认判决已生效（查二审）
2. 确认未被撤销（以主要当事人名称查关联再审/第三人撤销之诉）
3. 确认无对己方不利观点

**相似度五维评估**（可做打分器）：
法律关系一致 30% / 争议焦点对应 25% / 关键事实相似 25% / 裁判规则参照 15% / 程序问题关联 5%

**分组**：A 核心案例 / B 重要参考 / C 一般参考 / D 对立案例。

**矛盾处理**：近因原则——级别相近优先 > 专业相近优先 > 时间相近优先；直系 > 旁系 > 系外。

**数量纪律**（legal-research-drafting）：案例检索 top_k 3-5；用户未指定时只读取一件严格匹配案例；同一案件不同审级不重复计数。

### 3.4 文书元素抽取

**legal-element-extraction**（案情 → 法律事实结构）：
- 三层：原始叙述 → 法律相关事实 → 要件事实
- 九类事实单元：主体 / 行为 / 时间 / 地点 / 对象 / 结果 / 因果关系 / 主观 / 程序
- 四分法净化：客观事实（保留+标证据来源）/ 主观判断（剥离情绪）/ 法律评价（还原为客观事实基础）/ 背景信息（剔除）
- 生活语言→法律语言转化表
- 要件映射表：构成要件 × 对应事实 × 满足状态（✅/❓/❌）
- 三种输出：结构化要素清单 / 事实分析表格 / 法律实践时间轴
- 红线：不虚构缺失事实；评价性表述（"构成欺诈""属于违约"）不能直接当分析前提

**legal-document-summarization**（判决书等文书 → 六要素）：
- 六要素：案件信息 / 事实背景 / 争议焦点 / 法律依据 / 结论结果 / 说理过程
- 先识别文书类型（判决/裁定/调解/仲裁裁决/行政处罚决定书）再选模板，不能先套格式
- 严格区分「当事人主张」与「文书认定」
- 争议焦点必须表述为可回答的法律问题
- OCR 不确定处标 `[？]`；关键数字（金额、日期、案号）识别不清特别标注
- 摘要禁止主观评价；法律依据须列具体法条而非"根据相关法律规定"

**multi-document-summarization**：多文书共识/分歧/冲突点清单；对立立场客观呈现，不做事实真伪判断。

### 3.5 检索质量评估（最接近 benchmark 的内容）

**未发现**法律专用 benchmark 数据集、评测集或 judge 工具（tool_search "benchmark 评估" "evaluation benchmark judge" 在 legal 组零命中；仅 science 组有无关工具）。

可借用的评估体系在 **legal-article-retrieval** 第五阶段：

| 指标 | 公式 | 目标 |
|---|---|---|
| 查全率 Recall | 检出相关 / 库内相关 | ≥85%（关键规范无遗漏） |
| 查准率 Precision | 检出相关 / 检出总量 | ≥70%（大部分可直接使用） |

**三层复核**：
1. 查全率保障：不同数据库对比（差异>20% 分析原因；重叠率<50% 扩大检索）；体系检索+关键词检索重叠率应>60%；时效性复核（近 3 个月新规）
2. 查准率优化——涵摄检验六要素：法律事实差异 / 法律适用差异 / 效力位阶 / 规范和裁判演进 / 地域差异 / 数量多寡
3. 二次检索决策矩阵：全不足准良好→扩大；全良好准不足→限缩；双不足→重新检索；双良好→进入报告

**检索报告必备**：问题陈述 / 检索经过（库+关键词+路径）/ 规范罗列（按效力位阶）/ 检索分析（立法/执法/司法三层面）/ 检索结论。结论必须标判断强度（高概率成立 / 存在较大争议 / 证据不足无法判断），禁止绝对化表达。

**法条引用六要素**：文件名称、文号、生效时间、条款编号、原文引用、效力状态。

### 3.6 其他可借规则

**legal-core-rules**：
- 法域固定，不默认中国大陆法，不自动切换
- 先定性后定量；要件覆盖；法源层级完整；对立观点评析
- 身份：分析类中立；以用户名义产出交付物时立场偏向用户，不留 AI 代工痕迹
- Word 法律文书一律走 legal-docx-cn，不得用通用 docx skill

**legal-research-drafting**（研究→文书管线）：
- 顺序：事实结构化 → 争点与请求权 → 元典检索 → 规则提炼 → 事实涵摄 → 计算 → 起草 → 审校；不得跳过检索凭记忆写条号案号
- 法源表：法规全称/条号/发布机关/效力层级/状态/时间/地域/适用理由/来源 URL
- 要件拆解六项：适用主体、前提事实、构成要件、例外但书、举证责任、法律后果
- 条文定位精度到「条-款-项」
- 金额自洽复算：交付前脱离原推导重新加总
- 文书本体纯净：免责声明、AI 身份、核验状态标注、检索过程、数据库链接一律不进文书本体，移到对话回复
- 文书内引号只用于与检索原文逐字一致的原文
- "最新/截至目前/尚无"类断言必须先带时间限定联网确认
- 题面未给定的外部数值（利率、统计标准）不得编造

**legal-docx-cn**：Word 生成唯一链路（dxe_client.py：new/read/validate/save/render/validate-docx）；禁止 python-docx、pandoc、markdown 转 docx；视觉自检逐页 PNG。

**contract-review**：先确认用户立场（不得从文件推断）；逐条检查；风险四级（严重/重大/一般/次要）；云端规则库 load-by-types。

---

## 4. 输入输出速查表

| Skill / 工具 | 触发条件 | 输入 | 输出 |
|---|---|---|---|
| legal_statute | 查中国法规法条 | 问题/关键词/法名+条号/refer_date | 条文原文+效力+url |
| legal_case | 查中国裁判案例 | 案情/关键词/案号/案由/法院 | 案例列表+detail 全文+url |
| web_search_law | 新闻/征求意见稿/官方解读 | query + 时间/域名过滤 | 网页结果+url（不作效力依据） |
| yuandian | 查法条/确认现行有效/按案号找判决 | query / fgmc+ftnum / ah | 结构化法规案例数据 |
| beida-fabao | 查法规原文/类案/补法宝链接 | query_text / law_title+article_number | 结果+gid+citation.url |
| legal-norm-validity-check | 已检索到法条后核效力 | 一条或多条条文+出处 | 效力状态报告+置信度 |
| legal-qa | 任何含法条案例引用的输出前 | 拟交付的答复/文书 | 通过/回检索/降级标注 |
| legal-element-extraction | 案情叙述结构化 | 日常语言案件描述 | 九类事实清单+要件映射 |
| legal-document-summarization | 单份判决书等摘要 | 文书全文 | 六要素结构化摘要 |
| legal-article-retrieval | 多维检索报告 | 法律问题+已确认事实 | 检索报告（含查全查准自评） |
| case-retrieval | 类案检索 | 案件事实/争议焦点 | 案例检索报告（相似度分组） |
| legal-research-drafting | 起草起诉状/律师函/意见书 | 任务+事实材料 | 可交付文书（docx） |
| legal-docx-cn | Word 法律文书生成 | 法律内容定稿 | 体例规范 .docx |
| fatianshi | 官方合同模板起稿 | 场景关键词 | 模板副本→docx/pdf |
| contract-review | 立场化合同审查 | 合同+用户立场 | 修订+批注 |
| legal-core-rules | 任何法律任务前 | — | 法域/引证/交付规范 |

---

## 5. 对 LawVerify 的映射建议

| LawVerify 环节 | 直接可借 |
|---|---|
| 法条真实性（是否存在、原文对不对） | legal_statute article_detail / yuandian_rh_ft_detail / beida-fabao get_law_article；引号内逐字一致 |
| 法条效力（现行/废止/修订/未生效） | legal-norm-validity-check 双轨管线 + 7 状态枚举 + refer_date 时点 |
| 法条层级与冲突 | 三维度之层级+冲突；立法法矩阵；强制复核 5 条 |
| 引用可回查 | legal-qa 四要素 + legal:// 标记 + 付费库不作唯一路径 + 官方库指引 |
| 案例真实性 | legal_case detail 前不得引用判项；地位标签以返回为准；被撤销判决剔除 |
| 案例相似度/命中分层 | 五维权重打分；严格命中 vs 近似类比硬性标注 |
| 文书元素抽取 | 九类事实单元 + 四分法净化 + 判决书六要素 + 主张/认定二分 |
| 输出门禁 | legal-qa 全清单 + LOW 置信度不得作确定结论 |
| 评估/benchmark | 无现成数据集；可自建：Recall≥85% / Precision≥70% + 涵摄六要素 + 效力 7 分类准确率 + 四要素完整率 |
| 多源冲突 | 数据库 vs 官方网页不一致处理协议；元典无版本链时转 flk.npc.gov.cn |

---

## 6. 待证项 / 边界

1. legal 组其余 skill（argument-chain-construction、evidence-evaluation、dispute-issue-identification、legal-interpretation-argument、legal-risk-assessment）本次未逐字通读，仅确认存在与定位，做管线时如需论证链/证据三性/争点识别可再读。
2. 未发现法律专用 benchmark、评测集、judge 模型或 golden set 工具。若 LawVerify 需要评估集，需自建（可从效力 7 分类、四要素完整率、引文逐字一致率、严格命中/类比区分入手）。
3. 元典当前**没有**独立版本链工具；北大法宝 skill 也明确不提供版本沿革。完整版本沿革必须走官方发布原文（flk.npc.gov.cn）。
4. 商事交易先例不在 legal_case 库，需走 web_search_law。
5. 海外法源有独立工具与触发条件，不与国内库混用。
6. yuandian/beida-fabao 经 Zwork skill relay，报「技能中继未配置」时如实告知需登录，不得改用其它来源冒充数据库结果。

---

## 7. 证据位置

- 原生工具 schema：tool_search legal / 法条 / 案例 / law 命中项 description 与 parameters
- skill 正文：skill://yuandian、skill://beida-fabao、skill://legal-core-rules、skill://legal-norm-validity-check、skill://legal-qa、skill://legal-article-retrieval、skill://legal-element-extraction、skill://legal-document-summarization、skill://legal-docx-cn、skill://legal-research-drafting、skill://case-retrieval、skill://fatianshi、skill://contract-review、skill://multi-document-summarization
- 安装态 skill 目录（available_skills）：yuandian、beida-fabao、courtlistener、curia、hudoc、cn-national-standard 等
