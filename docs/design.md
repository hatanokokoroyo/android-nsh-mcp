# 设计说明（决策记录）

本文件记录 M1 之前与需求方确认的决策，以及实现里的关键取舍，便于后续随 NSH 一起迭代时回看。

## 1. 定位：方案 B —— NSH 开发回路

| 候选 | 结论 |
|---|---|
| A. 薄 adb 封装 | 否。agent 仍得自己拼验证闭环，价值低 |
| **B. NSH 开发回路** | **是**。设备控制面 + `nsh run/package` 编排 + 视觉验证，随 NSH 版本一起演进 |
| C. 通用 Android 调试台 | 否。远超需求，维护成本高 |

落地节奏上「按 A 的粒度实现 B」：v1 先把「看 / 点 / 读」做扎实，`nsh` 编排放 M2。

## 2. 形态：独立 MCP server，内部按 core/adapter 分层

- 形态 1（独立 MCP，stdio）→ 可被 pi / Claude Code / opencode 等复用。
- 内部形态 3（core 库 + 薄适配）→ 以后加 pi extension 或 HTTP 版只加适配层。
- 仓库独立：`~/project/android-mcp`（命名不绑定 pi）。

## 3. 连接模型：Windows 持有 adb server，WSL 复用（零 USB 转发）

实测结论（2026-11-14，本机）：

| 观测 | 值 |
|---|---|
| 设备 | Redmi 2510DRK44C，Android 17 (API 37)，arm64-v8a，USB 挂在 Windows |
| WSL 侧 5037 监听 | 无 |
| Windows 侧 5037 | LISTENING（adb server） |
| `/dev/bus/usb`、`vhci`、`usbipd` | 均无 → 不是 USB 透传 |
| `adb devices`（WSL） | 正常看到设备 → 经 mirrored loopback 复用 Windows 的 server |
| `adb reverse tcp:8790` | 注册成功 |
| Windows → WSL `127.0.0.1:8790` | 实测可达（`HELLO-NSH` 回环验证） |

结论：**不需要 usbipd**；`nsh dev` 的 8790 热更新链路天然成立。唯一依赖是 `.wslconfig` 的 `networkingMode=mirrored`。

**风险与退路**：若用户改回 NAT 模式，WSL 的 adb 客户端就连不到 Windows 的 5037。此时退路是把手机 USB 直通给 WSL：

```powershell
winget install usbipd
usbipd list
usbipd bind --busid <手机 busid>
usbipd attach --wsl --busid <手机 busid> --auto-attach
```

`doctor` 会在 `adbServer=forwarded-to-windows` 且 `mirrored=false` 时明确提示这条退路。

## 4. 文本输入：三级策略

`adb shell input text` 只吃 ASCII。决策：**以应用自建通道为主（3），ADBKeyboard 为备用（1），ASCII 兜底**。

M1 实现 `ascii` + `adbkeyboard` 两级；`app` 级留接口（`typeText(..., { appText })`），M2 与 NSH 应用侧 `host.handle("dev.text")` 一起落地。

ADBKeyboard 细节：`am broadcast -a ADB_INPUT_B64 --es msg <base64>`，输入前后自动切换/还原用户输入法；未安装时给出安装命令而不是静默失败。

## 5. 元素定位：testID 优先

优先级：`testID`（落在 `resource-id`）> 文本/`content-desc` > 坐标。

应用侧约定（已写入本仓 `AGENTS.md`，M2 时同步到 NSH 应用的 `AGENTS.md`）：每个交互验证点必须有 `testID`，kebab-case 语义命名；渲染层可随意改，`testID` 是稳定接口。

## 6. 安全边界

- `shell` 默认关闭，需 `ANDROID_MCP_ALLOW_SHELL=1`。
- 只对 `device` 状态的设备动作（`unauthorized` 明确提示去手机上授权）。
- 输出上限：日志 5000 行、元素树 2000 节点、shell 20KB。

## 7. 性能取舍

| 操作 | 实测耗时（API 37 / 1156×2510） | 结论 |
|---|---|---|
| `devices` | ~30 ms | 随便调 |
| `screenshot`（含缩放到 800） | ~900 ms | 常用于「看一眼」 |
| `ui` dump | **2.7–3.1 s** | 昂贵：必须配 `wait_for`，避免轮询 |
| `logcat`（50 行，过滤） | ~300 ms | 便宜 |

元素树昂贵但语义密度高（一次 dump 就能拿到整屏可点元素与坐标），因此设计上**优先 `ui`+`wait_for`，截图用于确认视觉细节**（颜色/间距/排版这类 dump 看不出来的东西）。

## 8. 里程碑

- **M1（已完成）**：`devices / doctor / screenshot / ui / wait_for / tap / swipe / input_text / key / logcat / crashes / app / shell`，13 个工具；`doctor` + `smoke` 两条 CLI 自检。
- **M2**：`nsh` 编排（`nsh run --target android` 起停、日志解析、崩溃摘要）、`app` 级文本通道、按包名自动抓 NSH 运行时错误。
- **M3**：视觉回归（同屏截图差异比对）、登记进 pi-dotfiles 的 `pi-hacks` skill、把 testID 约定同步到 NSH 应用仓库。

## 9. 待验证 / 未决

- NSH 应用的 `testID` 具体落到 `resource-id` 还是 `content-desc`：M1 的 `findByTestId` 两者都试。**已用 hello world 验证**：无 testID 时文本节点的 `resource-id` 为空、`text` 有值；`onPress` 映射为可点的 `Button` 壳。待有真实应用后再确认 testID 的落点。
- 长文本输入（>200 字符）在 ADBKeyboard 下的稳定性，以及是否需要分片。
- 多设备/无线调试场景：`adb connect` 掉线后的自动重连策略（当前只报错提示）。
