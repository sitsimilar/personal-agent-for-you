# Android APK 与多端同时在线（v2.15）

> 目标：**同一个账号能在 Android 手机与 Windows 桌面端同时在线**，并产出可直接安装的 APK。
> 本文只写「怎么做的、为什么这么做、怎么验」；功能背景见 `docs/版本说明.md`。

---

## 1. 结论先行

| 问题 | 结论 |
|---|---|
| Android 用什么壳 | **Capacitor 6 本地打包**（dist 进 APK assets），源站 `https://localhost` |
| 为什么不远程 WebView | 远程托管会让「登录源站」随域名/分享码漂移，且断网即白屏 |
| 会话是否要改造 | **不需要**。云 SDK 每次登录发独立 refresh 句柄，服务端不互相吊销，多端本就并发可用 |
| 真正要补的是什么 | ① 谁在线/几台（设备注册表）② 前台恢复不 401（会话守护）③ 能请某一台下线 ④ `updated_at` 不推进导致并发判定失真 |
| APK 产物 | `mobile/dist/personal-agent-2.13.4-debug.apk`（可装、可运行、可直接调云 API） |

---

## 2. 为什么是 Capacitor（选型对比）

| 方案 | 首屏 | 登录/CORS | 升级 | 结论 |
|---|---|---|---|---|
| **Capacitor + 本地 dist** | 本地 assets，断网可开 | WebView 源站 `https://localhost`；云端点实测回显该 Origin（`Access-Control-Allow-Origin: https://localhost`，允许头含 `X-Device-Id`） | 发新 APK，`versionCode` 单调递增 | ✅ 采用 |
| TWA（Trusted Web Activity） | 依赖网络 | 源站是线上域名，天然无 CORS 问题 | 换 APK 或靠 PWA 更新 | 需要 `assetlinks.json` + 站点可写，且离线能力反而弱 |
| 远程 `server.url` WebView | 依赖网络 | 同 TWA | 改线上即生效 | 包体小，但「分享码/域名一换，已装的包全废」——项目历史踩过（`main/app-url.ts` 的自愈逻辑就是为这个加的） |
| React Native 重写 | — | — | — | 工作量数量级不同，否决 |

关键约束（写进 `web/src/lib/pwa.ts` 与测试）：

- **必须 `androidScheme: 'https'`**：`http://localhost` 是非安全上下文，`crypto.subtle`（云 SDK 的 PKCE）、`navigator.serviceWorker`、剪贴板全不可用 → 微信登录与提醒静默失败。
- **原生壳里不注册 Service Worker**：资源本就在 APK 里，多一层 SW 只会让「升级 APK 后页面还是旧的」（WebView 的 Cache Storage 不随 APK 版本清理）。

---

## 3. 构建配置（新增 / 修改）

### 3.1 新增文件

| 路径 | 作用 |
|---|---|
| `mobile/package.json` | 壳工程依赖：`@capacitor/core|android|app@6.2.3`、`@capacitor/cli`、`typescript`（`capacitor.config.ts` 需要 TS） |
| `mobile/capacitor.config.ts` | `appId=com.personalagent.mobile`、`webDir=../web/dist`、`androidScheme=https`、`webContentsDebuggingEnabled` 由 `CAP_DEBUG` 控制 |
| `mobile/scripts/build-apk.mjs` | 一键构建：**web build → cap sync → gradle → 产物归一 + sha256** |
| `mobile/scripts/make-android-icons.py` | 图标/启动图生成（复用 `web/public/icons/icon-512.png`，不重画几何） |
| `mobile/.gitignore` | 忽略 `local.properties`、`keystore.properties`、`*.jks`、`assets/public` |
| `mobile/android/**` | `cap add android` 生成的 Gradle 工程（已改造，见下） |
| `docs/ANDROID-MULTI-DEVICE.md` | 本文 |

### 3.2 改造的 Android 工程文件

