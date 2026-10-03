# Computer History 阶段基线与平台验收

本阶段包含 Windows C++ 采集核心、TypeScript 适配、共享业务服务、Windows 应用授权与页面接入，以及 Windows 安装包接入。本文按日期保留开发基线、受控 fixture、包内组件和真实安装版操作的独立结果；浏览器/Office/WPS 专项适配不在本轮范围内。

## 统一验证入口

在仓库根目录执行，Windows PowerShell、Git Bash 和 macOS 终端使用同一入口：

```text
node scripts/internal/shared/validate-computer-history.mjs
```

前提是已按仓库要求安装根目录和 `App/memmy-agent` 的依赖，使用满足 Agent 要求的 Node.js 22 或以上版本。入口直接调用本地 TypeScript、ESLint、Vitest 和 Vite，不执行 npm 的版本同步钩子，不下载依赖，不启动 Memmy App，也不调用真实模型服务。

执行内容：

1. 编译 Knowledge、Migrations、local-api-contracts 和 desktop interface。
2. 检查 Agent（包含测试）与前端类型，编译 Agent。
3. 检查 History 相关源码及测试的 lint。
4. 用两个 Vitest worker 执行共享/Mac/Windows 业务、HTTP、工作流、技能注册、前端、跨包协议与 Mac/Windows ASAR 布局测试。传入 Windows 原生目录后，也执行真实 Electron 包内 EXE 检查。
5. 检查共享 `core/summarize-history.js` 和旧 `mac/summarize-history.js` CLI 入口，构建前端。

默认报告保存在系统临时目录下的新目录；可通过 `--report-dir <绝对目录>` 指定父目录。每次都会创建独立目录，保存每项检查日志、Vitest JSON 报告和总表 `results.json`。总表列出跳过的测试名称；`passed` 只表示此基线通过，不表示真机或安装包验收通过。构建输出位于 Git 忽略的 `dist` 目录。

Windows 可额外验证生产 EXE 的生命周期：

```powershell
node scripts/internal/shared/validate-computer-history.mjs --native-bin D:/memmy-cpp-env/native-core-review/release --report-dir D:/memmy-cpp-env/history-baseline-artifacts
```

`--native-bin` 应指向当前源码构建得到的生产 EXE 与 fixture 所在目录。先用 `scripts/internal/win/history-recorder-native.ps1` 构建；自定义路径仅为本机示例。入口会先重新编译 Agent，再运行真实 Node + EXE 的启动、暂停、恢复、撤销授权、EOF 和有界时长用例。仅启动受控 fixture，不激活窗口、不注入输入、不授权用户的其他应用。前台内容/动作用例不在此基线内。

原生 C++ 全量测试另用构建脚本的 `-Test` 参数执行。CTest 返回 77 的前台条件跳过必须保留，不能计入通过；需要取得前台的场景留到 Windows 交互验收。

## 平台边界与明确跳过

| 检查 | Windows 上的处理 | Mac 上的要求 |
|---|---|---|
| 共享服务、摘要、恢复、保留、前端与协议 | 执行 | 再执行，确认运行时平台差异 |
| Mac POSIX 子进程正常结束 | 跳过；Windows `SIGTERM` 不执行 Node 的 POSIX 清理回调，Windows 驱动另测 stdin/ack/close | 必须执行，退出码及停止后不再写入均通过 |
| 录制目录链接逃逸 | 使用无需提权的 junction 实测 | 使用目录 symlink 实测 |
| pin 文件 symlink 边界 | 仅创建链接遇到 EPERM/EACCES 时跳过；有权限时仍执行 | 必须执行，目标内容不得被截断 |
| Swift 分类、命中目标与原生 ingest fixture | 现有测试按平台跳过 | 必须执行，需要 Xcode Command Line Tools |
| Unix helper 可执行权限、Electron 包内 helper 执行 | 现有测试按平台跳过 | 必须执行，需要本仓库 Electron 依赖 |
| Windows 原生适配 | 默认整文件排除；指定 `--native-bin` 时只跑生命周期 | 不适用 |

不要把 Mac 业务测试所在的 `mac/` 目录等同于“全都只能在 Mac 测”。绝大多数共享业务用例仍在 Windows 执行；只为确实依赖平台能力的用例设置条件。

共享摘要根据录制 metadata 的 `platform` 生成 `capture_policy`。Windows 为 `accessibility_events_no_screenshots`；Mac 和旧的无平台字段记录保留 `accessibility_events_and_page_urls_no_screenshots`。恢复记录时不以当前宿主平台替代录制平台。旧 Mac AX 数据、bundleId 和导入路径继续兼容。

## Mac 接续步骤

Windows 基线完成后，下一步需要一台 Mac。将本分支的阶段提交带到 Mac，安装仓库依赖与 Xcode Command Line Tools，然后：

```sh
node scripts/internal/shared/validate-computer-history.mjs --report-dir /tmp/memmy-history-validation
```

先查看 `results.json`。上述 Mac 专属用例应实际执行，不能仍被跳过。若失败，保存失败日志并定位，不应通过放宽 Windows 分支或删除断言解决。

自动回归通过后，在 Mac 上继续手工验证共享层抽取后的产品行为：

1. 启动开发版 App，检查辅助功能/输入监控的授权提示、拒绝及重新授权；确认 Mac 原有设置文件和应用/网站规则仍生效。
2. 使用临时测试文档执行开始、暂停、同段恢复、停止；确认暂停/停止后事件文件不再增长，App 退出后所属子进程结束。
3. 验证原有停止热键、应用图标、浏览器同标签页 URL 更新，以及密码/敏感内容过滤。仅使用受控测试数据。
4. 跨越一次十分钟分段边界，检查时间线、摘要、保留/删除、pin、恢复和检索；真实模型摘要单列结果，与自动测试中的模型替身区分。
5. 检查既有 Mac 打包 helper 的构建与执行。自动 ASAR 测试只证明布局和受控 helper 执行，不能替代安装版 Swift/AX 采集验收。

