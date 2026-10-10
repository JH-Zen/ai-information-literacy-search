# AI+ 信息素养检索助手

基于 **Codex Skills + Playwright** 的信息素养学习与备赛工具。接收题干和选项，优先复用适用证据与本地题库；需要补充资料时，再查官方说明、API 或数据库页面，给出简短答案、关键依据、来源和置信度。

当前版本：**2.9.0**。支持单选题、多选题和判断题，适合信息检索训练、知识核验及 AI+ 信息素养备赛。

## 主要功能

- **按证据缺口检索**：已有材料足以判断时直接回答；题内数据能推导时直接计算，减少重复查询。
- **本地题库复用**：稳定题完整匹配题型、题干和选项文字后，按当前选项映射答案；类似题参考解析与检索方法。
- **核对变化事实**：数量、排名、状态和产品功能等问题，结合题目要求的时间与口径补充证据。
- **提前准备浏览器**：输入“准备答题”，缓存技能资料，并启动或复用可见 Chrome；默认打开知网、万方、维普、读秀和超星汇雅。
- **连续题复用会话**：采用独立持久浏览器配置，保留准备页、登录页和验证码页，方便完成登录后继续检索。
- **简短、可追溯的答复**：先给答案，再说明关键依据与来源；证据不足时指出待核验的内容。

## 快速开始

### 环境要求

- Windows 与 PowerShell。
- Node.js **20 或更高版本**，包含 npm。
- 本机已安装 Google Chrome。
- 支持 Skills 和持久 Node 工具的 Codex 环境。

### 安装

本仓库提供完整源代码。可以克隆仓库：

```powershell
git clone https://github.com/aoxiaobu/ai-information-literacy-search.git
cd ai-information-literacy-search
```

也可以下载根目录的 [AI 信息素养安装包](AI信息素养-Playwright-Skills.zip) 并解压。在包含 `setup.ps1` 的目录打开 PowerShell，执行安装：

```powershell
.\setup.ps1 -Target both
```

`-Target cli` 安装到 `~/.agents/skills`，`-Target app` 安装到 `~/.codex/skills`，`both` 安装到两处。同时扫描两处的客户端可能重复显示技能。

安装器在 `~/.ailiteracy-runtime` 配置独立运行时和 Playwright 依赖，使用本机 Chrome。分发时请保留 `setup.ps1` 与 `ai-literacy-search` 文件夹的相对位置。

更新已受管安装：

```powershell
.\setup.ps1 -Target both -Update
```

若本地脚本被执行策略拦截，可仅对本次进程使用：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 -Target both
```

### 在 Codex 中使用

安装后，在新对话中输入：

```text
使用 $ai-literacy-search，准备答题。
```

准备完成后，直接发送**完整题干和全部选项**，或清晰截图。也可以直接发题，需要浏览器时再启动。

例如：

```text
某数据库中相关文献共 100 篇，检索出 80 篇，其中相关文献 60 篇。
查全率和查准率分别是多少？
A. 60%、75%
B. 75%、60%
C. 80%、60%
D. 60%、80%
```

答复形式示例：

```text
答案：A。
查全率 = 60/100 = 60%；查准率 = 60/80 = 75%。
来源：题内数据推导。
置信度：100%（高）。
```

置信度表示对本题证据完整性的估计，不是经过统计验证的整体正确率。

## 工作方式

**理解题目 → 复用证据或题内推导 → 查询相关题库与规则 → 补充必要证据 → 核对全部选项 → 输出答案与来源。**

Codex 理解题目、选择来源并核对条件；Skills 提供证据规则、题库与网站流程；Playwright 执行必要的浏览器操作。多选题逐项核对，选项换序后重新按文字映射字母。

资料目录包含 **247 个网站或产品入口、306 条流程**，并提供稳定知识规则卡。这些数字表示目录覆盖范围；部分流程提供浏览器执行函数，具体网站能否查询取决于页面状态、权限和实际流程支持。

## 使用说明

- 页面打开不代表已经登录、拥有全文权限或检索成功。账号登录及验证码由用户在浏览器原窗口完成，无需向助手发送密码。
- 本地题库保留用户资料标注的样题、平台报告出处与解析；其中的“标准答案”不代表全部经过独立官网核验。条件变化或证据冲突时重新判断。
- 默认不逐题截图或生成归档文件；需要复查时可按需启用。内存证据缓存不会跨 Node 重置自动恢复。
- 当前来源目录参考 **2026 年四川省高职高专赛道**材料，其他赛区应按自身要求核对。
- 本工具用于学习、备赛与信息核验，不自动开始考试、选择考试选项或交卷。

更多安装细节、配置选项与网站流程，请阅读 [使用说明](使用说明.md)。

## 项目目录

```text
├─ README.md                  项目介绍与快速开始
├─ 使用说明.md                完整使用说明
├─ setup.ps1                  安装与更新脚本
├─ AI信息素养-Playwright-Skills.zip  安装包
└─ ai-literacy-search/
   ├─ SKILL.md                技能入口
   ├─ references/             题库说明、证据规则与网站流程
   ├─ scripts/                辅助脚本
   └─ runtime/                Playwright 运行时与调用片段
```

进一步阅读：[题库说明](ai-literacy-search/references/question-bank.md) · [范围说明](ai-literacy-search/references/exam-scope.md) · [浏览器接口](ai-literacy-search/references/browser.md)。
