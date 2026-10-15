# dsh-local-background

给 DeepSeek Harness 桌面端换**自己的背景图**、并**自动轮播**的本地插件。

- 图片放在**本地文件夹**里，插件直接读 —— 不打包、不压缩、随便加减
- 每 N 分钟自动换一张（默认 5 分钟）
- 不依赖任何第三方皮肤/主题作者的版本适配
- 不想要了，在桌面应用「插件」页卸载即可

---

## 原理（为什么这么做）

DSH **内置没有**背景图设置：`@deepseek-ai/dsh-client-ui-theme` 只提供「配色方案」和「正文字号」，
官方文档把第三方主题定义为「扩展点，不是产品」。

本插件走官方认可的扩展路径，分两半：

| 半侧 | 文件 | 职责 |
| --- | --- | --- |
| 宿主（Node/ESM） | `index.js` | 读图片文件夹；`webServer` 六条路由；**配置的读写与持久化** |
| 客户端（浏览器） | `client.js` | 取清单 → 定时切换 `background-image` → 注入 CSS；**「插件」页里的设置界面** |

```
GET  /dsh-local-background/list                      → { dir, rotateMinutes, dim, surface, imageOpacity, picker, files:[...] }
GET  /dsh-local-background/img/<名>                  → 图片字节流（同源，不走 file://，不受跨域限制）
GET  /dsh-local-background/pick                      → 弹系统文件夹对话框，返回 { supported, path }
GET  /dsh-local-background/dirs?path=&child=         → 逐级列子目录（宿主拼路径，用平台分隔符）
POST /dsh-local-background/config                    → 写配置：{ dir?, dim?, surface?, imageOpacity?, rotateMinutes? }
GET  /dsh-local-background/report                    → 客户端诊断日志（追加 report.log）
```

> 为什么不让客户端直接读文件夹：浏览器拿不到本地文件系统，`file://` 又被 Electron 的
> webSecurity 拦住。让**宿主**读盘、用同源 http 提供，是最干净的解法。

### 注入的 CSS 到底改了什么

```css
html, body { background-image: <压暗渐变>, url("/dsh-local-background/img/…"); background-size: cover; background-attachment: fixed; }
body { --dsw-alias-bg-base: transparent; }   /* 应用底色透明 */
```

**只透明化 `bg-base` 是不够的** —— 真正铺满视口的是「表层」，必须一起处理，否则启动瞬间能看到背景、
下层一渲染就被盖住（表现为"一闪就黑"）：

| Token | 含义 | 明色 | 暗色 |
| --- | --- | --- | --- |
| `--dsw-alias-bg-base` | Application base background | bluish-00 | bluish-950 |
| `--dsw-alias-bg-layer-1` | Primary raised surface（主面板） | bluish-00 | bluish-875 `#232324` |
| `--dsw-alias-bg-layer-2` | Secondary nested surface | bluish-00 | bluish-850 `#2C2C2E` |
| `--dsw-specific-sidebar-fill` | 侧栏/布局填充（**实测它铺满整个视口**） | bluish-50 | bluish-900 `#1B1B1C` |

做法是 `color-mix(in srgb, var(--dsw-static-…) N%, transparent)` —— **保留原色值、只加透明度**，
所以切明/暗主题都不会串色。

> `--dsw-alias-bg-overlay`（弹出层/菜单）**故意保持不透明**，保证菜单文字可读。

---

## 安装

桌面应用是**官方 Desktop**，走 GUI（**不要**用 `dsh plugin --profile desktop`）：

> **插件 → 添加插件** → 填下面这个**绝对路径** → 启用 → **重启桌面应用**

```
C:\Users\Administrator\.dsh\local-plugins\dsh-local-background
```

（插件管理器接受绝对路径；相对路径会被 `parseInstallSpec` 拒绝。）

---

## 换图 / 调参：在插件界面里点（不用重启、改完立刻看见）

> **插件**（左侧栏）→ 找到 `dsh-local-background` → 行上的 **配置** 按钮。

打开后是这些控件，**每一次改动都立刻生效**，同时写进本目录的 `settings.json` 持久保存：