留下 Node/macOS/CPU 架构、验证提交、自动报告目录和各手工场景的结果，再判断是否可以进入下一阶段。当前 Windows 机器不能代替这些 Mac 验证。

启动开发版 App 前，还应确认 Memory 使用的原生依赖与实际运行 Node 的 ABI 一致。在仓库根目录用将用于启动 Agent/Memory 的 Node 执行：

```sh
node -e 'const Database = require("better-sqlite3"); const db = new Database(":memory:"); console.log(db.prepare("select 1 as ok").get()); db.close();'
```

若出现 `NODE_MODULE_VERSION` 不匹配，使用同一 Node 在根目录执行 `npm rebuild better-sqlite3`，再重复探测并确认 Memory 服务实际启动。统一入口的类型、History 测试与前端构建不会启动 Memory，不能代替此运行时检查。

## 2026-10-02 Mac 回归结果

验证分支为 `codex/windows-history-native-core`，提交 `47d03da4c160c5fd0b93706ada619471105f142f`，包含 `26c2467d`。执行前工作区干净。环境为 macOS 26.4 / arm64、Node 22.23.3、Electron 38.4.0、Xcode Command Line Tools / Swift 6.3.2。

本机自动报告：首次为 `/tmp/memmy-history-validation/computer-history-validation-JKynDD/results.json`，修复退出问题后的复跑为 `/tmp/memmy-history-validation/computer-history-validation-xUdZKI/results.json`。真机及受控 fixture 证据：`/tmp/memmy-history-validation/mac-acceptance/`，接续证据位于其 `followup/` 子目录。这些临时目录未提交，其他机器应重新生成证据。

| 层级 | 实际结果 |
|---|---|
| 统一自动回归 | Agent 417、前端 84、跨包协议/ASAR 11，共 **512 通过、0 失败、0 跳过**；类型、lint、构建及两条摘要 CLI 全部通过。Windows 原生适配按入口规则排除，不属于 Mac 跳过项。 |
| 后端退出回归 | 本地 API 的 60 项测试通过，包含新增的 SSE 正常关闭及鉴权过程中关闭（允许/拒绝）三个用例；后端 TypeScript 编译和修改文件 lint 通过。 |
| Mac 专属自动用例 | Swift 分类及同窗口 URL、鼠标命中/拖动、Swift→TS ingest 隐私、POSIX 子进程、目录与 pin symlink、helper 可执行权限、Electron 无 Swift 的包内 helper 执行均实际通过；具体名称和耗时见 `environment-and-mac-audit.json`。 |
| 共享服务受控 fixture | `service-fixture/results.json` 的 10 项检查通过，包括真实墙钟十分钟边界、暂停/恢复/停止、摘要/检索/pin/删除/恢复及子进程清理；采集子进程和模型响应是替身，停止热键仅为合成协议事件。 |
| 真实开发版 App + Swift helper | 使用独立 App 配置、临时数据目录及默认拒绝的应用/网站规则。用户在受控 Cocoa 测试窗口输入后，取得 81 条该应用事件；搜索及文档内容为阳性对照，密码框为 `[REDACTED]`，已知密码标记和合成 API Key 明文未落盘。实际停止热键产生 `stop_hotkey`，状态停止且 recorder 退出。 |
| 真实生命周期与分段 | 通过生产 HTTP API 开始、暂停、同段恢复、停止；暂停/停止后文件稳定。首次 18:50 仅验证轮换，接续在 19:30 用 Chrome 受控网页补齐跨段内容：旧段有 `browser before boundary`，新段有 `browser after boundary`，旧段不包含后者且不再增长。 |
| 真实浏览器与网站规则 | 同标签页 `one.html → two.html → 被排除的 localhost → one.html`；允许页面内容及 URL 更新入库，查询参数/片段标记、合成密码/API Key、禁止页面文字和 URL 未落盘，回到允许页面后恢复采集。 |
| 录制中 App 菜单退出 | 修复本地 API 的 SSE 退出阻塞后，从实际 History 页面菜单退出；1,048 ms 内出现 `will-quit`/`quit`，无 5 秒强制退出告警，Desktop/Agent/recorder 子进程结束且文件稳定。Memory 按既有设置常驻，随后单独清理测试实例。 |
| 摘要、检索与图标 | 本机 HTTP 模型替身生成摘要并显示在生产快照；生产检索读取真实录制摘要的副本，Mac capture policy 保留；真实条目 HTTP pin/unpin 通过。真实原生图标 helper 及 TS 适配读取 TextEdit/Safari PNG 通过。未调用真实模型服务。 |
| 原生 helper 打包冒烟 | 实际编译的 `human-recorder` 和 `app-icon` 经 Electron 从 ASAR unpacked 路径执行，在无 Swift 的 PATH 下分别完成权限探测和图标读取。没有替代安装版签名、权限身份及 AX 采集验收。 |

首轮修复了本机运行条件和测试替身：根目录 `better-sqlite3` 原为 ABI 139，与 Node 22 的 ABI 127 不符，重编译后 SQLite 探测及 Memory 启动通过。共用模型替身最初缺少 Memory 所需的 `summary` 字段，触发重复摘要/embedding 作业；补齐合成字段后待办处理一次并停止重复，见 `model-fixture-shape-fix.json`。