| 文件 | 改动 | 为什么 |
|---|---|---|
| `android/app/build.gradle` | `versionName/versionCode` 从**根 `package.json`** 读取；`versionCode = major*10000+minor*100+patch`；`signingConfigs` 按 `keystore.properties` 是否存在决定；**v1/v2/v3 三种签名方案显式开启**；**`buildTypes.debug` 也用同一把 release 密钥** | 版本只维护三处（root/web/desktop），不在 gradle 另开第四处；签名配置必须**先于** `buildTypes` 声明，否则 Gradle 报 `Could not find method release()`；debug/release 若各用各的证书，同包名互相覆盖会报「应用未安装」（详见 §7.0） |
| `android/variables.gradle` | `minSdkVersion 22 → 23` | Android 6.0 起 WebView 可独立升级，PKCE 才可用 |
| `android/app/src/main/AndroidManifest.xml` | `allowBackup=false`、`usesCleartextTraffic=false`、`windowSoftInputMode=adjustResize` | localStorage 里存着会话，不能被云备份带走；明文流量一律禁 |
| `android/app/src/main/res/values/colors.xml` | 新增，品牌色 `#5B54D9` 等 | 模板只引 `@color/colorPrimary` 却没给文件 |
| `res/mipmap-*/ic_launcher*.png`、`drawable*/splash.png` | 26 个资源全部换品牌图 | 默认是 Capacitor 蓝色机器人 |
| `android/local.properties` | `sdk.dir=...`（**不入库**） | Gradle 找 SDK 的唯一入口 |

### 3.3 根 `package.json` 脚本

```bash
npm run build:android          # debug APK（可装，WebView 调试开）
npm run build:android:release  # 签名包（需 mobile/android/keystore.properties）
npm run android:icons          # 重出图标 / 启动图
```

---

## 4. 登录校验（改了什么、没改什么）

### 4.1 没改的部分（本来就是对的方向）

- 手机号验证码登录：`sendOtp → verifyOtp`，一次性 `verificationId`，前端 60s 冷却 + 防重复提交。
- 凭据存 **localStorage（不是 Cookie）**——Cookie 会被兄弟子域共享，这是已识别的越权面。
- 每台设备各持一个 refresh 句柄，服务端**不会**因为新登录而吊销旧会话 → 多端并发登录本身就是合法状态。

### 4.2 新增的三道校验

1. **登录即登记设备**：`deviceRegistry.register()` 写 `(owner_id, device_id)`；
   已存在则 `update`（顺带把 `revoked_at` 清空——重新输验证码说明人在机器前，「请下线」不是「封禁」）。
2. **前台恢复校验会话**：`sessionGuard` 在 `visibilitychange / focus / online` 时 `getSession()`。
   云 SDK 只在临近过期时才真打 `/v1/token`，所以这不会变成频繁请求；但能消掉「手机切后台一夜，回来满屏 401」。
3. **被注销感知**：心跳回读自己的 `revoked_at`，非空即本地 `signOut()` + 提示
   「本机已被其它设备退出登录」。**边界必须说清**：SDK 没有按会话踢人的管理接口，
   这里做的是「让对方下次心跳自行登出（≤60s）」，不是服务端立刻吊销令牌。

### 4.3 平台差异化

| 场景 | 处理 |
|---|---|
| 微信扫码登录 | 原生壳内**隐藏**。OAuth 回跳地址是 `window.location.origin`，在 Capacitor 里是 `https://localhost`，微信开放平台不可能回跳到这里 |
| 通知可达性 | 新增 `native` 一档：「安卓 App · 仅应用内提醒」。WebView 不提供 Web Notification，说「已安装就能收系统通知」是骗用户 |
| Service Worker | 原生壳内跳过（见 §2） |
| 设备标签 | `Windows · 桌面端` / `Android · 手机` / `Windows · Chrome`，写进 `devices.label` |

---

## 5. 多端会话逻辑

### 5.1 数据模型

```sql
-- docs/v2.14/migration.sql 第 5 节（已执行）
public.devices(
  id, owner_id, device_id, platform, label, app_version,
  created_at, last_seen_at, revoked_at
)
UNIQUE (owner_id, device_id)      -- 一行一台设备
INDEX  (owner_id, last_seen_at DESC)
RLS    owner_id = auth.uid()      -- select/insert/update/delete 四条
```

**为什么不复用 `settings` 的 JSONB 桶**：`settings` 是「单行账户配置」，
两台设备并发写同一行必然互相覆盖（手机改主题把电脑的静音时段冲掉）。
`devices` 一行一台，各自只写自己的 `last_seen_at`，没有写冲突。

### 5.2 运行期时序

```
登录成功 ──► register()            插入/刷新本机行（revoked_at=null）
    │
    ├─ 每 60s（仅前台）──► heartbeat()   只写 last_seen_at，回读 revoked_at
    │                                    └─ revoked_at 非空 → signOut + 提示
    ├─ 切前台/联网 ─────► getSession() + heartbeat(force)
    └─ 设置页 ─────────► list()  → 「已登录设备」卡片（本机 / 在线 / 最近活跃）
                              └─ revoke(deviceId) → 对方 ≤60s 自行登出
```