| 控件 | 作用 | 范围 |
| --- | --- | --- |
| **壁纸文件夹** | 图片从哪个文件夹读 | 绝对路径 |
| ├ `选择文件夹…` | 弹 **Windows 系统文件夹对话框** | 原生 |
| └ `手动浏览` | 系统对话框不可用时的后备，应用内逐级进目录 | — |
| **背景图不透明度** | 背景图自身多透明（**这是最常用的那个**） | 0% = 看不见图，100% = 原图 |
| **背景压暗** | 在图上盖一层黑，图太亮时压一压 | 0% = 不压暗 |
| **面板不透明度** | 界面面板多透明；越小背景越明显、字越难读 | 0~100% |
| **自动轮换** | 每隔几分钟换一张 | 0 = 不轮换，最大 1440 |

**换图仍然是把文件丢进那个文件夹就行** —— 加减图片后点 `重新读取` 即可（或刷新页面），
不用改插件、不用跑脚本、不用重新打包。

> 「背景图不透明度」和「背景压暗」是两个独立维度：
> 前者让**图本身**变淡（融进主题底色），后者给图**加黑**。想要"淡淡的壁纸"就降前者。

### 也可以直接编辑配置（等价，但要重启）

插件配置文件 `cordis.patch.yml` 里是同样的字段，作为**默认值**：

```yaml
- insert:
    - id: dsh-local-background
      name: dsh-local-background
      config:
        dir: 'D:\wallpapers'   # 壁纸文件夹（可留空，装好后在插件界面里选）
        rotateMinutes: 5       # 每几分钟换一张；0 = 不轮换
        dim: 0.45              # 背景压暗 0~1（图亮就加大）
        surface: 0.72          # 面板不透明度 0~1
        imageOpacity: 1        # 背景图不透明度 0~1
```

⚠️ **优先级：`settings.json`（界面里改的）覆盖 `cordis.patch.yml`（默认值）。**
所以你在界面上调过之后，再改 `cordis.patch.yml` 里的同名项**不会生效** ——
要么在界面上改，要么删掉 `settings.json` 回到默认值。

> `settings.json` / `report.log` 写在**用户态目录** `~/.dsh/dsh-local-background/`（或 `$DSH_HOME/dsh-local-background/`），
> 不在插件包里 —— 升级插件不会丢配置，也不会把你的目录路径打进发布包。
> 老版本写在插件目录里的 `settings.json` 仍会被读回来兜底。

- 支持 `.jpg .jpeg .png .webp .gif .avif .bmp`
- 顺序按文件名排序（中文按拼音），启动时随机洗牌，一轮内不重复
- 40 MB 的 4K 原图也没关系：浏览器自己缩放，`background-size: cover` 负责裁切

### 单图模式（可选，一般用不上）

`set-image.ps1` 仍然保留，用于「把某一张图直接嵌进 `client.js` 当兜底图」——
只有图片清单取不到（文件夹被删/为空）时才会用到它。正常情况不需要跑。

---

## 排障：三个实际踩过的坑（2026-10-08）

### ① 裸图片地址必须包 `url()`（踩过两次：data URI 一次、本地路径一次）

裸写会怎样：

```css
background-image: linear-gradient(...), data:image/jpeg;base64,/9j/... !important;   /* ✗ 非法 */
background-image: linear-gradient(...), /dsh-local-background/img/a.jpg  !important; /* ✗ 同样非法 */
```

两种都**不是合法的 CSS `<image>` 值** ⇒ 整条声明作废 ⇒ 计算值变成 **`background-image: none`**。
表现就是"改了没反应"，但 `--dsw-alias-bg-base` 等 token 覆盖照样生效（它们是另一条规则），
所以看起来像"样式进去了一半"。

渐变不需要 `url()`，所以默认兜底值当时看着是好的，掩盖了问题。

**判定口径**：`report.log` 里 `phase=diag` 的 `bgImg=none` 就是这条的症状 ——
此时 `img-ok` 往往还是正常的（`new Image()` 能加载），说明**图能取到，是 CSS 写法错了**。