接续真机退出检查发现实际缺陷：隐藏窗口仍持有 `/api/events` SSE 订阅，Fastify 的关闭过程等待长连接，触发 Desktop 的 5 秒强制退出兜底。后端现在在 `preClose` 结束现有事件流；鉴权在关闭期间完成时返回带 `Connection: close` 的 503，避免新流或 keep-alive 阻塞退出。真实 HTTP 用例在修复前失败、修复后通过，实际 App 随后正常退出，见 `followup/server-lifecycle-before.log`、`followup/backend-api-tests.json`、`followup/app-quit-after-fix.json`。未改变正常运行时的鉴权、采集隐私规则或测试跳过条件。

隔离记录：接续时发现临时 App 数据库残留 `scan_and_write_skill`，引导页显示了本机 Agent 会话线索。已将这个临时数据库的扫描权限设为 `none`，并关闭临时配置中的自动扫描、文件监听和技能注入。该类引导页内容未用作受控 History 证据，也未调用真实模型推理，见 `followup/isolation-correction.json`。History 的默认拒绝规则始终保留。

权限探测最初为辅助功能/输入监控未授权；用户暂不授权。随后只读探测均返回已授权，本轮未改动系统权限开关，不能据此认定拒绝→重新授权流程已完成。第一轮桌面工具无法将测试窗口置前，真实 Cocoa 输入/热键由用户协助；后续浏览器、跨段及菜单退出已由桌面工具完成。最终进程清理结果见 `followup/cleanup.json`，分层结果总表为 `mac-acceptance/results.json`。

同日生成 Apple Silicon 安装测试包 `App/shell/desktop/release/Memmy-1.1.8-darwin-arm64-cn-history-regression-20261002-adhoc.dmg`，版本仍为 1.1.8，包含本轮后端退出修复。该包为 CN/phone 配置、ad-hoc 临时签名，未做 Apple 公证。包内 13 项检查通过：严格递归签名、ASAR 边界/版本、退出修复与编译产物一致、源包元数据保持、运行时资源、环境文件排除、arm64 helper 签名、第三方 Computer Use 签名保留，以及实际打包 Electron 中三份 SQLite 加载、真实 History helper 执行和 Mac 摘要 CLI。helper 仅执行只读权限探测及图标读取，未进行安装后的桌面采集；未调用真实模型。打包器将开发依赖 SQLite 改为 Electron ABI 139 后，已恢复为 Node ABI 127 并确认内存查询通过。构建和包内证据位于 `/tmp/memmy-history-validation/mac-package/`。

### 同日安装版验收

用户安装到 `/Applications/Memmy.app` 并开启权限后，校验安装版 ASAR 与测试包一致，原生 helper 和生产 API 均返回辅助功能/输入监控已授权。安装版证据为 `/tmp/memmy-history-validation/installed-app/results.json`：16 项通过、1 项未确认、1 项未执行。这是安装版检查项计数，不与前述 512 项自动测试相加。

- 在现有用户配置中暂时将采集范围收紧为 TextEdit、Chrome 和 `127.0.0.1`，保留原有历史。新建的合成测试文档最终保存于证据目录；原生事件确认 A/B 文字实际落盘。通过生产 API 暂停/恢复，通过真实页面开关停止/重启；暂停和停止期间文件稳定，专用阴性标记未落盘。
- Chrome 同标签页访问受控页面一、页面二、排除的 `localhost` 页面，再返回允许页面。页面正文、搜索词和 URL 更新有阳性证据；合成密码、API Key、查询参数、片段、禁止页面文字及 URL 未落盘。21:40 实际轮换，旧段有边界前搜索词，新段有边界后标记，旧段不再增长。中途锁屏，用户解锁后继续完成检查。
- History 页面显示 TextEdit/Chrome 图标及实际模型生成的测试摘要。模型沿用安装版配置和既有摘要上下文，未替换成 fixture；摘要生成通过，但存在把文档正文误述为文件名、从单次测试推断用户偏好的事实精度问题。原生事件仍明确区分 `AXWindow` 标题与 `AXTextArea` 内容，因此不能把这一质量问题认定为 Mac 采集或共享层抽取回归。另用安装包中的生产检索实现检索隔离复制的真实摘要，通过；这项属于受控调用，不代表聊天端到端检索验收。
- 实际 History 页面处于录制中时，通过 Memmy 菜单退出。主进程及当时的全部 7 个后代进程（含 Agent、recorder）结束，未见强制退出告警，事件文件随后稳定。退出耗时记录包含工具调度间隔，不能作为精确性能指标。测试开始前已存在的常驻 Memory 和第三方 OpenComputerUse app-agent 保留；没有将它们当作 History 孤儿进程。
- 桌面工具能修改目标应用，但 AX 定向动作不会保证切到系统前台；通过 Finder 打开测试文档/应用后才取得真实采集证据。多次合成停止热键未产生全局键盘事件或 `stop_hotkey`，所以安装版全局热键仍为未确认，不据此判定产品失败，也不沿用开发版用户实体按键的通过结果。权限拒绝→重新授权的完整流程未执行，本轮没有操作系统权限开关。

验收结束后按字节恢复原观察设置，关闭受控网页、文档与目录窗口，移除测试应用链接并停止本地网页服务器。Memmy 保持退出；测试记录保留以供检查，未删除用户已有历史。详情见 `cleanup.json`、`quit-results.json` 和 `real-model-results.json`。

**阶段判断：自动回归、开发版及安装版已执行的 Mac 功能检查通过，退出缺陷已在安装版验证。** 可以继续下一阶段功能开发；完整 Mac 验收仍保留安装版实体停止热键和权限拒绝/重新授权两项，真实摘要的事实精度需另行改进。

