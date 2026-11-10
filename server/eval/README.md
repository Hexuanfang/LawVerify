# 评测集与评测基线

本目录给「证据联动」这条链路建立可复现的度量口径：改一行代码就能知道指标是涨了还是跌了。

## 目录

| 路径 | 说明 |
| --- | --- |
| `datasets/synthetic-v1.jsonl` | 合成语料 v1（2 个样本 / 19 份材料 / 62 条主张句） |
| `datasets/real-v1.jsonl` | 真实语料占位，格式与合成语料一致，导入规范见下 |
| `datasets/build-synthetic-v1.mjs` | 合成语料生成器，改完内容重跑即可产出 JSONL |
| `fixtures/linkage-offline-v1.json` | 录制的模型原始响应 + 流水线解析后的挂接结果 |
| `fixtures/build-linkage-offline-v1.mjs` | 夹具生成器 |
| `metrics.ts` | 指标计算（纯函数，不依赖 IO） |
| `report.ts` | Markdown 报告生成 |
| `runner.ts` | 执行器：加载语料 → 跑各层 → 算指标 → 出报告 |
| `tsconfig.json` | 评测目录的独立类型检查配置（`npm run typecheck:eval`） |
| `thresholds.json` | 指标阈值 |
| `baseline.json` | 最近一次通过的基线指标，用于对比 |
| `reports/` | 每次运行产出的报告（不进版本库） |

## 运行

```bash
# 离线评测：零网络、零费用，两次运行数值完全一致
npm --prefix server run test:eval

# 严格模式：任一指标低于阈值退出码 1
npm --prefix server run test:eval:strict

# 真实模型端到端：需要配置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
npm --prefix server run test:eval:live

# 指标函数单元测试
npm --prefix server run test:eval:metrics

# 评测目录的类型检查
npm --prefix server run typecheck:eval

# 重新生成语料与夹具
npm --prefix server run eval:dataset
```

其他开关：

- `--update-baseline`：把本次结果写入 `baseline.json`。
- `--dataset=<path>`：只跑指定语料文件，可重复传入。
- `--gateway`：live 模式下显式走云端网关（消耗账户积分），脚本启动时会打印提示。

低于阈值默认**只告警**（退出码 0，报告中标红），需要阻断时使用 `--strict`。

## 指标口径

| 指标 | 键 | 含义 | 阈值 |
| --- | --- | --- | --- |
| 候选召回 | `recall_at_5` | 期望材料是否进入检索候选前 5 位 | ≥ 0.80 |
| 句级门控准确率 | `gating_accuracy` | `getSentenceLinkageGuard` 的跳过判断与语料标注是否一致 | ≥ 0.90 |
| 引用可溯率 | `grounded_rate` | 挂接的 `locator` 能定位到页、`quote` 是原文子串 | ≥ 0.95 |
| 编号一致性准确率 | `numbering_accuracy` | `Evidence.number` 与 `evidenceSourceNumber(relativePath)` 唯一且互不冲突 | ≥ 0.95 |
| 解析健壮率 | `parse_success_rate` | `parseLinkageParagraphResponse` 对正常/截断/包裹错误 JSON 的解析成功率 | = 1.00 |
| 端到端挂接准确率 | `link_accuracy` | 仅 `--live`：模型选中的材料与期望一致 | ≥ 0.80 |
| 端到端错挂率 | `wrong_link_rate` | 仅 `--live`：模型选中错误材料的比例 | ≤ 0.10 |

`recall_at_5` 复用 `server/src/search/tokenize.ts` 的分词实现（与证据检索层同一套口径），
避免评测里的「召回」与线上检索的「命中」对同一个词给出不同判断。

## 语料格式

JSONL，一行一个样本。以 `#` 或 `//` 开头的行是注释，运行时跳过。

```json
{
  "id": "syn-0001",
  "corpus": "synthetic",
  "case": { "name": "甲乙买卖合同纠纷", "role": "plaintiff" },
  "materials": [
    { "id": "m-1", "number": "E01", "sourceNumber": "证据1", "name": "购销合同.pdf",
      "type": "pdf", "relativePath": "证据1 购销合同.pdf",
      "text": "-- 第 1/2 页 --\n甲方与乙方签订购销合同……\n-- 第 2/2 页 --\n合同总价款 120 万元……" }
  ],
  "paragraphs": [
    { "id": "p-1", "text": "经审查证据1，双方于2023年5月签订购销合同，约定总价120万元。" }
  ],
  "claims": [
    { "id": "c-1", "paragraphId": "p-1", "sentenceIndex": 0,
      "sentenceText": "双方于2023年5月签订购销合同，约定总价120万元。",
      "expect": { "link": true, "materialId": "m-1", "locator": "第 2 页",
                  "relation": "support", "statutes": [], "cases": [] },
      "notes": "金额与合同页对应" }
  ]
}
```

字段约定：

- `materials[].text` 必须使用与 `splitEvidenceTextIntoPages` 一致的分页标记（`-- 第 N/M 页 --`），
  否则页码定位无法复现。
- `claims[].sentenceIndex` / `sentenceText` 必须与 `paragraphs[].text` 按 `getLinkageSentences`
  的口径切分结果一一对应，运行时会自检，不一致会在报告顶部告警并使指标不可信。
- `expect.link`：该句是否需要进入联动核验，与句级门控 `getSentenceLinkageGuard` 的口径对齐
  （标题、身份字段、套话背景为 `false`；事实句、争议焦点句、法律适用句为 `true`）。
- `expect.materialId`：应挂接的材料；`null` 表示该句需要核验但没有对应材料（如法律适用句）。
- `expect.relation`：`support` / `partial` / `contradict` / `unrelated`。

## 真实语料导入规范

1. 逐行写出，字段结构与合成语料完全一致，注释行以 `#` 开头。
2. 脱敏：删除当事人姓名、身份证号、银行账号、手机号、地址等可识别信息；
   需要保留结构时用 `某某`、`3101**********1234` 这类占位。
3. 材料正文保留原始分页标记，不要重新分页。
4. `notes` 写清标注依据；无法确定的句子不要硬凑，宁可标 `expect.materialId = null`。
5. 一个文件一条案件线；文件名单独放到 `datasets/` 下即可被自动加载。

## 口径边界

- 合成语料只用于回归比较，不能代表真实案件的效果；对外披露时应切换到真实语料并在报告中标注 `corpus`。
- 离线模式回放的是录制下来的模型响应与规则层行为，衡量的是「规则层与解析层」的口径，
  不等于模型端到端效果；模型效果用 `--live` 单独测。
- 报告里的每个指标都能追溯到失败样本 id，可直接回到语料定位问题。