节流：`HEARTBEAT_MIN_INTERVAL_MS = 55s`（前台反复切标签不该每切一次写一次库）；
`force=true` 只在「恢复前台」时用——那一刻的在线状态必须准。

### 5.3 并发写冲突：`updated_at` 之前是假的

真库实测：`public` 下**一个触发器都没有**，`records.updated_at` 只有 `DEFAULT now()`
→ UPDATE 从不推进它。后果是多端并发时无法判断谁后写（LWW 失效），
`listByUpdatedSince`（项目健康检查）与离线库按 `updatedAt` 淘汰全部失真。

修复：`BEFORE UPDATE` 触发器 `pa_touch_updated_at()` 挂在 `records` / `settings` 上。
选触发器而非在每个 service 里手写 `updated_at: now()`，是因为后者**漏一处就永久静默失真**。

### 5.4 明确不做的（写进已知限制，不假装支持）

- **提醒双弹**：两台设备都会为同一条待办弹提醒。要彻底解决需要「提醒归属设备」，
  属于产品决策（谁该闭嘴？手机还是电脑？），不在本次实现范围。
- **离线写入合并**：离线库的 `dirty` 队列是**按设备**的，两端同时离线改同一条记录，
  后同步的一方覆盖先同步的一方（LWW）。没有做字段级合并，也没有做冲突 UI。

---

## 6. 关键实现步骤（可复现）

```bash
# 0) 工具链（本机原来没有 JDK/SDK，装在 ASCII 路径下避免 aapt2 中文路径问题）
#    JDK 17 → %USERPROFILE%\pa-toolchain\jdk
#    Android SDK cmdline-tools → %USERPROFILE%\pa-toolchain\android-sdk
#    sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"

cd personal-agent/mobile
npm install --registry=https://registry.npmmirror.com
echo 'sdk.dir=C\:\\Users\\<you>\\pa-toolchain\\android-sdk' > android/local.properties

cd .. && npm run android:icons          # 图标 / 启动图（需先有 web/public/icons/icon-512.png）
npm run build:android                 # = web build → cap sync → gradle assembleDebug → dist/
```

签名包（一次性）：

```bash
"$JAVA_HOME/bin/keytool" -genkeypair -v -keystore mobile/android/app/pa-release.jks \
  -alias personal-agent -keyalg RSA -keysize 2048 -validity 10000
# 写 mobile/android/keystore.properties（storeFile/storePassword/keyAlias/keyPassword）
npm run build:android:release
```

> ⚠️ `keystore.properties` 与 `*.jks` 已 gitignore。**私钥丢了就无法覆盖升级**（只能卸载重装，
> 本地数据丢失）；私钥泄露则别人能发同包名假包覆盖你的应用。请自行备份。

---

## 7. 验证方法

### 7.0 安装失败排障（2026-11-16 实机反馈「无法安装」的复盘）

**先说结论：包本身是健康的。** 可自查的四项（都已实测通过）：

| 检查项 | 值 / 手段 |
|---|---|
| 签名 | `apksigner verify --verbose` → v1 / v2 / v3 **全 true**，证书 `CN=Personal Agent` |
| 最低系统 | `minSdk 23`（Android 6.0）；`targetSdk 34` |
| 架构 | 无 `lib/*.so`（Capacitor 走系统 WebView，不存在 ABI 不匹配） |
| 完整性 | `unzip -t` 无错；release 8.69 MB / debug 9.46 MB |