## 2026-10-02 Windows 基线结果

统一入口报告目录：`D:/memmy-cpp-env/history-baseline-artifacts/computer-history-validation-aMwSLD`。该路径是本机证据位置，其他机器应运行入口生成自己的报告。

| 检查 | 结果 |
|---|---|
| 共享/Mac/Windows 业务、HTTP、工作流和技能 | 411 通过，6 个平台/权限条件跳过，0 失败 |
| 前端（包括两平台模型同步） | 84 通过，0 失败 |
| 跨包协议与现有 Mac ASAR 布局 | 10 通过，1 个 Mac Electron 执行用例跳过 |
| 生产 EXE + 重新编译的 Node CLI 生命周期 | 3 通过；1 个前台内容用例按本阶段范围过滤 |
| 类型、相关源码/测试 lint、Agent 编译、两条摘要 CLI、前端生产构建 | 通过 |
| C++ Release / Debug | 均确认构建无待更新；各执行 `unit`、`win.boundaries`、`integration.cli_contract` 三个 CTest 入口，全部通过 |

原生 C++ 本次只重跑上述三个入口；较早的全量 16 通过/16 前台条件跳过记录见原生 README。本次没有将完整交互套件重新验收。前端构建仍有现有的大 chunk 体积提示，不影响本阶段构建通过。

## 2026-10-03 Windows 安装包与默认范围对齐

验证基点为 `07a7a85d`，包含前述 Windows 核心、产品接入和 Mac SSE 修复；本节记录在该基点上的本轮工作区改动。初始工作区干净，已从用户 fork origin 安全同步；没有推送 upstream，也没有使用 Claude Code。

Windows 新配置改为与 Mac 相同的默认应用范围：用户确认开启后观察支持的应用，可额外排除或切换到仅选定模式，不要求先逐项选择。已有 Windows v1 文件缺少 `defaultApplicationBehavior` 时保留原白名单；不存在文件时才使用 `observe` 默认值，且保持停止状态。产品层把范围编译为真实 PID/规范路径/进程创建时间，最多 512 个实例；原生层不接受通配匹配。密码、普通 Edit、敏感子树、已知浏览器和锁屏/登录/屏保表面继续过滤。Windows 尚不具备 Mac 浏览器 URL/网站规则或图标功能，不能将默认范围对齐称为完整功能对等。

Windows NSIS 构建现在使用 `-ProductionOnly` 编译静态 CRT 的 Release helper，随包分发 EXE 和 nlohmann/json 许可证，不带源码、fixture、故障注入 EXE 或 PDB。两个 Windows builder 配置均显式解包 helper；安装版只使用 `app.asar.unpacked` 中的固定路径并忽略开发覆盖，缺少包内组件则报错。打包后校验要求实际 x64 PE 文件存在。Windows 停止热键为 `Ctrl+Alt+Shift+R`，在原生暂停或前台应用不在范围时仍可停止；停止组合键不进入内容事件。

本机证据根目录：`D:/memmy-agent/App/shell/desktop/release/history-validation-20261002/`。目录与安装包被 Git 忽略，仅在本机，其他机器须重新生成。

| 层级 | 实际结果与证据 |
|---|---|
| 最终统一自动回归 | **523 通过、0 失败、8 明确跳过**：Agent 420、前端 87、跨包/ASAR 13、原生生命周期 3。类型、lint、编译、两条摘要 CLI 和前端构建通过。总表：`final-aligned/computer-history-validation-gwQ2b0/results.json`。 |
| 后端本地 API | **60 通过、0 失败**，包含 3 个真实 HTTP SSE 退出用例；11 个文件，独立于统一计数。`backend-local-api.json`。 |
| 原生 Release / Debug | **各 33 个 CTest 入口通过、0 失败、0 跳过**；含实际前台 fixture、竞态/超时/父进程退出、输入钩子和停止热键。`native-release-mac-aligned.xml`、`native-debug-mac-aligned.log`，原始 Debug 证据在 `native-mac-aligned/debug/`。Release EXE 574,976 bytes（561.5 KiB），Debug 3,363,840 bytes，不随包分发。 |
| 打包防护回归 | **28 通过、0 失败**：20 项运行时配置/ASAR 防护和 8 项版本防护，`packaging-guards-aligned.json`。新增缺 helper、非法 PE 和夹带原生测试源码的断言实际执行；3 项 Windows ASAR/Electron 检查已包含在统一计数，不重复相加。 |
| 原生 TS 适配器最新独立复跑 | **3 通过、1 前台条件跳过**，`native-adapter-aligned-executed.json`；窗口激活失败的 `fixture-precondition.json` 保留在 `native-adapter-aligned/`。更早 `native-adapter.json` 为 4 通过；后者不是最新复跑结果。误用环境变量的一次运行 4 项明确跳过，保留在 `native-adapter-aligned.json`，不计通过。 |
| 最终包内预检 / 安装版预检 | **各 6 项通过、0 失败**：包内 helper、默认范围就绪且不自动开始/旧空白名单拒绝、三份真实 SQLite 查询、共享摘要 CLI。`packaged-aligned-fixed/preflight.json`、`installed-aligned/preflight.json`，独立于统一计数。 |
| 安装版产物与源码对应 | Desktop EXE、ASAR、helper 三份 SHA-256 与最终包一致；7 个 Windows 生产 JS 模块和后端 SSE 文件共 **8/8** 与当前编译产物一致。`installed-aligned-hashes.json`、`installed-source-matches-aligned.json`。 |
| 安装版生产组件 + Win32 fixture | **14 项通过、0 失败**，`installed-components-aligned-fixed/results.json`。实际安装 Electron、包内 EXE、隔离数据目录和模型替身；不代表 Desktop UI 或真实模型。 |
| 实际 Desktop + 真实模型 | **9 项检查通过、0 失败**，`installed-ui-aligned/real-acceptance-results.json`；实际页面开始/停止，生产 API 暂停/恢复，受控原生文字与敏感过滤、真实模型摘要和隔离副本的生产检索。实体热键、托盘正常退出仍未执行，不并入通过数。 |