现在 `cssImage()` 只放行真正的 CSS 图片函数（`url(` / `none` / 各类 `*-gradient` / `image-set`），
**其余一律包成 `url("...")`** —— 裸 `data:`、裸本地路径、裸 `https://` 都会被正确包装。

### ② 只透明化 `bg-base` 不够 —— 面板会盖住背景

见上面那张 token 表。**`--dsw-specific-sidebar-fill` 是罪魁**：它名义上是"侧栏填充"，
实测却铺满整个视口。它渲染得比首屏晚 ⇒ **启动时能看到背景，随后被它盖住变黑**。

⚠️ 这个现象和"某个壁纸皮肤有 bug"**无关**：任何把图垫在界面底下的做法都会撞上它。

### ③ leveldb 读取的两个坑（排查用）

- DSH 正占用 leveldb 文件 ⇒ 必须用 `FileShare.ReadWrite` 打开
- 同一个 key 的**历史值都留在日志里** ⇒ 必须取**最后一条**，取第一条会读到过期数据

### 排查工具

`read-probe.ps1` 从 Electron 的 localStorage 里读插件写的诊断：

```powershell
powershell -ExecutionPolicy Bypass -File .\read-probe.ps1
```

| Key | 内容 |
| --- | --- |
| `dsh-local-background:probe` | 执行到哪一步（`boot` / `rotating` / `fallback` / `list-error`）、挂载次数、图片数、当前图、目录、错误 |
| `dsh-local-background:diag` | 页面加载 2.5 秒后的 DOM 诊断：`opaquePainters`（扫出所有铺满视口且不透明的元素）、中心元素祖先链、各 token 实际值 |

判断口径：
- 两个 key 都没有 → 客户端 bundle 从未执行（插件没生效）
- `probe.phase = list-error` → 宿主路由没起来（宿主半侧报错或没重启）
- `probe.phase = fallback` → 目录读不到或没有图片（看 `probe.serverError`）
- `probe.phase = rotating` 但界面没背景 → 看 `diag.opaquePainters` 里还有谁在画不透明底

---

## 卸载

**首选**：桌面应用 → **插件** → 找到 `dsh-local-background` → 卸载。

**手动（仅在 GUI 出问题时）**：从 `~\.dsh\profiles\desktop\package.json` 的 `bundles` 与 `dependencies`
各删掉 `dsh-local-background` 一行，在 profile 目录跑一次 `pnpm install`，再重启。

**应急**：完全退出 DSH，把 `bundles` 里的 `"dsh-local-background"` 一行删掉（`dependencies` 留着无妨），重启即恢复默认外观。
本插件只注入一段 `<style>` + 两个只读路由，不改任何数据。

---

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `package.json` | 插件清单：`dsh.bundle.patch` + `dsh.client.platform=web` + 导出 `./client` |
| `cordis.patch.yml` | 插入 loader 条目 + **配置项的默认值** |
| `settings.json` | **界面里改过的值**（自动生成，优先级高于 `cordis.patch.yml`；删掉即回默认） |
| `index.js` | 宿主半侧：`webServer` 六条路由（清单 / 图片 / 选文件夹 / 浏览目录 / 写配置 / 诊断上报） |
| `client.js` | 客户端半侧：取清单、轮播、注入 CSS、**插件页里的设置界面** |
| `settings.json` | **界面里改过的值**（自动生成，存在用户态目录，不在包里） |
| `set-image.ps1` | 可选：把单张图嵌成 `client.js` 的兜底图 |
| `read-probe.ps1` | 排查：从 leveldb 读 probe/diag |

> `node_modules` 里的 `dsh-local-background` 是 pnpm 建的符号链接，本目录自身不需要 `npm install`。
> ⚠️ 改动 `client.js`（浏览器侧）由 HMR 自动接管，**存盘即生效**。
> 改动 `index.js`（宿主侧）需要 HMR 监视本目录 —— 若 `profiles\desktop\cordis.patch.yml` 里
> `hmr` 条目的 `root` 已包含本目录则同样即时生效，否则改完要**重启 DSH**。
