# Computer History 阶段基线与 Mac 接续

本阶段包含 Windows C++ 采集核心、TypeScript 适配、共享业务服务、Windows 应用授权与页面接入。目标是建立可重复的开发基线；安装包集成、Windows 前台交互兼容性及浏览器/Office/WPS 专项适配属于后续阶段。

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
4. 用两个 Vitest worker 执行共享/Mac/Windows 业务、HTTP、工作流、技能注册、前端、跨包协议与现有 Mac ASAR 布局测试。
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

## 交付边界

- Windows 原生 EXE 的构建/分发、ASAR 外路径与签名尚未接入安装包。
- Windows IME、多显示器/DPI、锁屏、真实应用和长时间采集仍需交互验收。
- Windows 浏览器上下文仍拒绝采集；Office/WPS 正文选择器尚未产品化。
- 本阶段验证没有开启真实模型服务，没有将本机通过结果当成 Mac 真机结果。