统一入口的 8 项跳过逐项为：Windows 不具备 POSIX 子进程信号语义；本机无文件 symlink 创建权限；Mac Swift 分类/同窗口 URL；Mac 鼠标命中/拖动；Unix helper 可执行权限；Mac 原生 ingest；Mac Electron/Swift 包内执行；Windows 前台内容用例按统一入口范围过滤。最后一项不能代替交互采集验收；Release/Debug 前台原生检查另有上述独立结果。

新增“无需选应用直接开始”的页面测试首次因 mock 未返回 Promise 而失败，修正替身后全部通过；报告 `final-aligned/computer-history-validation-gLr2Sv/` 保留。没有删断言或降低隐私要求。更早的 508/517/521 基线均为不同源码阶段，不作为本轮最终计数。

初始 unsigned 包的受控组件检查 `installed-components/results.json` 为 13 项通过，包括实际墙钟 06:10→06:20 UTC 分段、暂停/恢复/停止、敏感过滤、合成热键、异常 recorder 退出和受控生产检索；模型使用 fixture，没有调用真实模型，也没有代表 Desktop UI 操作。该包采用旧白名单与旧弹窗布局，保留为 `Memmy-1.1.8-win32-x64-cn-unsigned-before-picker-fix.exe`（SHA-256 `9BD93B115FF4A02E20DBFF45487B677B7E483004E543150991403E80E9F11A3C`），不能作为新默认范围的安装版证据。

最终打包前的只读预检发现 SQLite ABI 缺陷：开发环境曾恢复根目录 SQLite 到 Node ABI 137，但 `.forge-meta` 仍为 `x64--139`；electron-rebuild 根据该标记跳过重建，根目录错误二进制进入包。`packaged-aligned/preflight.json` 实际加载失败，不能以打包器 exit 0 认定该包可用。失败包保留为 `Memmy-1.1.8-win32-x64-cn-unsigned-abi-failed.exe`。修复后，Windows 打包每次明确安装 Electron 目标 ABI，并在最终打包 Electron 中对 Desktop/Memory/Agent 三份 SQLite 实际执行内存查询；不再仅依赖 PE 格式或重建缓存标记。最终安装包按此流程重建，具体结果另列。

### 最终安装测试包

产物为 `D:/memmy-agent/App/shell/desktop/release/Memmy-1.1.8-win32-x64-cn-unsigned.exe`，版本 **1.1.8 / Windows x64 / CN phone / NotSigned**，Memory 版本 2.1.3。NSIS 大小 **355,098,553 bytes（338.6 MiB）**；原生 helper 大小 **574,976 bytes（561.5 KiB）**，无需 .NET 或目标机编译工具。该文件是本机测试包，未签名、未正式发布。

| 文件 | SHA-256 |
|---|---|
| NSIS 安装包 | `8E666DA2FAC2EE28719154C981A8ADCB2E351468A5AD2BCDC512AD36AD31B729` |
| Desktop Memmy.exe | `7144FE4423D18B39788EB2C9D5EFFCF07C7B0E10AB8B690857390A53EC7CBDA5` |
| app.asar | `270356F5312FA00CB98F18B630EF15A50CA571B9C411562F5196F24EF834654C` |
| memmy-history-recorder.exe | `2E77D871EF8F0397F0523C18FB0EAE712C5124D61AD58DA6CB02BE0F52945E1B` |

使用本机已校验的 nlohmann/json header、既有完整 embedding 模型离线资源，在重新编译 Agent/前端和生产 helper 后从 Windows 构建脚本的打包阶段接续，未移除打包防护。构建日志 `win-1.1.8-x64-cn-unsigned-20261003-145357.log` 中 NSIS 已生成，但后置校验最初因 `cygpath` 不能转换 ASAR 虚拟子路径退出 1。修复为转换实际 ASAR 路径后拼接内部相对路径，重新执行完整后置校验成功，日志 `win-1.1.8-x64-cn-unsigned-20261003-152224.log`；此修复仅涉及校验脚本，包内代码未变。具体 hash 见 `final-package-hashes.json`。

安装器于本地时间 2026-10-03 15:24 完成，exit 0，安装位置为 `C:/Users/zephyr/AppData/Local/Programs/Memmy`。安装版与包内三份实际文件逐一匹配，helper 固定在安装目录的 `app.asar.unpacked` 内；预检刻意提供无效 binary 覆盖和无编译工具 PATH，仍执行包内 helper。安装后实际 Desktop/Memory/Agent SQLite 查询通过。打包后开发根目录 SQLite 已恢复为 Node 24.21.0 / ABI 137，真实内存查询通过，见 `development-sqlite-restored.json`。Electron 为 38.4.0 / ABI 139，Python 为 3.12.14，C++ 为 VS 2022 v143 / MSVC 19.44 x64。

### 安装版受控组件与实际界面

最终 14 项组件检查使用真正的安装版生产模块和原生 helper。`applications: []`、默认 `observe` 时可直接采集 fixture；为隔离测试，其余当时运行的应用均排除，所有内容事件的 EXE 均为 fixture。实际墙钟 **07:20→07:30 UTC**（本地 15:20→15:30）跨段，旧段有边界前阳性标记且随后稳定，新段有边界后阳性标记。暂停/恢复/显式停止、合成全局停止热键、异常 recorder Node 父进程退出后进入失败、撤销范围停止均通过。模型替身产生 5 次请求，生产检索为受控调用；这些结果不属于真实模型、实体输入或聊天端到端验收。

