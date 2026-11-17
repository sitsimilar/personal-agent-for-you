# 背景氛围系统升级 — 完整改动清单

> 对应 PR：待填　提交日期：2026-11-17　产品：个人信息管家 v2.13.4 → v2.14（UI 呈现层升级）
> 范围：**只改 `web/src/` 呈现层 + `qa/` 截图脚本**。未碰 service 层、后端、数据库、Electron 主进程。未引入新 npm 依赖。未执行 git 操作。

---

## 一、改动概要

| 模块 | 文件 | 操作 | 说明 |
|---|---|---|---|
| 主题类型与参数元信息 | `web/src/lib/backdrop.ts` | **新增** | 四档主题类型、四参数元信息（名称/范围/步进/刻度/安全上限理由）、每主题推荐默认值、`normalize*` / `clamp*` / `isBackdropDefault` |
| 参数编译 → CSS 变量 | `web/src/lib/backdrop-style.ts` | **新增** | 把主题+参数编译成 `--bd-*` 变量：颜色 alpha 在 JS 里合成（Canvas 可直接用）、线宽 0.6–1.6px、模糊 0–4px + 线宽补偿、速度→时长的指数映射、`--bd-run` 停帧开关 |
| Zustand store 扩展 | `web/src/store/uiSchemeStore.ts` | **扩展** | 新增 `backdrop` 与 `backdropParams[theme]`；`setBackdrop` / `setBackdropParam` / `resetBackdropParams` / `refreshBackdropPalette`；`localStorage` 升到 v2（兼容 v1），深浅色切换后重算颜色；**只写 localStorage**，不写账号 |
| 渲染宿主组件 | `web/src/components/AmbientBackdrop.tsx` | **新增** | `OrbitLayer`（4 环黄金分割 + 3 轨道错开起始角度 + 虚线十字 + 动态卫星点）、`CanvasLayer`（星野 30fps 封顶、等高线画一次 + CSS 平移）、模糊 >1px 自动线宽补偿、`prefers-reduced-motion` 只画一帧 |
| 设置页参数面板 | `web/src/components/BackdropCard.tsx` | **新增** | 四主题瓦片点选 + 四参数滑杆（当前值、刻度、改动圆点、恢复默认） + 取值范围与安全上限 + 减弱动效提示 |
| 顶栏快捷切换 | `web/src/components/SchemeSwitcher.tsx` | **扩展** | 弹层底部新增四个背景胶囊：关闭 / 轨道线 / 星野 / 等高线；点选即时生效，底部提示 6 秒内可撤销 |
| 设置页路由 | `web/src/pages/SettingsPage.tsx` | **扩展** | 在 `UiSchemeCard` 之后插入 `<BackdropCard />` |
| 应用外壳 | `web/src/components/Layout.tsx` | **扩展** | 根 Box 加 `isolation:'isolate'`，第一个子节点渲染 `<AmbientBackdrop />`；`main` 加 `position:'relative', zIndex:1` |
| 深浅色切换后 | `web/src/main.tsx` | **扩展** | `applyThemeAttribute` 末尾调 `refreshBackdropPalette()` 重算背景颜色 |
| 设计令牌 | `web/src/index.css` | **扩展** | 新增 20+ `--bd-*` 变量；`.bd-layer`（fixed z0 pointer-events:none）；`.bd-orbit` 细化版（4 环独立 opacity + 3 轨道 `translate3d + will-change` 强制 GPU 合成 + 错开初始角度 + 延时 offset + 虚线半幅十字线 + 节点 box-shadow 光晕）；`prefers-reduced-motion` 轨道/地形停动画 |
| 截图 + 验收脚本 | `qa/backdrop-capture.cjs` | **新增** | 4 档主题 × 浅深 × 桌面/窄屏、12 张面板、极值 max/maxline/min、模糊 0/2/4px 单参数对照、reducedMotion 探针、滑杆交互验收 |

---

## 二、新增 / 修改的设计令牌

### `web/src/index.css`（`:root[data-theme="light"]`）

```css
--bd-ink-rgb:       24 24 27;     /* 背景色 RGB 三元组（正文反色） */
--bd-accent-rgb:    91 84 217;    /* 品牌色 RGB 三元组（轨道节点、重点环） */
--bd-dot-a:         0.3;          /* 星野 / 轨道节点 的基准 alpha */
--bd-line-a:        0.1;          /* 环线 / 十字线 的基准 alpha */
--bd-accent-a:      0.2;          /* 品牌色环 的基准 alpha */
--bd-dot / --bd-line / --bd-accent / --bd-stroke-w / --bd-blur
--bd-layer-opacity: 0.85;
--bd-spin-duration: 147s;         /* 外环周期；×0.71 = 次外环，×0.42 = 中环 */
--bd-spin-duration-b: 91s;        /* 兼容旧命名 */
--bd-drift-duration: 174s;        /* 等高线单程 */
--bd-run: running;                /* 速度 0 → paused */
```

深色覆盖（`[data-theme="dark"]`）：`--bd-ink-rgb: 242 242 246; --bd-accent-rgb: 140 134 255; --bd-dot-a: 0.62; --bd-accent-a: 0.3`

### 主题 + 参数编译（`lib/backdrop-style.ts`）

```
强度 0–100% → 线宽 0.6–1.6px × blurComp(模糊补偿)
              颜色 alpha = 基准 × 强度（JS 合成 rgba）
速度 0–100  → 轨道 480s → 45s（指数映射，慢端细腻）
              等高线 600s → 50s
              0 → animation-play-state: paused（真停帧）
模糊 0–4px  → CSS filter: blur()（只挂装饰层）
              >1px 时线宽乘 1 + (模糊-1)/3 × 2.2（只加宽不加 alpha）
透明度 0–100% → --bd-layer-opacity
```

