# COASTAL TIME TRIAL · 黄昏海岸计时赛

> Three.js r149 + 原生 JS 的零外部素材 3D 海岸环形计时赛：双车、双榜、程序化场景、分阶段加载。
>
> **本文件是项目的唯一维护文档**（2026-11-13 重写）。旧 `README.txt` 仅作历史备份，不再更新。

- 版本：`v2.2.9-test2`（测试二号修正版）
- 入口：`index.html`
- 引擎：Three.js r149（本地 `lib/three.min.js`，UMD，最后一个提供 `build/three.min.js` 的版本）
- 形态：单页 + 经典 `<script>`，无构建、无打包、无框架、无外部图片/模型/音频
- 所有资产（地形、海面、天空、车辆、贴图、音效）均由代码程序化生成

---

## 目录

1. [项目概览](#1-项目概览)
2. [快速开始](#2-快速开始)
3. [操作](#3-操作)
4. [游戏规则](#4-游戏规则)
5. [车辆与调校](#5-车辆与调校)
6. [场景与视觉](#6-场景与视觉)
7. [加载与性能](#7-加载与性能)
8. [代码架构](#8-代码架构)
9. [联机模式](#9-联机模式)
10. [开发与调试](#10-开发与调试)
11. [验收清单](#11-验收清单)
12. [已知限制与待办](#12-已知限制与待办)
13. [变更记录](#13-变更记录)
14. [附录](#14-附录)

---

## 1. 项目概览

- **玩法**：单人、第三人称、环形赛道计时赛（Time Trial）。没有对手，目标是把每一圈跑得更快；每完成一圈都会记一条成绩，每辆车各有一份本机 TOP 5。
- **双车**：
  - 原厂跑车：程序化低趴双门跑车，无档位，容错高。
  - MP4/4：用户 Blender 模型 `mp44.blend` 烘成 `car2data.js` 的三角面数据，带 6 速变速箱、更强抓地、更重的越野惩罚。
- **场景**：黄昏低角度落日下的海岸公路，环内是雪山，环外是海；灯塔、木栈道、渔船、浮标、海鸥、850 棵松树、3 处房子、电线杆、终点门与彩旗。
- **视觉**：HDR + 4× MSAA → 半分辨率 AO → 大气/高度雾 → 5 级 Bloom → 远景 DOF + ACES + 暗角 + 胶片颗粒。
- **加载**：纯黑背景 + 11 阶段进度；完成后从高空俯瞰平滑过渡到追车相机的开场镜头。
- **性能**：阴影 30 Hz 按需更新、MSAA 按设备降档、5 档画质自适应、整帧 draw call 统计。

### 设计约束

| 约束 | 说明 |
|---|---|
| 零外部素材 | 不加载任何图片/模型/音频；贴图全部 Canvas 程序化，音效全部 WebAudio 合成 |
| 确定性 | `CR.SEED = 20241111`，所有随机走 `CR.rng(salt)`，同一次构建逐字节可复现 |
| 无构建 | 改完源码直接刷新页面；不需要 npm / vite / webpack |
| 离线可玩 | 双击 `index.html` 即可（`file://`），不依赖网络 |

---

## 2. 快速开始

1. 双击项目根目录的 `index.html`，用 Chrome / Edge / Safari 打开。
2. 等待全屏加载动画走完 11 个阶段（显示「准备就绪」后淡出）。
3. 按任意键或点一下画面解锁音效；之后即可驾驶。
4. 手机：把整个文件夹放进文件管理器，用浏览器打开 `index.html`，横屏体验最佳。

### 环境要求

- 支持 WebGL2 的现代浏览器（WebGL1 会自动降级：无 depth texture 时关闭 AO/DOF）。
- 音效默认静音，首次按键/点击后由 WebAudio 解锁。
- `file://` 下部分浏览器限制 `localStorage`：排行榜可能只在当次会话有效，属正常现象。
- 单机模式不发起任何网络请求；`reportScore` 的 `/api/game/score` 在离线时静默失败，不影响游戏与本地榜。
- 联机模式需要另起一个 Node 服务端（见 [9. 联机模式](#9-联机模式)），不启动也能正常玩单机。

---

## 3. 操作

### 键盘

| 按键 | 功能 |
|---|---|
| `W` / `↑` | 油门 |
| `S` / `↓` | 刹车 / 倒车 |
| `A` / `D` | 左转 / 右转 |
| `SPACE` | 手刹漂移 |
| `SHIFT`（左右均可） | 氮气 |
| `C` | 切换视角（追车 → 远景 → 第一人称） |
| `E` / `Q` | MP4/4 手动挡：升档 / 降档（自动挡下无效） |
| `G` | MP4/4 自动挡 ⇄ 手动挡（也可直接点 HUD 上的档位标签） |
| `F` | 第一人称视角调节面板 |
| `R` | 原地复位（就近拉回中心线，不改计时） |
| `ENTER` | 重新开始一局（当前车回原点、计时清零） |
| `M` | 音效开关 |

### 手柄（Xbox / 标准映射，插上即用）

| 输入 | 功能 |
|---|---|
| `RT` / `LT` | 油门 / 刹车（模拟量） |
| 左摇杆左右 | 转向（死区 + 指数曲线） |
| 十字键 | ↑↓ 油门刹车、←→ 转向 |
| `A` / `RB` | 手刹漂移（MP4/4 手动挡时 `A` 升档，手刹改用 `RB`） |
| `B` / `LB` | 氮气 |
| `Y` | 切换视角 |
| `X` / `START` | 原地复位（MP4/4 手动挡时 `X` 降档） |
| `L3` | MP4/4 自动挡 ⇄ 手动挡 |
| `R3` 按下 | 第一人称调节面板 |
| `BACK` | 音效开关 |

### 触屏

- 左下：左右转向；右下：油门 / 刹车 / 氮气 / 漂移。
- 右上：视角 / 换车 / 复位 / 重开 / 音效 / 调视角（换车 = `V`，**仅单机**；联机车辆由房间发车格决定）。
- 竖屏会提示「横屏体验更好」，仍可正常游玩。

---

## 4. 游戏规则

### 圈速

- 环形赛道，正向跨过终点线记一圈；HUD 显示当前圈已用时间，`LAST` 显示刚跑完那圈。
- **每完成一圈都记一条成绩**（不再只记本局第一次）。
- 半程检查点：必须经过 `0.45L–0.55L`，防止抄近道/倒车刷圈。

### 排行榜

- 每辆车一份独立的本机 TOP 5，按圈速升序；超出 5 条时最慢一条被挤掉。
- 最近一圈用暖橙高亮；没进 TOP 5 时单独补一行 `·  m:ss.mmm`。
- 存储 key：`cr.lb.v2 = { v:2, boards:[list0,list1] }`；旧 `cr.lb.v1` 自动归入车 0。
- 标题带车型名：`TOP · 原厂跑车` / `TOP · MP4/4`。

### 换车与重开

- `V` / 手柄 `L3` / 触屏「换车」：
  - 被切走的车移到**终点左侧、内侧护栏之外的展示位**（`lat=+9.5`，`s=8/11`）；
  - 目标车回自己的 HOME（车 0 `s=L-14,lat=0`；车 1 `s=L-44,lat=2.2`），计时清零；
  - 排行榜切到该车，历史成绩保留。
- `ENTER` / 触屏「重开」：当前车回 HOME、计时清零；**不清空、不锁住榜单**。
- `R`：就近拉回中心线，不改计时。

### 氮气

- `SHIFT` 消耗资源，同时抬高极速、降低风阻、追加推力；资源耗尽自动熄灭，回充到 `REARM` 才能再次点火。
- 漂移会额外回充；越野时消耗加倍、推力减半。
- HUD 右侧一根 2px 暖橙细线表示资源，低电量变淡。

### 冲线彩条

- 完成一圈时从终点线两侧飞散彩条，每次冲线最多触发一次，内置 20 s 冷却。

---

## 5. 车辆与调校

### 参数总表

| 参数 | 原厂跑车（车 0） | MP4/4（车 1） |
|---|---|---|
| `gripNormal` | 12.5 | 27.5 |
| `gripDrift` | 3.8 | 11.0 |
| `gripHand` | 1.5 | 1.5 |
| `maxLatNormal` | 23 | 49 |
| `maxLatDrift` | 17 | 35 |
| `maxLatHand` | 10 | 10 |
| `maxLatOff` | 14 | 25 |
| `gripRise` / `gripFall` | 2.6 / 12 | 3.0 / 12 |
| `driftOn` / `driftOff` | 4.2 / 1.1 | 10.5 / 1.1 |
| `yawNormal` / `yawDrift` | 11.5 / 5 | 9.0 / 5 |
| `bodyRoll` | 0.0036 | 0.0022 |
| `engineThrust` | 13.5 | 19.5 |
| `engineVmax` | 68 | 98（档位 cap 覆盖） |
| `engineDrag` | 0.0021 | 0.0018 |
| `offroadDrag` | **0.18** | **0.50** |
| `steerCap` | 1.06 | 0.80 |
| `yawGain` | 1.0 | 0.72 |
| `geared` | false | true（6 速） |
| `engineBrake` / `engineBrakeHi` | 2.0 / 0 | 9.6 / 0.60 |

### 设计差异

- **原厂跑车**：无档位、抓地适中、容错高；草地纵向阻力 0.18，冲出赛道后掉速较慢，适合熟悉赛道。
- **MP4/4**：6 速变速箱（自动 / 手动可随时切换）、抓地约为原厂 2.2 倍、过弯更稳；草地阻力 0.50，越野惩罚明显更重。
  - 自动挡：按「相邻档推力交叉点」升档（1→2 约 13.1 m/s、2→3 约 21.5、3→4 约 29.3、4→5 约 36.9、5→6 约 44.1），
    降档留 10% 滞回、两次换档至少间隔 0.24s；不给油只降不升，手刹期间锁档。
  - 手动挡：`E` 升 / `Q` 降（手柄 `A` / `X`），带超转保护（目标档极速 1.02 倍内才允许降档）。
  - 切换：`G` / 手柄 `L3` / 点 HUD 档位标签；选择写入 `localStorage`，下次进入沿用。
    没有历史选择时，接手柄默认手动、纯键盘默认自动。
- **手刹档两车一致**（`gripHand=1.5`、`maxLatHand=10`），拉手刹都能漂移、都能触发漂移充能。
- **氮气常量**（`CR.NITRO`）：

| 常量 | 值 | 含义 |
|---|---|---|
| `BURN` | 0.28 | 每秒消耗 |
| `REGEN` | 0.075 | 每秒回充 |
| `DRIFT_GAIN` | 0.14 | 漂移额外回充/秒 |
| `MIN_START` / `REARM` | 0.05 / 0.15 | 点火阈值 / 重新武装阈值 |
| `THRUST` / `VMAX` | 7.5 / 84 | 追加推力 / 极速阈值 |
| `DRAG_SCALE` / `OFFROAD_SCALE` | 0.7 / 0.5 | 氮气风阻 / 越野推力与消耗 |

### 调参入口

- 车辆参数集中在 `src/car.js` 的 `Car.TUNES[0]` / `Car.TUNES[1]`，改完刷新即可。
- 变速箱：`src/gearbox-core.js` 的 `Core.RATIOS`（6 档 `torque` / `cap`）与 `Core.create` 里的
  换挡点 / 滞回 / 驻留参数；`src/gearbox.js` 只做 HUD、按键与模式记忆。
  **这份核心同时被服务端 `server/physics.js` 用 vm 加载，两端换挡逐帧一致。**
- 氮气在 `src/rng.js` 的 `CR.NITRO`。
- 全局常量在 `CR.CFG`（`STEP`、`ROAD_HALF`、`outerLimit`、`innerSoftLimit`、`offroadDrag` 缺省值等）。

---

## 6. 场景与视觉

### 确定性程序化

- `CR.SEED = 20241111`；`CR.rng(salt) = SEED ^ imul(salt, 0x9E3779B1)`。
- `CR.SALT` 为各子系统分配盐：贴图、赛道、树、特效互不干扰。
- 可平铺噪声 `CR.tnoise` / `CR.tfbm` 用于贴图与地形；`CR.noise2` / `CR.fbm` 用于世界坐标细节。

### 赛道与地形

- 环形赛道约 1333 m；`Track.nearest(x,z)` 用 `CELL=40` 哈希网格（`Map`）+ 3×3 邻格查询，远处退化为固定 134 次粗扫 + 细化，避免早期 O(ring²) 假死。
- 地形 `warpGrid(420, 4500)`，路廊贴合：陆地过渡 44 m、海边收窄到 12.5 m，保证路面与地形无接缝。
- 海面 `warpGrid(220, 11500)` + 程序化法线贴图 + 浅水/浪花（`shoreTex`）。
- 雪山：半径 149 m、主峰约 70 m，三峰高斯 + ridged fbm + 两层细节，雪线按高度/坡度分区；植被排除半径 157 m。
- 公路：路面（沥青贴图含胎迹磨损带/裂纹/白边线/中央黄虚线）、路肩 alpha 渐隐、W 形波形梁护栏、混凝土防波堤、每 4.2 m 一根立柱、弯道刹车痕、16×2 黑白格发车线。
- 道具：850 棵松树（InstancedMesh）、路边杂草、3 处房子、灯塔 + 木栈道、渔船、浮标、海鸥、电线杆 + 电线、终点门 + 旗帜。
- **雪山侧 P0（2026-11-13）**：山脚针叶林线、碎石带（山脚雾带已按要求移除）——解决 `Snow.BLOCK=157` 导致山脚一圈光秃的问题。

### 后处理链

`src/post.js`：场景 HDR + 4× MSAA → 半分辨率 AO（8 采样）→ AO + 大气/高度雾合成 → 5 级 Bloom 降/升采样 → 最终 DOF + ACES + 分离色调 + 暗角 + 12 Hz 胶片颗粒。

- 逐项开关：`CR.Post.flags = { ao, bloom, dof, nitro }`。
- Bloom 级数：`CR.Post.setBloomLevels(3..5)`，默认 5（12 个全屏 pass），3 级时 8 个 pass。
- 摩尔纹修复：AO 采样半径加 `2*uTexel` 下限、`fade` 提前到 45–130 m、F_LIT 改对称 ±1 AO texel 四点低通、权重 0.75→0.5；黄色坡条纹指标从 4.72 降到 0.48。

### 视觉锚点

- `CR.Car.ANCHORS[2]` 每车一份：`exhaust`（尾焰）、`rearWheel`（胎痕）、`dustBack`（尾尘）。
- MP4/4 的 4 个轮子按模型真实轮心拆成独立轮组：前轮可转向、后轮手刹停转；尾灯在尾翼下方车尾段内。
- 展示车强制停在左侧 `lat=+9.5`，玩家被护栏/空气墙挡在 5.8 m 内，物理上够不到，因此不需要车车碰撞。

---

## 7. 加载与性能

### 加载动画（11 阶段）

`src/loader.js` 负责阶段调度；`index.html` 提供全屏加载层（纯黑背景 + 标题、进度条、百分比、阶段文案）。加载期间不渲染场景预览，保持纯黑；着色器编译与首帧预热仍在加载阶段完成。加载层一开始淡出就启动主循环，接一段 3.4 s 的开场镜头。

| # | 阶段 | 内容 |
|---|---|---|
| 1 | 生成赛道与黄昏天空 | `Track.build()` + `Sky.create()` |
| 2 | 铺设海岸地形 | `Terrain.create()` |
| 3 | 堆叠雪山与动态海面 | `Snow.create()` + `Ocean.create()` |
| 4 | 铺设公路 · 护栏 · 终点门 | `Road.create()` |
| 5 | 放置灯塔 · 植被 · 渔船 | `Props.create()` |
| 6 | 装配两辆赛车与车库 | `Car.create()` + `Car2.attach()` + `Garage.setup()` |
| 7 | 生成胎痕 · 尾焰 · 彩条 | `Effects.create()` + `Confetti.create()` |
| 8 | 搭建 HDR 后处理链 | `Post.create()` + `applyResize()` |
| 9 | 接入仪表 · 输入 · 音效 | `Record` / `Hud` / `Input` / `FPView` / `Gear` / `Cam.snap` / `Audio.warmup` |
| 10 | 编译全部着色器 | `renderer.compile(scene, camera)` |
| 11 | 预热首帧画面 | `Post.render()` ×2 |

- 每阶段至少可见 90 ms；完成后停留 420 ms 显示「准备就绪」，淡出 760 ms 后启动主循环。
- 预览相机固定在起点上方；每次预览补一次 `Car.sync`，避免第二辆车 root 停在原点。
- 诊断：`CR.Loader.diag()` 返回 `{ done, stage, total, elapsed, records }`，`records` 含每阶段耗时。
- 超时兜底：20 秒未完成时页面显示「加载超时」提示。

> 软件渲染（SwiftShader）参考耗时：地形 ~660 ms、着色器编译 ~1030 ms、其余阶段 20–160 ms；真实 GPU 通常快 5–10 倍。

### 画质档（5 档自适应）

| 档 | 变化 |
|---|---|
| T0 | 满配：后处理全开、Bloom 5 级、分辨率 1.0、桌面阴影 4096² |
| T1 | 关氮气边缘色差 |
| T2 | + 关远景 DOF |
| T3 | + Bloom 5 级降 3 级（全屏 pass 12→8） |
| T4 | + 关半分辨率 AO |
| T5 | + 渲染分辨率 0.7 |

- 触发条件：预热 4 s 后按真实 fps 统计，`fps < 48` 降一档、`fps > 58` 升一档，每级 6 s 冷却。
- 锁定满配：`CR.CFG.autoTier = false`（验收/录屏用）。
- 物理、输入、HUD 完全不受画质档影响。

### 其他性能措施

- 阴影：`renderer.shadowMap.autoUpdate=false`，按真实时间最多 30 Hz 置 `needsUpdate`（低帧率时每帧更新）。
- MSAA：桌面 4×，软件渲染/触屏 2×（`CR.quality.msaa`）。
- `renderer.info.autoReset=false` + 每帧 reset：整帧 draw call / 三角形统计，不再只看到最后一个 pass 的 1 个 call。
- 同类资产一律 InstancedMesh；贴图 `maxAniso` + mipmap；AO/Bloom/DOF 逐项可关。

---

## 8. 代码架构

### 单例与文件约定

- 每个 `src/*.js` 是一个 IIFE + `'use strict'`，共享 `window.CR`。
- `CR.time = { value: 0 }` 是同一个对象，可直接作为 `ShaderMaterial.uniforms` 的时间源。
- 模块只通过 `CR.X` 暴露公共 API；内部状态放闭包，避免全局污染。

### 加载顺序（28 个脚本）

```text
lib/three.min.js
src/rng.js → geo.js → textures.js → track.js → sky.js → terrain.js
 → snowmountain.js → ocean.js → road.js → props.js → car.js
 → car2data.js → car2.js → garage.js → gearbox.js → fpview.js
 → effects.js → confetti.js → post.js → record.js → hud.js → audio.js
 → camera.js → input.js → gamepad.js → touch.js → loader.js → main.js
```

> 依赖要点：`sky.js` 定义 `CR.GLSL_NOISE` / `CR.GLSL_SKY`，必须在 `post.js`、`snowmountain.js` 之前；`gamepad.js` 必须排在 `input.js` 之后；`loader.js` 必须在 `main.js` 之前。

### 模块职责

| 文件 | 职责 |
|---|---|
| `rng.js` | 全局配置、PRNG、噪声、盐表、氮气常量 |
| `geo.js` | `merge` / `tint` / `ribbon` / `warpGrid` / `box` / `place` |
| `textures.js` | 15 类程序化 Canvas 贴图，懒加载缓存 |
| `track.js` | 赛道曲线、最近点查询、赛道常量 |
| `sky.js` | 天空/光照/环境反射、GLSL 噪声与天空函数 |
| `terrain.js` | 非均匀地形、路廊贴合、三贴图混合 |
| `snowmountain.js` | 中心雪山、山脚碎石带 |
| `ocean.js` | 动态海面、浅水/浪花、`heightAt` |
| `road.js` | 路面/路肩/护栏/防波堤/立柱/刹车痕/发车线 |
| `props.js` | 树木/草/房子/灯塔/栈道/渔船/浮标/海鸥/电线杆/雪山林线 |
| `car.js` | 原厂车建模、物理、锚点、双车状态槽 |
| `car2data.js` | MP4/4 烘好的三角面数据 |
| `car2.js` | MP4/4 网格、4 轮拆分、尾灯 |
| `garage.js` | 双车摆位（HOME/PARK）、切换驾驶权 |
| `gearbox-core.js` | 换挡核心（纯逻辑，浏览器 + 服务端共用） |
| `gearbox.js` | 档位 HUD、自动/手动切换与记忆 |
| `fpview.js` | 第一人称调节面板 |
| `effects.js` | 胎痕、尾尘、双尾焰、光晕 |
| `confetti.js` | 冲线彩条 + 20 s CD |
| `post.js` | 自研 HDR 后处理链、Bloom 级数、画质开关 |
| `record.js` | 双榜、每圈都记、v1→v2 迁移 |
| `hud.js` | 速度/圈速/检查点/氮气条/榜单提交 |
| `audio.js` | WebAudio 程序化音效（引擎/刹车/漂移/撞墙/换档/氮气） |
| `camera.js` | 追车/远景/第一人称，标量平滑防抖 |
| `input.js` | 键盘/触屏/手柄统一输入 |
| `gamepad.js` | 手柄映射、震动 |
| `touch.js` | 触屏控件 |
| `loader.js` | 11 阶段加载调度与进度 UI |
| `main.js` | 分阶段启动、主循环、resize、画质自适应 |

### 主循环数据流

```text
Input.read() / CR.autoInput
        ↓
Car.step(dt, input) × n 子步（n = ceil(dt / (1/120))）
        ↓
Car.sync(t, dt)  →  Car.root / parts（两辆车分开摆位）
        ↓
Hud.update → Cam.update → Sky.update → Ocean.update → Props.update
        → Effects.update → Confetti.update → Audio.update
        ↓
Post.render(scene, camera)  →  屏幕
```

### 关键状态源

- `Car.states[2]` / `Car.state`（当前车）、`Car.TUNES[2]`、`Car.partsList[2]`、`Car.ANCHORS[2]`。
- `Car.state.nitro / nitroActive / nitroArmed` 是氮气唯一状态源。
- `Hud.state[2]` 每车一份计时槽。
- `Record.boards[2]` 双榜；`Record.active` 当前显示的车。
- `Garage.home(i)` / `Garage.park(i)` 是两车摆位的唯一来源。

---

## 9. 联机模式（M2：房间制无碰撞竞速）

点右上角「联机」进入大厅：**「创建房间」和「加入房间」是两张独立卡片**，创建后房间号用大字显示、可一键复制。
进入房间后**立即进入独立的选车界面**：左侧原厂跑车、右侧 MP4/4，可查看两车 3D 模型与真实调校数值，
默认 MP4/4，**10 秒倒计时自动确认**；**全员选完车后自动进入 5 秒倒计时并开赛**（不再需要准备/房主点开始）。
单人模式下选车界面**不限时**，看够了再确认。对手车可见但彼此穿过，比赛为 1/3/5 圈；
比赛中每辆车头顶显示玩家昵称，自己的标签是金色并带「你」，跑远/转到身后自动隐藏。

### 启动服务端

```bash
cd server
npm install          # 唯一依赖：ws
node server.js       # 默认 ws://127.0.0.1:8787，可用 node server.js 9000 改端口
```

客户端连接地址是自动推导的：
- 页面在 `https://域名`（或 80/443）→ 连同源 `wss://域名/ws`，交给反向代理转 8787；
- 本地开发（页面在 8000 等端口）→ 连 `ws://当前主机:8787`；
- `file://` 直开 → `ws://127.0.0.1:8787`；
- 地址后加 `?net=ws://host:port` 可强制指定。

服务端没启动/版本不匹配时自动退回单机，不会阻塞游戏。

### 部署到有域名的服务器

一个 Node 进程同时提供静态页面和 WebSocket，外面套一层反向代理做 HTTPS 即可。

```bash
# 服务器上（Node 18+）
sudo mkdir -p /opt/coastal-time-trial && sudo chown -R $USER /opt/coastal-time-trial
# 把项目传上去（不要传 node_modules），然后：
cd /opt/coastal-time-trial/server && npm install --omit=dev

# 只监听本机，交给反代
HOST=127.0.0.1 PORT=8787 node server.js
# 或用 systemd：deploy/coastal.service
```

反代二选一（配置模板在 `deploy/`）。如果这台机器上已经有站点（比如博客）跑着，
用**子路径**更省事：`deploy/nginx-ws-map.conf` 放进 `conf.d/`，`deploy/nginx-subpath.conf`
放进 `snippets/`，再在已有 server 块里 `include` 一行，游戏就挂在 `https://你的域名/race/`，
复用现有证书，客户端会自动把 WS 连到 `/race/ws`。

反代二选一（整站 / 新域名时用）：

| 方案 | 做法 | 特点 |
|---|---|---|
| Caddy | `deploy/Caddyfile` 改域名后 `systemctl reload caddy` | 自动申请/续期证书，最省事 |
| Nginx | `deploy/nginx.conf.example` + `certbot --nginx` | 已有 Nginx 时沿用 |

要点：
- **必须走 `wss://`**：HTTPS 页面连 `ws://` 会被浏览器按混合内容拦掉；客户端已改成同源 `wss://域名/ws`。
- 反代 `/ws` 要带 `Upgrade` / `Connection: upgrade`，读超时放大（服务端 25s 发一次 ping）。
- 防火墙只开 22 / 80 / 443；8787 不要暴露公网（`HOST=127.0.0.1`）。
- 健康检查：`GET /healthz` 返回 `{ok,version,uptime,rooms,players}`。
- `server/track.json` 必须和客户端同一次导出；`VERSION` 与 `CR.VERSION` 必须一致，否则握手被拒。
- 房间在内存里：**重启服务 = 所有房间清空**；单进程够用，多机部署需要粘性会话 + 共享状态。

### 流程与规则

1. 建房 → 分享 6 位房号 → 每人进房选车（10 秒自动确认）→ **全员选完自动 5 秒倒计时** → 开赛。
2. 30Hz 服务端权威物理（`Car.step` 与浏览器**同一份代码**），15Hz 向下广播快照。
3. 客户端 30Hz 上行输入（油门/刹车/转向/手刹/氮气/换档），**位置不可信**。
4. 本地玩家做预测 + 快照校正；对手车按 100ms 缓冲插值显示，不跑物理。
5. 反作弊：输入限幅、8 检查点顺序、按车型的物理极限圈速、位置跳变检测。
6. 结算按冲线顺序排名，全员完赛后展示 12 秒；随后回到房间，所有人重新选车再来一局。
7. 断线保留座位 15 秒；重连凭 `sessionToken + device` 回原座位与进度，超时记 DNF。

### 服务端文件

| 文件 | 作用 |
|---|---|
| `server/server.js` | HTTP 静态服务 + WebSocket 消息路由 + 30Hz tick |
| `server/rooms.js` | 房间状态机、检查点/冲线判定、反作弊、结算、实时名次 |
| `server/physics.js` | 用 `vm` 加载客户端 `rng/track/car.js`，让服务端与浏览器物理完全一致 |
| `server/track.json` | 客户端 `Track.build()` 导出的赛道采样，避免服务端重写 CatmullRomCurve3 |

> 改赛道控制点后需要重新导出 `track.json`，否则两端赛道不一致。
> MP4/4 可随时用 `G`（手柄 `L3`）切自动 / 手动；模式会随 `{t:'gear'}` 同步给服务端，
> 服务端用同一份 `gearbox-core.js` 推进档位，手动换档以输入位 `shiftUp` / `shiftDown` 上报。

---

## 10. 开发与调试

### 本地修改

- 直接改 `src/*.js`，刷新页面即可；没有构建步骤。
- 新增脚本时同步改 `index.html` 的 `<script>` 顺序与 `?v=` 版本号（用于破缓存）。

### 接管输入（自动驾驶 / 回放 / 录屏）

```js
CR.autoInput = { throttle: 1, brake: 0, steer: 0.4, handbrake: 0, nitro: 0 };
// 传 null 恢复键盘/手柄/触屏
CR.autoInput = null;
```

### 常用诊断 API

| API | 用途 |
|---|---|
| `CR.Loader.diag()` | 加载阶段、每阶段耗时、总耗时 |
| `CR.Post.debug()` | flags / tier / bloomLevels / samples / RT 尺寸 / pass 数 |
| `CR.Record.diag()` | 双榜条目、最近一圈、提交次数 |
| `CR.Props.diag()` | 灯塔脉冲、渔船姿态、浮标、海鸥、旗帜 |
| `CR.Snow.diag()` | 雪山顶点/三角/峰高/雪覆盖/半径/排除半径 |
| `CR.Garage.home(i)` / `park(i)` | 两车 HOME/PARK 坐标 |
| `CR.Car.ANCHORS` | 每车尾焰/胎痕/尾尘局部锚点 |
| `CR.Audio.diag()` | 音效层级、撞墙/打火/换档计数 |

### CDP 验收方法

- 用 `Input.dispatchKeyEvent` 发送受信任按键（`code: 'KeyW'` 等），配合 `waitFor` 轮询状态，不要用固定 `sleep`（软件渲染 1–2 fps）。
- 注入 `window.__errs=[]` 与 `error` 监听，最后断言为空。
- 截图用 `Page.captureScreenshot`；固定机位可临时替换 `CR.Cam.update`。
- 性能对比时临时关掉 `renderer.shadowMap.enabled`，否则 `renderer.info` 会混入阴影 pass 的 draw call。

### 常见坑

| 现象 | 原因 / 处理 |
|---|---|
| 页面长时间白屏/假死 | 早期 `Track.nearest` O(ring²) 已修；新增查询不要退化成全表扫描 |
| 草地/黄坡密集竖纹 | 半分辨率 AO 的采样半径过小 + 抖动；已修，新增 AO 采样别把半径压到 1 px 以下 |
| 第二辆车尾焰/胎痕错位 | 锚点写死车 0 几何；用 `Car.ANCHORS[active]`，不要新增硬编码坐标 |
| 换车后第二辆车停在原点 | 加载期间主循环没跑，`Garage.setup` 只改 state；预览前补一次 `Car.sync` |
| 展示车常亮刹车灯 | 非驾驶车不跑物理；`Car.sync` 里把非当前车 `tail.emissiveIntensity` 复位 0.9 |
| `file://` 排行榜不持久 | 浏览器限制 localStorage；属正常现象 |
| 首次出现特效卡顿 | 加载阶段已 `renderer.compile` + 预热；新增 shader 要纳入预热 |

---

## 11. 验收清单

| 项 | 关键结果 |
|---|---|
| 双榜 / 选车 | 标题带车型名；选车目标车回 HOME、计时清零；PARK `lat=+9.5` |
| 每圈都记 | 连续 3 次提交 `n=3, submits=3`，无记录锁 |
| 摩尔纹 | 黄色坡条纹指标 `4.722 → 0.476`（↓90%），方向比 `2.086 → 1.00` |
| 第二辆车视觉 | 4 个独立轮组；前轮 `yaw=delta`；尾焰 `(-0.30,0.52,-2.20)`；胎痕 `(±0.846,0.04,-1.656)` |
| 加载动画 | 11 阶段；进度 18%→100%；加载期间纯黑；淡出后接 3.4 s 开场镜头 |
| 性能 | 满配 12 pass；Bloom 3 级 8 pass；整帧统计可读（软件渲染约 146 calls / 41 万三角形；雪山 P0 后 +4 calls / +2.9 万三角形） |
| 雪山 P0 | 林线 125/408 棵、碎石 194/259 块；仅 +2 个对象 / +3 draw call / +2.9 万三角形 |
| 稳定性 | 页面无未捕获 JS 错误；`CR.Loader.diag().records` 11 条齐全 |

---

## 12. 已知限制与待办

- **网站未上传**：目前只有本地项目与旧博客嵌入包；没有部署到任何线上地址。
- **C 盘旧副本 / 旧 zip / `dist` 博客包未同步**：`C:\Users\ASUS\WorkBuddy\...\coastal-time-trial\`、`coastal-time-trial.zip`、`dist/coastal-time-trial-blog.zip` 仍是旧代码；要发博客需重新打包。
- **P0-3 已修**：氮气把每档 `cap` 按 `NITRO.VMAX / engineVmax` 同步缩放（MP4/4 ≈ 0.857），
  低档不再靠氮气跳过档位极速，高档仍能跑满；两车极速上限不变，圈速下限无需调整。
- **P0-4 未修**：`record.js` 的 `reportScore` 仍每圈 POST `/api/game/score`；离线静默失败，但每圈都会发一次请求。
- **音效默认静音**：浏览器自动播放策略要求首次手势解锁；不是 bug。
- **车辆无碰撞**：两车靠展示位 + 空气墙隔离，没有车车碰撞。
- **雪山 P1/P2 未做**：日照金山、雪面沟槽、盘山路/缆车、远山剪影、山腰云、观景台/溪流。
- **移动端性能**：依赖 5 档自适应；低端机可能降到 T4/T5。
- **旧 `README.txt`**：仅作历史备份，内容可能过时，不再维护。

---

## 13. 变更记录

### 2026-11-13

- **P0-1**：双榜（`cr.lb.v2`）、换车回原点计时、旧 v1 迁移。
- **P0-2**：非驾驶车移到终点展示位；后调整为**左侧** `lat=+9.5`，玩家被护栏挡住够不到。
- **成绩规则**：改为「每完成一圈都记一条」，去掉一局锁。
- **摩尔纹修复**：半分辨率 AO 采样半径/淡出/对称 4-tap/权重，黄色坡条纹 ↓90%。
- **第二辆车视觉**：`Car.ANCHORS[2]`、4 轮拆分（前轮转向/后轮手刹停转）、尾灯移到车尾、尾尘锚点。
- **两车平衡**：车 0 操控/抓地提升约 30%；车 1 草地阻力 0.50、操控略微回调；车 0 草地阻力 0.18。
- **加载动画**：11 阶段 + 全屏 CSS 加载层 + 场景逐层透出 + shader 编译/预热进加载期。
- **性能**：阴影 30 Hz、MSAA 4/2、5 档画质、Bloom 3/5 级、整帧 draw call 统计。
- **雪山 P0**：山脚针叶林线、碎石带（雾带已移除）。
- **纯黑加载 + 开场镜头**：加载期间不渲染场景、背景纯黑；完成后从车后 70 m / 高 110 m 的高空俯瞰，用 3.4 s easeInOutCubic 过渡到追车相机，期间锁定输入，结束后相机与 `Cam.update` 目标重合。
- **文档**：本 `README.md` 重写。

### 2026-11-12

- 第二辆车（MP4/4）导入、双车车库、6 速变速箱、第一人称调节面板。
- 氮气系统（P-N0 ~ P-N6）、HUD 氮气条、WebAudio 完整音效。
- 排行榜、冲线彩条、博客 iframe 嵌入包。

### 2026-11-11

- 初版：赛道、地形、海面、天空、公路、道具、车辆、物理、相机、后处理链。

---

## 14. 附录

### A. 文件树

```text
coastal-time-trial/
├─ index.html              ← 主入口
├─ README.md               ← 本文件（唯一维护文档）
├─ README.txt              ← 历史备份（不再更新）
├─ embed.html              ← 可选的 iframe 嵌入版
├─ lib/
│  └─ three.min.js         ← Three.js r149（本地内置）
└─ src/
   ├─ rng.js  geo.js  textures.js  track.js
   ├─ sky.js  terrain.js  snowmountain.js  ocean.js  road.js  props.js
   ├─ car.js  car2data.js  car2.js  garage.js  gearbox-core.js  gearbox.js  fpview.js
   ├─ effects.js  confetti.js  post.js  record.js  hud.js  audio.js
   ├─ camera.js  input.js  gamepad.js  touch.js
   └─ loader.js  main.js
```

### B. 赛道与常量速查

| 常量 | 值 |
|---|---|
| `CR.SEED` | 20241111 |
| 赛道长度 | ≈ 1333 m |
| `ROAD_HALF` | 5.0 |
| `outerLimit` / `innerRailLimit` / `innerSoftLimit` | 5.8 / 5.8 / 10.5 |
| `SEA` | 1.6 |
| `STEP` | 1/120 s |
| `WHEEL_R` / `WB` / `AX_F` / `AX_R` | 0.335 / 2.65 / 1.35 / -1.30 |
| 地形 / 海面网格 | 420 / 220 |
| 树 / 雪 / 阴影 | 850 / 144 / 4096² |
| 展示位 `PARK` | `s=8/11`，`lat=+9.5` |
| 开场镜头 | 3.4 s，起点车后 70 m / 高 110 m |

### T. 联机换车异常 v2.2.14-test2（2026-11-18）

反馈：联机换车后本地/其他端显示错误车模，且可能开不动。复现定位到两个独立缺陷：

1. **其他端永远显示旧模型**：`Rivals.update` 只在「新建 item」时比对 `want = p.car`；
   同一玩家换车时 `byId` 已命中，旧模型一直留着。实测 bot 从车1改车0，观察端
   `rivalCar` 仍是 1、服务端已是 0。修：`item` 存在但 `item.car !== want` 时就地重建，
   替换 pool 中同位置元素（不 push），复用按 id 缓存的名字标签。
2. **本地先切、服务端拒绝**：`carselect.confirm()` 先调 `Garage.setActive()` 再回调发 `car`，
   而服务端 `setCar()` 有 `if (this.racing) return false`。比赛中换车 → 本地 `Car.active`/
   物理换成新车，服务端仍按旧车推进，越跑越偏、被 `correct()` 硬拉回（顿挫/像开不动）。
   修：
   - 联机模式（`data-mode="net"`）的选车界面**不再**自行切本地车，交 netui 回调；
   - netui 回调与 `N.selectCar` 都在 `state === 'racing'` 时直接拒绝（toast / error）；
   - 服务端 `setCar` 失败时回明确 error，不再静默；
   - `case 'room'` 用服务端房间里的 `car` 校准 `N.car`（服务端权威）。
3. **输入状态**：`Garage.setActive` 换车后清 `Touch.releaseAll / Input.clearTouch / clearPad`，
   避免新车继承旧车按住的油门或转向。
4. 诊断：`Rivals.diag().items[].car` 暴露各对手当前模型车型，便于验收。

回归：房间内 0→1 换车后 `active/netCar/srvCar/roomCar` 全为 1；开赛后按 W
`localSpd 29.1 / srvVf 28.4`；比赛中 `N.selectCar(0)` 被拒且 `netCar/active` 不变；
bot 同 id 换车 1→0→1，观察端 `rivalCar` 同步 1→0→1。

### S. 桌面误显手机按钮 v2.2.13-test2（2026-11-18）

反馈：电脑端游玩时顶部/两侧出现一整排手机触屏按钮（视角/换车/氮气/油门...）。
根因：`touch.js` 的 `isTouch()` 用 `navigator.maxTouchPoints > 0` / `'ontouchstart' in window`
当主判据 —— 带触摸屏的 Windows 笔记本、某些桌面 Chrome 也满足，于是加上 `html.tc-on`。

- 改判据：以 `(pointer: coarse)`（主指针是手指）为准；先判 `coarse` → 手机/平板显示；
  再判 `pointer: fine`（鼠标为主）→ 一律当桌面，即使机器带触摸屏。
  老浏览器兜底同时要求触摸能力且 `min(innerWidth,innerHeight) < 600`（不再是 820，
  否则 1280×800 的桌面窗口也会被当成小屏）。
- 显示/绑定解耦：按钮事件始终绑定一次（默认 display:none 不触发），
  `applyMode()` 只切 `html.tc-on`；监听 `(pointer: coarse)` 变化与 `resize` 实时更新，
  切回桌面时 `Input.clearTouch()` + `releaseAll()` 清掉按住状态。
- 验证：桌面 false、触屏笔记本(有触摸+鼠标为主) false、缩小窗口 false、手机竖/横 true、纯触摸 true；
  运行中桌面→手机→桌面切换，按钮显示随之变化。

### R. 退出房间 + 掉线状态可见 v2.2.11-test2（2026-11-17）

- **退出房间**：右上角入口在单机显示「联机」，进房 / 比赛中显示「退出房间」；点一次变
  「确认退出?」（3.5 秒内再点才执行，防误触），再点会 `Net.leave()` + 清对手车 + 车回起点 +
  计时重置 + 回大厅。不新增 DOM 按钮，避免和触屏工具条 / HUD / 博客退出键抢位置。
  注意 `room`/`snapshot` 不触发 `state` 事件，按钮文字要在这些 handler 里同步刷新。
- **掉线状态可见**：服务端 ws close 时立刻广播一次 room；客户端再以 15Hz 快照里的
  `connected` 兜底，**只在线状态变化时**重建房间面板（不每帧重建，避免按钮闪烁）。
  掉线玩家整行变淡 + 「掉线 / 重连中…」角标，状态栏显示「有 N 人掉线，等待重连…」，
  按钮显示「开始比赛 · 仅 N 人在线」，点了会 toast 具体原因。
  之前界面用 `players.length` 算，服务端用 `connected` 过滤，导致「提示全员已就位、按钮却点不动」。

### Q. 「联机开不动车」反馈 v2.2.9-test2（2026-11-17）

三人局实测（1 浏览器 + 2 机器人）：车速 7.7→29.2 m/s、服务端 `vf` 同步、两个对手车都渲染、
零异常 —— 物理和同步没有坏。真实原因多半是 **2.2.7 把开赛改成房主手动点** 之后，
房主没点 / 按钮因有人还没选车而禁用，大家按 W 自然没反应。

- 房主按钮**不再用 `disabled`**（禁用按钮点下去零反馈，看着就是「点了没用」）：
  文案直接写「开始比赛 · 还差 N 人」，点下去 toast 出具体是谁没选车（或「你自己还没选车」）。
- 倒计时锁输入加 **8 秒兜底**：服务端万一卡在 `countdown`（或 start 包丢失），
  原来会永久锁住驾驶输入，表现就是「完全开不动、也没提示」；现在最多锁 8 秒。

### P. 联机同步质量：服务端时间轴 + 自适应缓冲 v2.2.8-test2（2026-11-17）

反馈“对手车卡顿/瞬移、像在反着走”。先量化再改：

- **朝向同步本身是对的**：连续采样 89 帧（本地 + 线上各一轮），`位移方向·车头方向` 的
  cosine **恒为 1.00**，`rotY` 与快照 `psi` 差 < 0.04 rad。所谓“反着走”实测是对手在
  **倒车 / 撞墙被弹回**（`vf < 0`），此时车头朝前、位置后退。处理：对手尾灯在 `vf < -1.5` 时常亮，
  一眼能看出是在倒，而不是同步坏了。
- **瞬移的真正根因有两个**：
  1. 插值时间轴用的是**本地接收时间**（`performance.now()`）。主线程一卡（GC / 重绘），
     几个快照会在同一刻被处理，时间戳挤在一起 → 插值速度塌缩 → 下一帧直接跳到最新位置。
  2. `SNAP_DELAY` 固定 100ms，而快照 15Hz（66.7ms/帧）→ 缓冲只有 1.5 帧，抖动超过 33ms 就断流。
- 修法：服务端快照新增 `st: Date.now()`；客户端用**服务端时间轴**做插值（`srvOff` 钟差限速跟随、
  单次最多修 15ms），缓冲改为 `100ms + min(90ms, 抖动×1.2)`，再加**时间轴推进限速**
  （每帧最多比真实时间快 35%，卡顿恢复后慢慢追而不是一步跳过去）。
- 验收指标（页面 rAF 内逐帧记 `Rivals` 位置，算单帧位移）：正常 中位 0.12m / p95 0.19m；
  每 300ms 人为卡 120ms 时 中位 0.16m / p95 0.26m，位移 >1m 的帧只有 1/834（0.1%），
  改造前同场景 12% 的帧速度偏差 >6m/s。`CR.Net.netDiag()` 可看 `bufferMs / jitterMs`。

### O. 房主手动开赛 + 输入框隔离 v2.2.7-test2（2026-11-17）

- **开赛改为房主手动触发**：`rooms.maybeStart()` 删除，选车 / 准备状态变化只广播 `room`，
  不再自动进倒计时；`roomInfo()` 新增 `canStart`（≥2 人且全员 ready）。房主看到「开始比赛」按钮
  （条件不满足时禁用并显示「等待全员选车」），非房主看到「等待房主开始…」；服务端 `case 'start'`
  校验房主身份并给出具体失败原因（人数不足 / 还有几人没选车）。
- **房号打不进去**：`input.js` 的 window keydown 对白名单键无条件 `preventDefault()`，
  而房号是 6 位字母，`W/A/S/D/C/R/M/F/G/E/Q/V` 全在表里 → 字符被吞。现在焦点在
  `input/textarea/select/contenteditable` 时直接跳过（不记录、不拦截）；keyup 仍清状态，
  避免「按着 W 点进输入框再松手」导致车一直加速。
- 验证：输入框聚焦后键入 `k7m2qp` → value 完整为 `K7M2QP`，期间 `throttle=0`；失焦后按 W 立刻恢复。

### N. 单机换车键回归 v2.2.6-test2（2026-11-17）

改成「开局前选车」之后，游戏内的换车入口整个被删掉了，对局中没法再切车。现在按回原键位：

- `V`（键盘）/ 触屏「换车」→ `CR.Garage.toggle()`。行为沿用原设计：被切走的车回到场外展示位、
  目标车回到自己的发车点、清速度/氮气/撞击累积、计时槽清零新开一局、HUD 与榜单一起切到该车。
- **只在单机生效**：`CR.Net.online` 为真时直接忽略 —— 联机车辆由服务端发车格决定，
  本地换车会被 `forceSync` 立刻拽回去，还会打乱名次与计时。
- 触屏工具条加「换车」按钮（`data-key="KeyV"`），并把工具条改成 `flex-wrap` 换行，
  避免 6 个按钮在竖屏上挤出屏幕。
- 验证：单机跑到 s=30 速度 27 m/s 时按 V → 切到 MP4/4、s 回到 1289（该车发车点）、速度归零、
  计时清零、榜单切到车 1；再按 V 切回原厂车 s=1319。联机 racing 中按 V，`Car.active` 不变。

### M. 博客游戏板块：预热 + 退出变小窗（2026-11-17）

之前是「点开始才装 iframe，点退出就把 src 设成 about:blank」，两个问题：每次进来都要重新等加载；
退出等于把游戏关掉，重新进又从零开始。现在改成四态机（`closed / mini / dock / full`），
**iframe 节点始终复用**，切换只改 CSS 类：

- `mini`：页面加载 1.2s 后自动把 `/race/?from=blog` 装进一个 300×169 的不可见容器（opacity 0、
  pointer-events none），用户读页面时游戏已经在后台加载完，点「开始游戏」不必再等。
- `full`：全屏（`inset:0` + `requestFullscreen`）。
- `dock`：退出（按钮 / Esc / 系统退出全屏）只缩成右下角 380×214 的小窗，顶部一条半透明标题条
  （展开 / ✕），**游戏继续跑，不重载**。
- `closed`：只有小窗上的 ✕ 才真正卸载（`src = about:blank`，顺带停音频、断联机）。
- 验证：在 iframe 里打 `__probe` 标记，全屏→小窗→展开全程标记不丢，说明没有重新加载；
  小窗 ✕ 后 `src` 变 `about:blank`。
- 注意 iframe 不能靠移动 DOM 来「换容器」—— 移动会重建文档、重新加载；只能改尺寸和定位。

### L. 帧率优化 v2.2.5-test2（2026-11-17）

实测（1600×900）砍掉单项看收益：关阴影 +124%、停阴影重绘只 +34%、关后期 +48%、
分辨率 70% +188% —— 结论是**填充率**而不是 draw call（~110 个 call / 80 万三角形）在拖。

- **阴影采样算法 PCFSoft → PCF**（9 次采样 → 4 次）。关阴影能涨一倍多，说明大头在主渲染的
  阴影采样，而不是阴影贴图重绘。`CR.CFG.shadowSoft` 可切回软阴影。
- **阴影贴图 4096² → 2048²**：阴影相机覆盖 ±75m，2048 时每纹素 7.3cm，PCF 下观感差别很小，
  填充率只剩 1/4。
- **devicePixelRatio 上限 1.5 → 1.25**：高分屏上像素数 2.25 倍 → 1.56 倍，省 30% 填充。
- **降级链加入分辨率阶梯** `1 → 0.92 → 0.86 → 0.80 → 0.75 → 0.70`，原来只有第 5 档才一次性
  砍到 0.7；现在降一两档就能回 60fps。第 4 档起阴影再降到 1024²（`Sky.setShadowSize()` 运行时重建）。
- **降档阈值 48 → 52 fps**，滞回仍为 58，避免 50fps 附近反复横跳。
- **手动画质**：`?q=low` 固定低档（分辨率 70% / 阴影 1024 / 像素比 1.0 / 树木 260），
  `?q=high` 强制满配；两者都会关掉自动降级。

### K. 联机成绩不入榜 v2.2.4-test2（2026-11-17）

反馈：榜单成绩「又不记录了」。实测单机正常（跑一圈 32.2s 能写进 `1 0:32.256`），
问题只在联机：

- `Hud.updateNet()` 只用快照刷速度/本圈时间，**从不调用 `Record.submit()`** ——
  联机跑得再快，本地榜没有记录，也不会 POST `/api/game/score`。
  现在检测快照里 `me.lastLap` 变化（服务端只在冲线时更新）→ 写进本地榜 + 上报。
  注意 `lastLap` 是**毫秒**（`Math.round((raceTime - lapStart) * 1000)`），而 `Record.submit()` 收秒，必须 `/1000`。
- `Car.setActive()` 补上 `Record.setActive()`：Garage 路径本来会切榜，但联机中途换车 /
  脚本直接切车时不会，会出现「成绩记进车 1 的榜，HUD 却还在显示车 0 的空榜」，看着也像没记录。
- 复查上报链路：`GET /api/game/rank` 有 18 条数据、`POST /api/game/score` 返回 201，
  `game-rank.js` 监听 `ooji-game-score` 并在 700ms 后自动刷新，博客侧不需要改。

### J. 对手车显示异常修复 v2.2.3-test2（2026-11-17）

反馈：联机里对手车车身歪斜、前轮角度怪异（截图里车像是「反过来/散架」）。根因不在渲染，在**克隆**：

- **姿态被冻结**：`rivals.makeOne()` 用 `Car.roots[carId].clone(true)` 复制模型，会把克隆瞬间本车的
  `body.rotation.x/z`（坡度俯仰 `-atan(slope)`、加速点头 `-acc*0.0022`、过弯侧倾 `latAcc*bodyRoll`）
  和四个 `wheelPivot.rotation.y`（前轮转角 `st.delta`，最大 0.8 rad ≈ 46°）一起复制过去。
  而 `R.update()` 每帧只写 `position` 与 `rotation.y`，这些子节点姿态此后**永不更新** →
  对手车永久歪着、前轮永久打死（看起来就像整车方向不对）。非活动车 `roots[1-active]` 的问题更重：
  `Car.sync()` 只更新活动车的 body，非活动车停在最后一次驾驶的姿态上。
  修法：给 `carBody` / `wheelPivot` / `wheelSpin` 打 `name`，克隆后 `resetPose()` 统一归零，
  再按对手自己的位置用 `Track.nearest()` 补一个 20 Hz 的坡面俯仰（避免归零后在坡上插进地面）。
- **池满时泄漏 + 复用脱场景对象**：满了之后 `pool.push(新对象)` 而不是替换数组元素，旧对象仍留在
  `pool` 中且已被 `scene.remove`；下一轮 `pool.find(o => !o.busy)` 命中它 → 拿到一个不在场景里的 root，
  表现为「车不显示、头顶名字还在」。改成替换数组元素 + 抢占最老那辆（附 `console.warn`）。
- **重新初始化留幽灵车**：`R.create()` 直接 `pool = []`，旧 root 仍 `visible = true` 挂在场景上，
  且已不在 `byId` 里，永远擦不掉。现在先 `killOne()` 全部摘除，并清掉残留的名字标签。
- **闪一帧 / 消失**：快照偶尔带 `NaN`（服务端刚重置），`position.set(NaN)` 会让整辆车消失。
  现在写入前做 `isFinite` 校验，异常帧直接跳过。
- 顺手：对手车轮胎按快照 `vf` 滚动（纯视觉）；握手不再硬校验前端版本（只校验协议号），
  避免发版后开着旧标签页的玩家被「版本不匹配」直接拒绝。

### I. v2.2.2-test2（2026-11-17）

- **撞墙音效不消失**：`Car.step` 把每帧最强法向撞速取最大值写进 `st.hitAcc`，约定由 `main.js`
  消费后清零，但实现里只读不清。撞一次护栏后 `hitAcc` 永远 > 0，`A.hit()` 的 0.05 s 节流会让
  撞击声以 20 Hz 无限重放。现在 `main.js` 读完立即 `st.hitAcc = 0`（联机分支也一并归零）。
- **联机入口被「退出」遮挡**：博客全屏层的退出按钮原本在 `right:18px; top:16px`，与游戏内
  `.net-entry`（`right:28px; top:24px`）几乎完全重合，点联机等于点退出。退出按钮改到
  `left:18px; top:16px`（游戏左上角是空的：速度表在右下、键位提示在左下），实测两者矩形不再相交。
- 版本号 `CR.VERSION` / 服务端 `VERSION` = `2.2.2-test2`，静态资源 `?v=20261118s`。

### H. 测试二号修正版 v2.2.1-test2（2026-11-17）

针对「两车起步重叠 / 对手车朝向异常 / 联机转向锁死」三项反馈的修复：

- **发车格**：`rooms.js` 的 `resetPlayer()` 改成两列错位（`lat=±2.0`）+ 每排后移 6 m，
  起跑两车相距 4.0 m，不再叠在同一坐标。
- **开赛强制对齐**：`net.js` 新增 `forceSync`，收到 `start` 事件或首个 `phase==='racing'`
  快照时把本地车的位置/朝向/速度/`s`/`lat` 一次性写成服务端值。此前本地车还停在单机出生点
  （赛道中心线），与服务端发车格横向差 2 m，只能靠 `correct()` 一点点拽。
- **转向手感**：`N.correct()` 的吸附阈值改为随速度变化 `8 + 0.35|vf|`；平滑校正用
  `k = 1-exp(-dt*8)`；朝向只在误差 > 2.0 rad 时硬切，否则按 1.2 rad/s 慢修正。
  旧实现是固定 4 m 阈值 + 每帧硬拉，高速时会和转向抢方向，表现就是「车头掰不动」。
- **部署坑**：Nginx 里 `add_header Content-Security-Policy "... 'self' ..."` 如果用双引号包整串，
  单引号会被吞成 `default-src self`（非法源），浏览器会把 `/race/` 的脚本全部拦掉、
  iframe 里只显示错误页。必须写成 `"default-src 'self'; ..."`。
- 版本号 `CR.VERSION` / 服务端 `VERSION` 同步为 `2.2.1-test2`，静态资源版本 `?v=20261118q`。

### G. 测试二号版本 v2.2.0-test2（2026-11-17）

- 游戏内新增「更新公告」面板（新版本首次进大厅自动弹一次，也可从大厅底部重新打开）。
- 选车界面改为不透明暖色主题，预览重做（暖色布光、落地阴影、选中车拉近）。
- 版本号 `CR.VERSION` / 服务端 `VERSION` 同步为 `2.2.0-test2`；公告见 `ANNOUNCEMENT-测试二号.md`。

### F. 联机流程与线上部署（2026-11-17）

- 联机改成「进房选车 → 全员选完自动 5 秒倒计时 → 开赛」，去掉准备按钮和房主开始；中途加入/离开退回大厅。
- 单机选车不限时，确认才进入比赛。
- 大厅改为「创建 / 加入」两张独立卡片，房间号大字 + 一键复制。
- 选车界面改为**不透明暖色主题**，预览重做：暖色布光、车底柔和落地阴影、选中车拉近放大。
- 联机时车辆头顶显示昵称（自己金色 + 「你」），按相机投影定位，超出视野/过远自动隐藏。
- 联机 HUD 用服务端快照刷新（速度、本圈时间、氮气），修掉比赛中速度表停在 000 的问题。
- 部署：Node 20 + systemd（`coastal-race`）+ Nginx 子路径 `/race/`，复用现有证书；
  **必须开 gzip**（`three.min.js` 608KB → 155KB），否则首次加载要 20s+。

### E. 变速箱自动/手动（2026-11-18）

- 新增 `src/gearbox-core.js`：换挡逻辑唯一实现，浏览器与服务端 vm 共用；自动挡改为按
  「相邻档推力交叉点」选档（带 10% 降档滞回、0.24s 驻留、滑行只降不升、手刹锁档、倒车锁 1 档）。
- `src/gearbox.js` 重写为 HUD + 输入 + 模式记忆：`G` / 手柄 `L3` / 点标签切换自动手动，
  `E`/`Q`（手柄 `A`/`X`）手动换档，模式写入 `localStorage`。
- 氮气与档位解耦修正：每档 `cap` 按 `NITRO.VMAX / engineVmax` 缩放，低档不再被氮气顶到极速。
- 联机新增 `{t:'gear'}` 消息与输入位 `shiftUp` / `shiftDown` 边沿处理；服务端按玩家模式推进。
- 顺带修：联机实时名次改用「相对发车点的进度」，起步不再出现「没动的人排第一」。

### D. 联机 M2（2026-11-17）

- 新增 `server/`（Node + ws，30Hz 权威物理复用客户端代码）与 `src/net.js`、`src/rivals.js`、`src/netui.js`。
- 默认驾驶车改为 MP4/4（第二版车辆）；无碰撞、房间制、服务端权威名次与结算。
- 单机 `file://` 打开不受影响；服务端未启动时自动退回单机。

### C. 文档维护约定

- 改玩法/参数/新增模块时，同步更新本文件对应章节与「变更记录」。
- 不再维护 `README.txt`；如需保留旧说明，请明确标注「历史备份」。
- 文档中的数值以 `src/` 代码为准；发现不一致时先改代码注释再改文档。