**第一号成因：同包名、不同证书。** 11-16 之前的构建里，`debug` 走
`~/.android/debug.keystore`（`C=US, O=Android, CN=Android Debug`），`release` 走
`android/app/pa-release.jks`。两者 `applicationId` 都是 `com.personalagent.mobile`，
Android 判定为 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`，界面上只显示「应用未安装」——
先装过 debug 包的人，再装 release 包 **100% 失败**，反之亦然。

已修：`buildTypes.debug` 也绑定 `signingConfigs.release`，两个包证书指纹现在完全一致
（`540b04c8…`），可互相覆盖升级。构建日志会打印签名指纹，以后一眼可查。

> **升级到本次修复包时仍需卸载一次**：手机上若已装过旧 debug 包（Android Debug 证书），
> 它与新包证书不同，必须先卸载。之后所有版本都能直接覆盖升级。

**按提示文案对照处置：**

| 手机上的提示 | 成因 | 处置 |
|---|---|---|
| 「应用未安装」／「与已安装的应用签名不一致」 | 上面说的签名冲突 | 卸载旧的「个人信息管家」→ 再装 |
| 「解析软件包时出现问题」 | 文件损坏：微信/QQ 接收后常被改名成 `.apk.1`，或传输被截断 | 核对大小 8.69 MB（release）/ 9.46 MB（debug）；改名回 `.apk` 再试 |
| 「禁止安装未知来源应用」 | Android 8+ 的安装来源授权 | 设置 → 应用 → 特殊权限 → 安装未知应用 → 给「文件管理/浏览器」授权 |
| 「检测到风险应用，已阻止安装」 | 华为/荣耀「纯净模式」、小米「安全检测」 | 关闭纯净模式 / 在弹窗里选「仍要安装」 |
| 「您的设备不兼容」／无详情直接失败 | 系统低于 Android 6.0（minSdk 23） | 无法安装，需 6.0+ |
| 点击后毫无反应 | 文件管理器没有 APK 关联 | 用「文件」App 长按 → 打开方式 → 软件包安装程序 |

**adb 直装（最省事，能直接看到失败码）：**

```bash
adb install -r mobile/dist/personal-agent-2.13.4-release.apk
# 签名冲突会明确报：INSTALL_FAILED_UPDATE_INCOMPATIBLE
# 卸载后重试：
adb uninstall com.personalagent.mobile && adb install mobile/dist/personal-agent-2.13.4-release.apk
```

### 7.1 自动化（已纳入 `npm run test:qa`）

`qa/device-sessions.test.ts`（26 例）：

- 纯函数：平台判定优先级（桌面桥 > 原生桥 > UA）、设备标签、UUID 形态、`formatLastSeen` 边界、
  `isDeviceOnline` 5 分钟窗口、`isMissingTableError` 只认 `42P01`；
- 接线：`startSessionGuard` 必须在 `getSession()` 之前挂载、注销必须真的 `signOut`、
  断网不踢人、注册表必须 `revoked_at: null`、不允许把自己点下线；
- 壳工程：`appId/webDir/androidScheme`、`INTERNET` 权限、明文流量关、`allowBackup=false`、
  `minSdk 23`、版本号取自根 `package.json`、26 个图标/启动图文件齐全、签名材料已 gitignore。

```bash
cd personal-agent && npm run typecheck:web && npm run test:qa && npm run build:web
```

### 7.2 真机（只能人工）

- [ ] **先卸载手机上的旧版本**（若有；旧 debug 包是另一套证书，装不上是预期行为，见 §7.0）→
      `adb install -r mobile/dist/personal-agent-*.apk`（或把 APK 传手机点击安装）
- [ ] 打开 App → 手机号验证码登录成功；桌面端**同时**保持登录不掉线
- [ ] 设置页「已登录设备」显示 2 台：`Android · 手机`（本机）、`Windows · 桌面端`，都标「在线」
- [ ] 桌面端改一条记录标题 → 手机端下拉刷新可见；反向同理
- [ ] 在桌面端点「退出该设备」→ 手机端 ≤60s 内回到登录页并提示
- [ ] 手机切后台 10 分钟再回来 → 不出现满屏 401（`getSession()` 已续期）
- [ ] 断网启动 App → 仍能进入界面（本地 assets），列表显示离线缓存 + 断网条幅
- [ ] 杀进程重开 → 登录态保留（localStorage 持久化）

### 7.3 数据库侧验证

```sql
-- 设备是否登记（应能看到两台，last_seen_at 在 1 分钟内）
select device_id, platform, label, app_version, last_seen_at, revoked_at
from public.devices order by last_seen_at desc;

-- updated_at 现在会动了：改一条记录后
select id, created_at, updated_at from public.records order by updated_at desc limit 3;
```

---

## 8. 已知限制

1. **提醒双弹**（见 §5.4）：未做设备级提醒归属。
2. **离线写冲突**：LWW，无字段级合并、无冲突提示。
3. **iOS**：`capacitor.config.ts` 保留了同构配置，但未生成 iOS 工程，也未验证。
4. **WebView 版本下限**：依赖系统 WebView 可升级到 Chromium 100+（Android 6.0 及以上默认满足）；
   极老的国产 ROM 若锁定 WebView 版本，`crypto.subtle` 会不可用 → 登录失败。
5. **未接入系统推送**：锁屏/杀进程后收不到提醒（需要 FCM 或厂商推送通道）。