### 每主题推荐默认值

| 主题 | 速度 | 强度 | 模糊 | 透明度 |
|---|---|---|---|---|
| 关闭 | 0 | 90% | 0px | 80% |
| 轨道线 | 50 | 92% | 0px | 92% |
| 星野 | 50 | 92% | 0px | 94% |
| 等高线 | 50 | 90% | 1px | 90% |

---

## 三、硬约束落实（全部通过）

| 约束 | 落地方式 | 验证 |
|---|---|---|
| 首屏不被阻塞 | `hydrateLocal` 首帧前同步落地（微秒级）；Canvas 首帧只画一次、不进 rAF | 探针：`canvasSize` 正确、无首帧白屏 |
| 正文对比度不变 | 背景层 `z-index:0` + `pointer-events:none` + `aria-hidden`；正文在 `--surface` 实体卡片上 | 每组 `main.scrollWidth = viewport.width`，横向无溢出 |
| `prefers-reduced-motion` 自动静态化 | CSS 停轨道/地形、星野只画一帧不进 rAF；参数改值仍生效（静态重绘） | 探针：reducedMotion 上下文 `animation: none` |
| 一键关掉 | 设置页「关闭」+ 顶栏胶囊，都即时生效、可撤销 | `off` 时 `layer:false`、`canvas:false`、滑杆全 disabled |
| 不引大体量依赖 | 纯 CSS/SVG + Canvas 2D + 自写 2D value noise；package.json / lockfile 未改 | — |
| 参数极端不卡顿 | 速度 0 = 真停帧；强度/模糊/透明度都有安全上限并 clamp | 拉满=100% 且刷新保留；恢复默认=92% |
| 参数与主题一起持久化 | `localStorage` `pa.ui.backdrop` v2 存 `{theme, params[theme]}`；每主题独立记忆切换不互相污染；**不写账号** | 刷新后仍 100% |
| 模糊不破坏线条 | 模糊 >1px 时线宽按比例自动补偿（只加宽不加 alpha） | `blur__terrain__4px` 仍可辨，不是消失 |
| 窄屏下面板不挤 | 主题块 xs 单列/sm 两列；滑杆 xs 单列全宽/md 两列；滑杆间距 26px | `panel__starfield__default__narrow__dark.png` 可读 |
| 减弱动效 UI 提示 | 面板顶部 Chip 显示「系统已开启减弱动效」 | BackdropCard.tsx 有该分支 |

---

## 四、轨道线主题细化（v2，本次追加）

相对于上一版，视觉层三改、性能层两改：

**视觉**：
1. 4 环而非 3 环，直径 0.38 / 0.55 / 0.72 / 1.00，每环独立 opacity（28% / 40% / 72% / 55%），外→内是**层次**不是「圈数」。
2. 节点（原硬编码 `var(--brand)`）改用 `var(--bd-accent)` + 双层 `box-shadow` 光晕；尺寸从 7/5px 缩到 5/3.5px。
3. 十字线换虚线、半幅（距圆心 22% 到 78%），背景过亮时用 `color-mix(..., transparent)` 自动变柔。
4. 静态方形卫星点废掉，改成第三轨道上的 3 个动态小圆点，跟随一条快速反向轨道公转。

**性能**：
1. 3 轨道（原 2 条），周期 `×1.0 / ×0.71(反向) / ×0.42(再反向)`，初始角度各错开 47° / 113° / 221°，开机就不是机械对齐。
2. 每条轨道 `transform: translate3d(0,0,0) rotate(θ)` + `will-change: transform`，强制 GPU 合成层，60fps 且高 DPR 无边缘抖。
3. 各轨道 `animation-delay` 用负值（-7s 到 -29s），起始相位错开，避免三条轨道在同一时刻同步。

---

## 五、验证数据

| 检查项 | 命令 | 结果 |
|---|---|---|
| TypeScript | `npx tsc --noEmit -p tsconfig.json` | exit 0 |
| 生产构建 | `npm run build:web` | exit 0；`dist/` 产物生成；PWA SW precache 成功 |
| 截图 + 交互验收 | `node qa/backdrop-capture.cjs` | 57 张 PNG + `errors: []`；功能断言全 PASS |
| 减弱动效 | reducedMotion 探针 | `animation: none` |

**交互验收断言（脚本自动跑）**：透明度拉满→100% 且刷新保留、恢复默认→92%、切星野→参数变 50/92%/0px/94%、关闭→layer 不挂载且 4 根滑杆 disabled。

---

## 六、不包含的内容

- 未改 `desktop/` 主进程（只打包，不改逻辑）
- 未改 `server/` / 数据库 / settings 表（背景只写 localStorage，不写云端）
- 未更新 `package.json` 版本号（PR 合并时由 release 流程处理）
- 未提交 git —— 所有改动工作区本地，待你审查后 commit

---

## 七、提交建议

```
feat(web): 背景氛围系统升级 · 线构四主题 + 参数面板 · 轨道线 v2

- 四档主题：轨道线(纯CSS) / 星野(Canvas 2D) / 等高线(2D value noise) / 关闭
- 设置页参数面板：变化速度 / 线条强度 / 模糊度 / 透明度，四滑杆即时生效
- 每主题独立参数记忆，localStorage v2 持久化，不写账号
- 轨道线 v2：4 环黄金分割 + 3 轨道错开 + 虚线十字 + 节点光晕 + GPU 合成
- prefers-reduced-motion 自动静态化，模糊自动线宽补偿
- 零新依赖，首帧同步落地，正文对比度不变
```
