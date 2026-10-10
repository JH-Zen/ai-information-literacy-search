# 持久Node初始化片段

2.9.0优先在Codex的持久 `node_repl` 中一次加载helper、保留同一 `session`。用户说“准备答题”时调用 `await session.prepare()`，启动或复用可见Chrome、缓存资料与本地题库，并打开知网、万方、维普、读秀、超星汇雅五站；普通题实际需要浏览器时才调用 `await session.start()`。本地题库查询可单独加载 `scripts/question-bank.cjs`，无需浏览器。已准备后的每题直接使用对象，不重新读取片段。具体代码见技能的 `references/browser.md`。

安装器将本目录的两个片段复制到独立运行时 `~/.ailiteracy-runtime/repl/snippets`，供本机已有的持久daemon使用。片段依赖daemon提供的 `skill`、`requireSkill`、`skillEntry`、`outputRoot`、`DAEMON_DIR`，不作为普通 `node prepare.js` 脚本执行。安装器不安装、替换或重启daemon，也不修改其端口、日志、会话标识与浏览器profile。

已有daemon的准备入口：

```powershell
node "$env:USERPROFILE/.ailiteracy-runtime/repl/run.cjs" -f "$env:USERPROFILE/.ailiteracy-runtime/repl/snippets/prepare.js"
```

`bootstrap.js`仅建立或复用对象并检查、启动Chrome；`prepare.js`在同一次请求中完成浏览器启动、全部已登记资料缓存及默认名单开站，只返回简短摘要。二者均不执行 `preflight()` 或代表查询，不截图、不逐题归档。默认名单来自 `sources.json` 的 `profile.preparation_source_ids`；持久上下文中可用 `session.prepare({sourceIds: [...]})` 指定本次名单，`sourceIds: []`不打开来源网站，构造选项 `prepareSourceIds`可覆盖默认名单。

开站最多5个并发。重复准备只补缺页，不导航已有准备页或登录页；常驻准备页不占 `maxPages` 管理的最多5个任务页名额，登录、验证码及其弹窗保留。`start()`恢复时不关闭已有非空页。每题及最后答复后继续保留session和浏览器，只有用户明确要求关闭时才调用 `session.close()`。

准备摘要增加 `sites_total/sites_opened/sites_reused/sites_failed` 和 `sites`；站点条目含 `source_id/name/requested_url/url/status`，状态为 `opened|reused|failed`，`preflight_ran`仍为 `false`。数量由索引及本次名单决定，资料加载或页面打开不代表已登录、权限可用或查询已验证。

安装文件不能刷新daemon已经加载的模块。发现版本或代码不符时返回或抛出 `RELOAD_REQUIRED`，说明需要刷新运行时；片段不结束daemon、不关闭Chrome、不替换旧对象。保留原 `sessionId` 和独立profile可继续使用登录状态；Node重置后的未归档内存证据不能恢复，不能据此声称旧题材料仍在。