首次最终组件脚本 `installed-components-aligned/results.json` 为 6 通过、1 失败：切换 `applications: []` 时验收脚本丢失了 fixture 自定义敏感 ID `1007`，随后检查整个追加文件时发现该合成面板内容。该面板不是密码框，没有系统敏感标识。修正脚本将同一 ID 放入全局 `sensitiveAutomationIds` 后保持空应用规则，全部 14 项通过；没有改变产品过滤、删除断言或使用真实敏感数据。**密码标志、普通 Edit、脱敏正则和明确配置的敏感 ID 有过滤保证，不能声称可自动识别任意业务敏感面板。**

实际 Desktop 新配置初始就绪但停止，页面直接开启时出现确认框，不要求先选应用。真实模型检查临时将范围收紧为唯一 Win32 fixture，配置搜索 `1003`、文档 `1006`、敏感子树 `1007`，保留其他应用排除，沿用本机已配置的 **BYOK gpt-5.5** preset；仅合成 QA 文字进入采集/模型。API 的 `model_preset: null` 首次返回 `model_selection_unavailable` 422，验收脚本改用已有明确 preset 后成功，没有修改凭据。模型请求未拦截，因此不报告精确请求次数。

真实页面确认开始后，包内 helper 采集 Heliotrope/Friday 等合成静态文字和授权文档；生产 HTTP API 暂停/同段恢复，暂停期间文件保持 **12,978 bytes**，暂停阴性标记未落盘。实际页面开关停止后文件稳定，确认停止后阴性标记未落盘，且无原生 collector 残留。普通 Edit/子节点、密码/子节点、敏感面板和合成 API key 明文均未落盘，有 `[REDACTED]` 阳性证据。一次 UI 停止动作因工具的 `coordinate input geometry is unavailable` 失败，API 仍为 running；取得新截图后坐标点击成功，只有第二次确认停止后的标记作为阴性对照。

真实模型生成并在页面显示 **Heliotrope synthetic QA fixture**，保留 Windows capture policy；内容对应合成项目说明、计划 Friday 发布和恢复后的 QA 文字，未观察到此次样本推断偏好的问题，不能据单一样本宣布先前摘要质量问题已解决。安装包生产检索实现读取隔离复制的真实摘要，查询 Heliotrope 命中；这是受控调用，**没有验证聊天端到端检索**。页面中的可选范围弹窗已确认列表可滚动、底部取消/刷新/保存可见；未通过 UI 改动范围设置。

真实 Desktop 首次启动耗时约 31.5 秒，启动日志为 ready 但主窗口空白，`Ctrl+R` 后界面恢复。这是本轮实际遇到的启动界面问题，根因未定位，不能标为无问题启动。证据位于 `installed-ui-aligned/` 的生产 API 快照、隐私审计、合成事件副本、真实摘要和 `cleanup.json`；该目录未提交到 Git。

验收结束后通过生产 API 恢复有效原范围，并恢复原 Windows settings 文件不存在的状态；store 按调用重新读取文件，不需修改现有用户配置或历史。测试窗口/host 已关闭，App 保持打开且采集停止，合成历史保留。安装前关闭旧 App 用的是强制进程树清理，仅为替换文件前准备，**不代表正常退出验收**。

### 尚需手动或后续验证

1. 实体键盘：在受控测试范围启动记录，真实按下 `Ctrl+Alt+Shift+R`，确认 UI 停止、JSONL 的停止原因及 collector 退出；本轮仅有 C++/安装版组件的软件注入结果。原生 paused 热键通过不证明产品服务 paused 热键，因为服务暂停会关闭 recorder。
2. 正常退出：在受控录制中右键系统托盘 Memmy 图标→“退出 Memmy”，确认 Desktop/Agent/recorder 全部结束、事件文件稳定、无强制退出告警。当前桌面工具无法定位托盘菜单；窗口右上角关闭按现有逻辑隐藏 App，不能视为退出。
3. 安装版首次空白界面的根因、IME、多屏/DPI、系统锁屏、真实应用兼容与长时间稳定性，以及正式签名仍未完成。本轮没有扩展 Windows 浏览器/Office/WPS。

## Windows 首帧交接、退出收尾与安装版复验（2026-10-03）

本轮接续 `6fe3655f`。此前安装版的启动日志已 ready，但窗口空白，需要 `Ctrl+R` 才恢复；源码确认 Windows 主窗口创建时立即可见，且在 `did-finish-load` 时关闭 splash，该事件并不保证首帧已绘制。现改为 Windows 完整窗口初始隐藏，收到 `ready-to-show` 后显示并关闭 splash；加载失败、30 秒首帧超时、退出期间的迟到事件仍受原有生命周期控制。Mac/Linux 的初始可见和页面加载交接保持原行为；本机仅运行平台分支替身测试，没有再次进行 Mac 实机验证。

### 自动回归与证据层级

本机证据目录为 `D:/memmy-agent/App/shell/desktop/release/startup-diagnostics-20261003/`。报告、截图和安装包均未提交到 Git。

