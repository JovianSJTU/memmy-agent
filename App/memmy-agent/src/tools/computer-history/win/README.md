# Windows Computer History 产品接入与 TypeScript 适配器

已接通独立 C++ UIA 采集器、共享 TypeScript 录制/摘要服务，以及 Windows 页面、应用授权和 HTTP 路由。安装包尚未集成 EXE。没有新增 npm 依赖，也不需要 .NET。

## 产品入口与开发配置

在启动 Agent 的终端设置 `$env:MEMMY_WINDOWS_HISTORY_BINARY = 'D:\memmy-cpp-env\native-core-review\release\memmy-history-recorder.exe'`，并编译 Agent。该变量必须指向生产版 EXE；默认仅查找编译后模块旁的同名文件。Computer History 页面在 Windows 显示“记录的应用”：列表发现本身不会授权，必须明确勾选应用后保存。保存选择先停止当前记录；可在准备开启时选择“保存并开始记录”。组件缺失、未选择应用或应用未打开时，界面显示对应原因，不启动采集。

Windows 持久配置默认是 `~/.memmy/computer-history/windows-settings.json`。初始 `applications` 为空；不读取 Mac 的默认全应用观察策略。配置格式为 `{version:1, applications:[{executable, searchFields?, documentRegions?, sensitiveAutomationIds?}], sensitiveAutomationIds?, deny?:{executables?}, limits?}`。选择界面保留原有精确选择器；新增应用默认不保留普通输入内容。高级规则可手动配置，修改前应停止记录。

`GET /api/computer-history/windows/settings` 返回配置、可选应用与 readiness；`POST` 的请求体为 `{settings: <完整配置>}`。两者要求现有 API token 和 Windows 宿主。应用列表仅含进程身份，不读取窗口标题或 UIA 内容。选中的 EXE 路径代表对该应用未来实例的授权；每次启动及每两秒刷新绑定真实 PID、规范路径和创建时间。刷新前等待暂停确认，应用关闭/撤销后使用明确拒绝的策略；设置损坏或刷新失败会停止采集。

服务沿用十分钟分段、摘要调度、保留/删除和工作流提取。暂停会关闭本次子进程，恢复可继续同一时间段的已正常关闭 JSONL，保持单个 metadata 和连续序号；中断或跨平台文件不能续写。Windows 的 `permissions.platform=windows` 与 `ready/reason` 表示组件和授权就绪，Mac 权限字段保持 false，界面不展示 Mac 系统权限向导。Windows 暂时只有历史检索工具，Mac 的 status/settings 工具不在 Windows 注册。

## 入口

先按 [原生构建说明](native/README.md) 构建生产版采集器。在 `App/memmy-agent` 中编译 TypeScript：

```powershell
node node_modules/typescript/bin/tsc -p tsconfig.build.json
node dist/tools/computer-history/win/record-human-history.js --help
node dist/tools/computer-history/win/record-human-history.js --binary "D:\memmy-cpp-env\native-core-review\release\memmy-history-recorder.exe" --policy "D:\history-validation\policy.json" --out "D:\history-validation\events.jsonl" --title "Windows validation" --seconds 30
node dist/tools/computer-history/core/summarize-history.js --file "D:\history-validation\events.jsonl" --out "D:\history-validation\summary.md"
```

路径必须是绝对路径；输出文件默认必须不存在。`--settings <绝对路径>` 可以替代 `--policy`，启用持久应用规则与实例刷新；二者互斥。`--append` 只允许续写正常结束的同平台文件。`--input-hooks` 开启动作元数据，产品服务默认开启。默认运行 30 秒，最大 86400 秒。stdin 接受 `pause`、`resume`、`stop`；EOF 和 Ctrl+C 会结束采集。CLI 的 stdout 输出 JSON 状态行，stderr 只输出固定诊断码。原生 stdout 一直被适配器读取，不会直接写入录制文件。不会自动搜索仓库、构建或下载 EXE；安装包复制和签名留给后续阶段。

## 授权与数据

