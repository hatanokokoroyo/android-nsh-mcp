# AGENTS.md — android-nsh-mcp 项目约定

## 定位

**方案 B：NSH 开发回路**。本仓库不是通用 Android 调试台，服务对象是「用 NSH 写安卓应用时的 agent 自验证闭环」：

```
改 TSX → nsh run --target android → (本仓库) 截图 / 元素树 / 点击 / 读日志 → 判断改对没有 → 再改
```

所以取舍上永远优先「让 agent 自己看见并判断」，而不是「把 adb 命令包一层」。

## 分层纪律（形态 1 + 内部形态 3）

- `src/core/**`：**零 MCP 依赖**的纯逻辑。任何新能力先写进 core，可被 CLI（`scripts/*.ts`）直接验证。
- `src/mcp/server.ts`：只做 zod 参数校验、结果整形、错误翻译。**不放业务逻辑**。
- 未来若要做 pi extension / HTTP 版，只新增适配层，不改 core。
- 新增工具的顺序固定为：core 函数 → `scripts/smoke.ts` 覆盖 → 注册 MCP 工具 → README 表格补一行。

## 安全边界

- `shell` 工具默认关闭（`ANDROID_MCP_ALLOW_SHELL=1` 才开）。任何「顺手加个执行任意命令的入口」的改动都不接受。
- 只允许对 **debug/授权过** 的设备操作：`resolveSerial` 会拒绝非 `device` 状态的设备，不要绕过。
- 日志/元素树/shell 输出必须有上限（分别为 5000 行、2000 节点、20KB），避免灌爆上下文。

## 连接模型

- 默认依赖：Windows 持有 adb server + `.wslconfig` 的 `networkingMode=mirrored`，WSL 复用其 loopback。
- 不要假定 `adb` 在 PATH：走 `findAdb()` 的发现顺序。
- 任何「设备/连接」类问题，先跑 `devices` 或 `doctor`，不要在代码里加猜测式重试。

## 文本输入约定（与 NSH 应用侧的契约）

三级策略，优先级从高到低：

1. **`app`：应用自建调试通道（首选）** —— NSH 应用用 `host.handle("dev.text", ...)` 之类暴露一个受控入口，MCP 通过 `adb shell am broadcast` 或宿主通道注入文本。**这是主选方案**，因为它绕过 IME、不打断用户输入法、支持任意 Unicode。
2. **`adbkeyboard`：ADBKeyboard IME（备用，已实测可用）** —— 广播 base64 文本，结束后还原用户原来的输入法。
3. **`ascii`：`adb shell input text`** —— 仅 ASCII，兜底。

M2 落地第 1 级时，需要在 NSH 应用里加一个只在 debug 构建启用的 handler，签名建议：

```ts
// NSH 应用侧（debug only）
host.handle("dev.text", ({ text }) => { /* 写入目标输入框 */ })
```

## NSH 应用的 testID 约定（定位稳定性）

元素定位优先级：

1. **`testID`（首选）** —— NSH 应用给关键可交互控件设置 `testID`。实测它出现在 uiautomator 的 `resource-id` 里（形如 `pkg:id/<testId>`），因此 `ui({ idContains })` 与 `waitFor({ testId })` 能稳定命中。
2. 文本 / `content-desc` —— 文案随 i18n 变化会脆。
3. 坐标（`screenshot` + `tap x/y`）—— 最后手段。

**应用侧要求**：每个交互行为验证点（按钮、输入框、列表项、Tab）都要有 `testID`；命名用 `kebab-case` 表达语义，如 `login-submit`、`todo-item-3`、`settings-toggle-dark`。渲染层（Tailwind 类名、布局层级）可以随便改，`testID` 不能随便改——它是 agent 与 UI 之间的稳定接口。


## 实测观测：NSH 组件的元素形态（2026-11-14，API 37）

用 `nsh init --template ts` 的 hello world 在真机跑通后，uiautomator dump 得到的映射：

```
n2 android.view.ViewGroup "0" {}        @578,1195   ← <Text>{count()}</Text>
n3 Button "" {click}                    @578,1375   ← <View onPress> 的可点壳（clickable 在它身上）
n4 android.view.ViewGroup "Tap" {}      @578,1375   ← 里面的 <Text>Tap</Text>
```

三条要记住：

1. **`onPress` 渲染成可点的 `Button` 壳**，文本节点是它的子节点 —— 判定「能不能点」要看外层 `Button {click}`，不要只看文本节点。
2. 文本节点的 `text` 属性有值、`resource-id` 为空（未设 testID 时）。所以按文本定位在英文界面可行，但**文案一变就断**，必须靠 testID。
3. 设了 `testID` 后应出现在 `resource-id`（形如 `com.longbridge.nsh.host:id/<testId>`），`ui({ idContains })` / `waitFor({ testId })` 依赖这一点；首次给真实应用加 testID 时要复核一次。

推论到定位策略：**testID 打在 `onPress` 所在的那个可点元素上**，而不是内部文本上。

## 代码风格

- TypeScript 用 **可擦除语法**（Node 直接运行，无构建）：不用 `enum`/`namespace`/参数属性。
- 依赖导入写显式 `.ts` 后缀（Node 原生 TS 的 ESM 要求）。
- 对外错误信息要「可操作」：说明现象 + 下一步怎么做（例：`状态是 unauthorized → 请在手机上点「允许 USB 调试」`）。
- 不自造图片/日志压缩等基础设施：截图缩放用 pngjs，日志用 adb 自带缓冲。

## 提交前自查

```bash
node scripts/doctor.ts && node scripts/smoke.ts
```

两项都必须全绿再提交。