- 修复前加入首帧断言，`startup-before-20261003.json` 为 **18 通过、1 失败**，失败证明原主窗口在首帧前已显示。修复后的启动页、启动生命周期和窗口模式三组测试为 **64 通过、0 失败、0 跳过**，报告为 release 下的 `startup-final-20261003.json`。Windows checkout 的窗口模式源文本检查统一 CRLF/LF，保留所有断言。Desktop TypeScript 检查和编译通过。
- 退出收尾新增 **10 项**真实本地 HTTP 与生产 cleanup 顺序测试，覆盖认证、等待响应体结束、空闲 409、认证/停止失败、超时、Windows 先排空后终止及 Mac/Linux 原顺序。连同上述三组重新执行为 **74 通过、0 失败、0 跳过**，见 `exit-drain-regression-20261003.json`；这是重跑后的定向结果，不能与 64 相加。
- 真正 Electron + 新包内 `createMainWindow`、renderer、preload 的隔离检查为 **4 通过**：初始隐藏、页面加载不提前交接、首帧交接、真实 React 页面渲染。`packaged-probe/results.json` 与 `paint.png` 保留。使用独立用户目录、合成本地 API，拒绝外部请求；没有启动真实 Desktop 服务或调用模型。首次脚本因用户目录缺失及合成枚举不合法失败，修正脚本后通过，不将其当作产品失败或安装版验收。
- 新包和新安装目录的生产预检各 **6 通过**，分别见 `packaged/preflight.json`、`installed/preflight.json`。无效 helper 环境变量和空 PATH 下仍执行包内 EXE；Desktop/Memory/Agent 三份 SQLite 实际查询及共享摘要 CLI 均通过。三份安装文件与包内文件的 SHA-256 全部匹配，见 `installed-matches.json`。
- 扩大到 Desktop 全目录的首轮有效回归为 **431 通过、13 失败、0 跳过**，原始报告 `desktop-regression-20261003.json` 保留，不能写成全绿。更早受限环境的进程查询被拒绝，该轮中断，没有完整计数。13 项的后续定位如下，不能把定向复验拼成另一次完整回归总数：

| 首轮失败 | 定位与定向结果 |
|---|---|
| 9 项 dev CLI | 当前 PowerShell PATH 找不到 `bash`（ENOENT）。临时加入 Git Bash 后该文件 **9 通过、2 失败**；余下两项要求 POSIX 文件符号链接，Git Bash 在本机产生普通文件，断言仍失败，未跳过或删除。 |
| 1 项真实 Memory 重启 | 打包临时切换根目录 SQLite 到 Electron ABI 139。新 ASAR 生成后恢复 Node 24.21.0 / ABI 137，真实查询及该项重启复验通过。 |
| 1 项打包边界 | 多行源文本断言受 CRLF 影响；本轮未修改该测试，仍待修复。 |
| 1 项 Memory 强杀 | Windows 实际退出描述为 `code 1`，原测试要求 POSIX `signal SIGKILL`；本轮未修改断言，仍待平台适配。 |
| 1 项升级 relay | 默认 Vitest 5 秒预算先于用例已有的 10 秒业务时限终止。定向重跑仍失败；仅将框架预算设为 15 秒、保留原小于 10 秒断言后 **1 通过**。31 项是 testNamePattern 未选中的用例，非平台跳过；测试入口的预算仍待调整。 |

### 首帧修复测试包与实际启动

首帧修复包随后保留为 `D:/memmy-agent/App/shell/desktop/release/Memmy-1.1.8-win32-x64-cn-unsigned-before-exit-drain-fix.exe`，**1.1.8 / Windows x64 / CN phone / NotSigned**，大小 **355,096,041 bytes（338.6 MiB）**。沿用上一阶段已验证的完整 runtime/helper/embedding 资源，仅重新编译 Desktop 主进程并从当前 Windows 构建脚本的打包阶段接续；SQLite ABI 与资源后置防护全部执行，日志 `win-1.1.8-x64-cn-unsigned-20261003-160816.log`，构建 exit 0。此前安装包已保留为 `Memmy-1.1.8-win32-x64-cn-unsigned-before-startup-fix.exe`，其 `8E666D...` 校验值仅属于上一阶段。

| 新文件 | SHA-256 |
|---|---|
| NSIS | `9545FCBFDE95F1EB188E25FAA7EE0A202B0E96A64413571C6E3A13D9B99631C1` |
| Desktop Memmy.exe | `5F7F53665E22A40149C78C0EEA0DE61961D68499D9300C1011AF70204075A4F9` |
| app.asar | `6177D06FBDB8A217FA497CB91429F2CC71D7BA33DA7F9A404B70940FBC202BE4` |
| 原生 helper（未变） | `2E77D871EF8F0397F0523C18FB0EAE712C5124D61AD58DA6CB02BE0F52945E1B` |

用户从托盘正常退出旧 App，日志记录 `08:15:30 UTC quit:cleanup-start`；该次退出时采集已停止，只属于空闲退出证据。确认安装操作于本地 **16:18:27** 返回 exit 0；首个安装进程结束时未保留退出码，未启动 App 的情况下再次对同一包确认安装，见 `install-result.json`。

新安装版于本地 **16:19:18** 启动，无开发目录或 helper 覆盖。实际界面直接显示主页面，**没有使用刷新**；启动日志于 `08:19:29 UTC` 以 `main-ready-to-show` 交接，耗时 **9,974 ms**，随后 boot ready。见 `installed/startup-acceptance.json`、`startup-excerpt.log`。这是一个正常用户配置下的真实安装版启动成功样本；UI Automation 树仍不完整，按实际截图确认页面，不以空树判定空白，也不据一次成功承诺所有间歇绘制问题均已消除。

### 实体热键与录制中的托盘退出

