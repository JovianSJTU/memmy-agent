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
