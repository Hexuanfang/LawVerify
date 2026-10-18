# LawVerify 工作区存储

## 存储位置

桌面端工作区仍位于 `%APPDATA%\LawVerify\data`。邮箱账号使用其中的 `workspaces\<账号目录>`，开发服务沿用 `WORKSPACE_DATA_DIR` 配置。

每份工作区包含：

- `workspace.sqlite`：案件、证据元数据、理解结果、案件记忆、文书、段落及句级关联。
- `workspace-assets`：按 SHA-256 去重的原件及页图 Data URL 缓存。原有 `storageKey` 指向的对象存储文件不移动。
- `workspace.sqlite-wal` / `workspace.sqlite-shm`：SQLite 运行期间可能出现的事务文件，不应单独删除。
- 原有 `workspace.json` / `workspace.backup.json`：保留不动，仅用于首次迁移及迁移前备份，不再继续写入。

云端账户、支付及积分账本仍使用 PostgreSQL。

## 首次迁移

首次访问工作区时，在 SQLite 事务中导入旧 JSON；主文件无法解析时尝试备份。校验各类记录、媒体引用及数据库完整性成功后，才标记迁移完成。

迁移不调用大模型，不改变已保存的证据理解指纹、版本或句级关联，不产生解析扣费。迁移失败会回滚，禁止自动创建空工作区；原 JSON 不会被覆盖或删除。

后续只读取 SQLite。数据库损坏时不会自动回退到可能过时的 JSON，以避免新数据被旧备份替换。

## 保存与冲突

独立记录采用增量写入，关联与文书变更在同一事务中提交。WAL 模式下读取获得一致快照，不会读到写了一半的数据。

保存携带读取时的版本快照。不同记录、不同字段的独立修改自动合并；同字段冲突、材料被替换、句子已被编辑或删除与后台新增结果冲突时，取消整次保存并提示刷新重试，不覆盖已提交结果。

内部版本信息不会进入 API JSON。接口和桌面 UI 的既有数据形状保持不变。

同一客户端窗口的段落保存与证据联动按顺序提交，联动等待失焦保存完成，运行期间正文暂不可编辑。前置保存失败时取消依赖它的联动，保留编辑器未保存文字；重试不会自动重复收费分析。备注和纯格式保存不重新识别法条，保留已有法律关联。其他窗口或后台任务真正修改同一输入时，仍由上述版本校验拦截，不强制覆盖。

## 备份与恢复

关闭 LawVerify 后，备份完整的 `%APPDATA%\LawVerify\data` 和 `%APPDATA%\LawVerify\storage` 目录。不要只复制 `workspace.sqlite` 而忽略事务文件及 `workspace-assets`。

恢复时先关闭客户端，再恢复上述完整目录。不要把旧 JSON 直接替换为最新工作区；如需恢复迁移前版本，应另行保留当前 SQLite 及全部资产，再执行受控恢复。

迁移后的新修改不会同步回旧 JSON。因此禁止直接降级到只支持 JSON 的旧客户端继续办案。

## 验证命令

在项目根目录执行：

```powershell
npm --prefix server run test:workspace
npm --prefix server run test:linkage
npm --prefix server run build
npm --prefix app run prepare:desktop
npm --prefix app run verify:workspace
```

SQLite 使用运行时内置 `node:sqlite`，无需额外数据库服务或原生模块重编译。当前验证环境为 Node 22.23.1 和 Electron 44.4.2 内置的 Node 24.21.0。

代码修改不会自动更新已安装的 EXE；需要后续重新构建并安装，首次打开时才会迁移真实桌面数据。