实体热键使用唯一合成 fixture 范围。首轮等待期间先通过 API 停止并清理，用户回复在清理后到达，因此不能作为实体输入证据。第二轮保留自动监控，JSONL 于 **08:30:59.679 UTC** 写入 `stop_hotkey`，API 变为 stopped、segment 为 null，原生 collector 为 0，文件保持 **6,985 bytes**；阳性标记和敏感字段过滤审计通过。该轮跨十分钟边界，前段 `stop_command` 属于正常分段，后段 `stop_hotkey` 才属于实体停止。见 `manual-retry/hotkey-start.json`、`hotkey-stop.json`、`controlled-audit.json`。停止后的阴性命令响应未单独保留，故仅声称文件稳定，不声称完成独立阴性输入确认；自动化工具返回的页面图像与目标不一致，未据其宣称 UI 视觉停止状态。

用户在下一轮合成录制中于 **08:37:26 UTC** 从托盘退出。Desktop、Agent 和 collector 全部退出，文件停止增长，但 **缺少最终 `recording_stopped`**。`manual-retry/tray-before-fix-result.json` 保留失败，不能以进程消失替代完整退出验收。最初进程监控将所有 `Memmy.exe` 都视作 Desktop，因仍有 PID 7128 而失败；查询实际 Memory runtime/lock 及只读 App 设置后，确认它是用户配置 `stop_memory_service_on_exit = 0` 所允许的 Memory 服务，见 `tray-exit-role-audit.json` 和 `memory-exit-policy.json`。没有强制结束它，也没有修改退出设置。

Windows 的进程树强制终止绕过了 Agent 异步 shutdown。现于 Desktop 清理 runtime 前，通过 gateway bootstrap secret 换取临时令牌，再调用生产 stop API，等待 recorder 排空。两个请求及响应体共用 **3 秒**时限，保留既有 **5 秒**退出保护；服务不可用时记录收尾失败并继续进程清理。Mac/Linux 不增加该步骤。停止 API 仍不等待模型请求；本次修复验证原始事件完整写入，不能推导为退出前所有模型摘要已生成，已有重启恢复机制仍负责未完成摘要。

### 退出修复最终测试包

最终包为 `D:/memmy-agent/App/shell/desktop/release/Memmy-1.1.8-win32-x64-cn-unsigned.exe`，**1.1.8 / Windows x64 / CN phone / NotSigned**，**355,102,354 bytes（338.7 MiB）**。构建日志 `win-1.1.8-x64-cn-unsigned-20261003-165122.log`，耗时 **9 分 19 秒**，exit 0，ASAR、版本、SQLite ABI 与资源后置防护通过。本轮先遗漏 unsigned 参数，尝试中止后遗留的 builder 又干扰后一次输出目录；两次失败日志保留。确认所有旧 builder 结束后串行重建，没有安装失败产物。

| 最终文件 | SHA-256 |
|---|---|
| NSIS | `C43EAD1F0E4EC617E593927BE82BF172F2DD9740761C547B0BCAED112C077236` |
| Desktop Memmy.exe | `562A90EDD2B4BEB01865190F1B97CA68E3404CBC24E4A8A406FA7F9BBF545627` |
| app.asar | `C9D7EFD2BD813C37A72DD364907A6AC19DDCA272C3C8D4E5C97758BFC970184A` |
| 原生 helper（未变） | `2E77D871EF8F0397F0523C18FB0EAE712C5124D61AD58DA6CB02BE0F52945E1B` |

最终包与新安装版组件预检各 **6 通过**，见 `exit-drain-installed/packaged-preflight.json` 和 `installed/preflight.json`；三份安装文件校验全部匹配，安装于本地 **17:01:56** 返回 exit 0。安装版首次预检错误复用了包内预检已写入 legacy 设置的合成 profile，因 ready 断言失败；保留 `installed-preflight.json` 的 **1 通过、1 失败**，改用独立空 profile 后原断言全部通过。没有调整产品权限或断言。

新安装版于本地 **17:03:02** 启动，实际页面与 UI Automation 树均显示主页面，未刷新。`09:03:12.736 UTC` 收到 `main-ready-to-show`，耗时 **9,006 ms**，随后 boot ready，见 `exit-drain-installed/startup-acceptance.json`。打包后的开发目录 SQLite 已恢复 Node 24.21.0 / ABI 137，真实查询通过；包内保留 Electron ABI 139。

录制中的正常托盘退出修复仍需本次安装版复验结果。本地 **17:09:29** 五分钟等待窗口结束时，Desktop、Agent 和 collector 仍在运行，故 `exit-drain-installed/exit-processes.json` 的退出标志为 false；这是新包退出动作尚未完成的等待超时，不能算退出成功或一次产品退出失败。待退出后需重新保存进程证据，并验证停止事件发生在实际 `quit:cleanup-start` 之后，不能以十分钟轮转的 `stop_command` 代替最终退出事件。当前唯一 fixture 仍在受控录制，测试范围尚未恢复；用户原 Windows settings 文件不存在，实际退出及阴性标记审计后应恢复其原先不存在的状态并关闭 fixture/host。未强制结束 App、采集器或用户允许常驻的 Memory。IME、多屏/DPI、锁屏、长时间稳定性、正式签名及既有 Windows 浏览器/Office/WPS 限制继续保留。

## 交付边界

- Windows EXE 的构建、包内固定路径、必要许可证及 unsigned NSIS 分发已接入；正式代码签名尚未验收。
- Windows 实体停止热键已有一次真实安装版通过证据；IME、多显示器/DPI、系统锁屏行为、真实应用兼容性和长时间采集仍待验收。
- Windows 已知浏览器仍拒绝采集；Office/WPS 正文选择器和应用图标尚未产品化。
- 受控组件/fixture、真实安装版 UI、真实模型请求和聊天端到端检索属于不同层级，不能互相代替或合并计数。