- 原生协议见 [PROTOCOL.md](native/PROTOCOL.md)。适配器严格校验 UTF-8、消息类型、字段、序号、sessionId、时间顺序和大小上限。启动消息必须对应自己创建的子进程，生产入口拒绝 testHooks 构建。
- 只采集显式策略授权的应用，PID、规范化 EXE 路径和可选 HWND / 创建时间必须匹配。`compileWindowsPolicy()` 将长期规则绑定当前实例，包括进程创建时间。发现应用不等于授权；deny 优先，已知浏览器仍然拒绝。改名浏览器和嵌入网页不能仅凭 EXE 名称识别，仍受普通应用的节点过滤约束。
- Windows 应用使用 `windows:<EXE 路径 SHA-256>` 标识，不伪装为 Mac bundleId。不将 Mac 的默认全应用观察策略或权限布尔值视为 Windows 授权。
- full/delta 先重建为完整树，再独立检查父子层级、重复键、输入框授权、密码状态、敏感标识、子树裁剪与文本预算。无基线的 delta、上下文/策略改变后的 delta、部分结果后的 delta 都会拒绝。阻断快照、暂停和恢复会清空基线。
- 只有脱敏后的 `human_history_metadata` / `human_event` JSONL 落盘。Windows 节点保存为通用 `accessibility` 结构；Mac 原有 AX 字段及旧导入路径兼容保留。UIA 的触发通知不转换成虚构的点击或键盘动作。真实低级钩子可提供点击位置、滚动方向、导航键及有限快捷键；普通文本键只记录次数，AltGr 的可打印键身份也被清除。不能将这些次数当成字数或 IME 上屏文字。密码、敏感或未知焦点不输出键盘动作。
- 动作与授权快照一起校验 HWND、前台/焦点 generation 和最终提交条件，最多 64 条，丢失通过 `actionOverflow` 表示。`injected` 标识软件注入；摘要保留此限制。点击目标与结果没有通过钩子证明，工作流不能把坐标当成稳定目标。低级输入与 WinEvent/UIA 的异步顺序仍可能漏记；该链路不提供无遗漏的输入审计保证。
- `updatePolicy()` 先等待暂停确认，再替换策略文件并重建基线；失败保持暂停。应用重启后必须重新绑定 PID 与创建时间。宿主应独占策略修改，避免外部进程并发改写文件。
- 退出码为 0、收到终止消息、hooksDetached 为 true 且全部输出排空，才写 `recording_stopped`。异常退出、损坏协议、写盘错误均使录制失败；不将中断录制误标为成功。写盘是同步有界操作；调用方的磁盘和 `onEvent` 回调应保持响应。

共享摘要先生成 `summary_state: pending` 的机械元数据，再由 `compactEventEvidence()` 和 `writeSegmentNarrative()` 进入现有模型摘要链路。离线测试使用模型替身，不消耗真实模型请求。模型提示词明确指出 UIA 的可见性是 provider 报告，不能证明用户阅读或像素可见。

## 验证

日常回归优先在仓库根目录运行统一入口：

```powershell
node scripts/internal/shared/validate-computer-history.mjs
```

入口覆盖共享业务、Windows 接入、前端、类型、lint 和构建，并保存逐项报告。可通过 `--native-bin <绝对构建目录>` 加入生产 EXE 的生命周期验证。平台条件、跳过原因及 Mac 接续步骤见 [阶段基线与验证说明](../VALIDATION.md)。

下面是从 `App/memmy-agent` 目录直接运行适配器测试的入口；设置二进制目录后会尝试前台内容测试，属于交互验证：

```powershell
node node_modules/vitest/vitest.mjs run tests/tools/computer-history/win --maxWorkers=2
$env:MEMMY_WINDOWS_HISTORY_TEST_BIN_DIR = 'D:\memmy-cpp-env\native-core-review\release'
$env:MEMMY_WINDOWS_HISTORY_TEST_ARTIFACTS = 'D:\memmy-cpp-env\ts-adapter-review-artifacts'
node node_modules/vitest/vitest.mjs run tests/tools/computer-history/win --maxWorkers=2
```

未设置测试二进制目录时，真实 C++ 用例明确跳过。设置后运行生产 EXE 的启动、暂停、恢复、EOF、时长退出，以及受控 Win32 fixture 的隐私和摘要链路。内容用例需要解锁的交互桌面并取得前台；失败前提会明确跳过并保留 `fixture-precondition.json`，不能视为内容采集通过。所有测试只关闭自己创建的子进程，证据保留在测试目录。

共享/Mac 业务回归已纳入统一入口。目录逃逸在 Windows 使用 junction 实测；文件 symlink 权限不足和 POSIX 信号用例明确跳过。本机 Windows 无法替代 Swift / AX、Unix helper 权限与 Mac 真机回归。

2026-10-02 接入阶段历史证据：生产 C++ 的受控 fixture 内容采集成功过一次，记录位于 `D:\memmy-cpp-env\ts-adapter-review-artifacts\ts-native-adapter-ne4ynr\events.jsonl`，同目录 `summary.md` 为共享 CLI 生成的机械摘要。后续运行遇到前台激活限制会明确跳过内容用例，不能作为稳定性验收。原生 Release/Debug 最近全量重跑各 16 项通过、16 项因前台前提跳过。真实模型服务和 Mac Swift 真机行为仍待对应环境验证。

产品接入阶段的真实 Node 入口 + 生产 EXE 完成启动、暂停、同段恢复及撤销授权，证据在 `D:\memmy-cpp-env\product-integration-artifacts\ts-native-adapter-*\product-service-result.json`。当前生产 EXE 为 572,928 bytes（559.5 KiB），PDB 不作为运行依赖。

当前回归范围与结果以统一入口的 `results.json` 为准，包含先前遗漏的 Windows 模型同步测试。独立子进程的退出也会等到 stdout 排空、终止状态校验通过才结束观察；退出码 0 或旧 stop marker 不能单独代表成功。

后续范围：EXE 打包/签名、Windows 桌面 App 真机验收、动作与 IME/DPI/多显示器兼容验证和长时间采集；浏览器上下文仍未支持。产品接入与自动测试不等于已经达到 Mac 真机的完整功能对等。
