# android-nsh-mcp

Android 设备控制面 + NSH 开发回路的 **MCP server**（stdio）。

给 agent 用的一句话：**它能让我看见手机屏幕、看懂界面结构、点得准、读得到日志，从而自己验证改对了没有。**

## 能力（M1，13 个工具）

| 工具 | 作用 |
|---|---|
| `devices` | 列设备、型号/系统/ABI，选定默认目标 |
| `doctor` | 体检 adb、adb server 归属（WSL 本地 vs 复用 Windows 的）、mirrored 网络、`adb reverse` 可用性 |
| `screenshot` | 截屏返回 PNG（默认长边 1200，可 `crop` 指定区域细看） |
| `ui` | uiautomator 元素树：`uid/cls/text/desc/id/bounds/clickable`，可按文本/id/类名过滤 |
| `wait_for` | 在设备上轮询等某文本/testID 出现或消失（省 token 的关键） |
| `tap` | 点 `uid` 或坐标 |
| `swipe` | 滑动/滚动 |
| `input_text` | 输入文本（ASCII 直连；非 ASCII 走 ADBKeyboard） |
| `key` | back/home/recents/enter/… 或任意 `KEYCODE_*` |
| `logcat` | 读日志，支持 level/tag/grep/pid/包名过滤 |
| `crashes` | 聚合 crash buffer 的崩溃与 ANR（带头部与 Java/Kotlin 帧） |
| `app` | install / launch（带启动耗时）/ stop / clear / foreground / packages |
| `shell` | 逃生舱，**默认关闭**（需 `ANDROID_MCP_ALLOW_SHELL=1`） |

## 快速开始

```bash
# 1. 依赖（Node >= 22.18，直接跑 TypeScript，无构建步骤）
npm install

# 2. 体检（不需要经过 MCP）
node scripts/doctor.ts

# 3. 冒烟：把 M1 的能力全跑一遍
node scripts/smoke.ts

# 4. 作为 MCP server 启动（通常由客户端拉起）
./scripts/serve.sh
```

注册到 pi（用户级 `~/.pi/agent/mcp.json`）：

```json
{
  "mcpServers": {
    "android": {
      "command": "/home/kokoro/project/android-nsh-mcp/scripts/serve.sh",
      "description": "Android 设备控制面 + NSH 开发回路：截屏/元素树/点击/输入/logcat/装应用",
      "timeout": 120,
      "env": { "ANDROID_HOME": "/home/kokoro/Android/Sdk" }
    }
  }
}
```

改完用 `/reload`（或 `pi mcp list`）确认 `android: connected, 13 tools`。

## `adb` 从哪里来

优先级：`$ADB_BIN` → `$ANDROID_HOME/platform-tools/adb` → `$HOME/Android/Sdk/platform-tools/adb` → `/usr/lib/android-sdk` → `PATH` 里的 `adb`。

## 环境依赖

- **Android SDK**：`platform-tools`（`adb`）。本仓库只用 adb，不需要 Gradle/Android Studio。
- **非 ASCII 输入**（可选）：设备上装 [ADBKeyboard](https://github.com/senzhk/ADBKeyBoard)

  ```bash
  curl -L -o /tmp/ADBKeyboard.apk https://github.com/senzhk/ADBKeyBoard/raw/master/ADBKeyboard.apk
  adb install -r /tmp/ADBKeyboard.apk
  ```

  没装时 `input_text` 只能输 ASCII（会给出明确提示，不会静默失败）。

## 在 WSL2 里的连接模型（重要）

本机实测形态：**USB 挂在 Windows，adb server 跑在 Windows，WSL 的 adb 客户端经 `networkingMode=mirrored` 的共享 loopback 复用同一个 server。**

```
手机 ──USB──> Windows ──adb server(127.0.0.1:5037)──┐
                                                    │ mirrored 共享 loopback
WSL 的 adb 客户端 ──────────────────────────────────┘
```

推论：`adb reverse tcp:8790 tcp:8790` 的落点是 **Windows 的 loopback**，再由 mirrored 网络转发进 WSL → NSH 的 `nsh dev` 热更新链路成立，**不需要 usbipd**。

代价：这依赖 `.wslconfig` 里的 `networkingMode=mirrored`。`doctor` 会检测并解释；若改成 NAT 模式，退路是 usbipd-win 把 USB 直通给 WSL（见 `docs/design.md`）。

## 目录结构（core / 传输层分离）

```
src/
├── core/            # 纯逻辑，零 MCP 依赖：可被 MCP / CLI / extension 复用
│   ├── exec.ts      # 子进程封装（Buffer 友好、永不抛）
│   ├── adb.ts       # 设备解析、adb 调用、doctor
│   ├── screenshot.ts
│   ├── ui.ts        # uiautomator dump 解析 / 查找 / 等待
│   ├── input.ts     # 点击、滑动、文本（三种输入法）、按键
│   ├── logcat.ts    # 日志与崩溃聚合
│   └── app.ts       # 应用生命周期
└── mcp/server.ts    # 只做参数校验 + 结果整形 + 错误翻译
scripts/
├── serve.sh         # stdio 入口（补齐 PATH）
├── doctor.ts        # CLI 体检
└── smoke.ts         # 端到端冒烟
```

同样的 `core/` 以后可以直接给 pi extension、CLI 或 HTTP 版复用。

## 已知限制

- `ui` 一次 dump 约 1–3 秒且期间界面会短暂停顿 → 用 `wait_for` 代替轮询。
- `uiautomator` 只看得到有意义的原生控件；画布/自绘区域拿不到节点，退化用 `screenshot` + 坐标点击。
- 无线调试（`adb connect`）断线后需重新连接；`doctor` 会指出设备不在线。
- `shell` 等于设备上的任意代码执行，默认关闭。
