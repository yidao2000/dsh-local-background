# 发布与信任发布（Trusted Publishing）运行手册

本仓库的 npm 发布走 **OIDC 信任发布**：不在任何地方存 token，也不需要 2FA 验证码。
打一个 `v*` tag 即触发 `.github/workflows/publish.yml`。

参考：<https://docs.npmjs.com/trusted-publishers>

---

## 当前状态（2026-10-16）

- 插件市场：PR [#7437](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/7437) 两道检查已 **success**，等维护者合并。
- npm：**尚未发布**。账号 `yi_dao2000` 处于 npm 的 **72 小时 recovery-code security hold**，
  期间 `npm publish`、`npm stage publish`、创建 token、改账号设置**全部被拒**（E403 suspended）。

### 为什么被 hold

因为登录 npm 时**使用了恢复码**（recovery code）。这是 npm 自 2026-09 起的强制策略：

> When you use a recovery code to log in, npm places a temporary **72-hour security hold** on your account.

- 计时锚点 = **第一次**成功用恢复码登录的时刻（再用新码**不会**延长）。
- **无法提前解除**，72 小时后自动恢复，不需要联系客服。
- hold 期间**可以**：登录、浏览/下载/安装包、改密码、**添加新的 2FA 方法**。
- hold 期间**不可以**：publish / unpublish、创建 access token、改包设置或维护者、
  改组织/团队、改计费或账号设置、**修改已存在的 2FA 方法**（所以 `npm profile disable-2fa` 也不通，
  它本身还要 OTP —— 是死循环）。

---

## ⚠️ hold 期间唯一该做的一件事：补上可用的 2FA 方法

整个困境的根源是「2FA 开着，但没有任何可用的验证器，只能反复烧恢复码」。

npm 现在用的是 **WebAuthn 安全密钥**（不是 TOTP 二维码 —— 这解释了为什么开启时"没有二维码"）。
**Windows Hello**（指纹 / PIN / 人脸）就能直接当安全密钥用。

1. 打开 <https://www.npmjs.com/settings/yi_dao2000/tfa>
2. 点 **Modify 2FA** → 添加 **security key**
3. 浏览器会弹出系统的 Windows Hello 窗口，按提示完成

做完之后：
- `npm publish` / `npm stage approve` 的 2FA 挑战会自动走系统生物识别；
- **永久不再需要恢复码**。

> 🔴 **不要**再用剩下的那个恢复码（`66995942…c985b5`）。用它登录会**重新触发一轮 72 小时 hold**，
> 白白再等三天。
>
> 🔴 **不要**再点 Enable 2FA、不要试着关 2FA —— 都会重新触发冻结。

---

## hold 解除后：首次发布

有两条路，推荐 **A**（全自动、全程不需要验证码）。

### 路线 A —— 用 staged publishing 让包"诞生"，再用 OIDC 正式发（推荐）

背景：信任发布有个鸡生蛋问题 —— **npm 包必须先存在，才能配置 trusted publisher**。
而 `npm stage publish` 在包不存在时会创建一个 `0.0.0-stage` 占位版本
（占位版本公开可见，但 staged 的内容不可见），**正好让包先存在**。

```powershell
# 1) 提交到 staged 队列（若包不存在，同时创建 0.0.0-stage 占位版本）
#    注意：这一步不需要 2FA
npx --yes npm@12.2.0 stage publish --access public --registry=https://registry.npmjs.org/

# 2) 拿到 stage-id
npx --yes npm@12.2.0 stage list --registry=https://registry.npmjs.org/
```

3) 去 npmjs.com 配置 trusted publisher（见下节）。
4) 打 tag 推送，让 Actions 用 OIDC 正式发布：

```powershell
git tag v1.3.0
git push origin v1.3.0
```

### 路线 B —— 直接在本地 approve（需要可用的 2FA）

```powershell
npx --yes npm@12.2.0 stage approve <stage-id> --registry=https://registry.npmjs.org/
# 会被要求 2FA；配好 Windows Hello 后自动通过
```

---

## 配置 trusted publisher（npm 包页设置）

npmjs.com → **Packages** → `dsh-local-background` → **Settings** → **Trusted Publisher**
→ **Select your publisher** 选 **GitHub Actions**，填：

| 字段 | 值 |
| --- | --- |
| **Organization or user**（必填） | `yidao2000` |
| **Repository**（必填） | `dsh-local-background` |
| **Workflow filename**（必填） | `publish.yml` |
| **Environment name**（可选） | 留空 |
| **Allowed actions**（必填） | 至少选 `npm publish`；也可一并选 `npm stage publish` |

要点：
- **Workflow filename 只写文件名**，不带路径，必须含 `.yml` / `.yaml`；文件必须在
  `.github/workflows/` 下（本仓库：`.github/workflows/publish.yml`）。
- 所有字段**大小写敏感**，必须完全一致；npm 保存时**不做校验**，写错只会在发布时
  报 `ENEEDAUTH`。
- **新配置必须在 2 天内完成首次成功发布**，否则自动过期作废（过期后要删掉重建）。
  首次发布成功即「已验证」，绑定到仓库的不可变身份，之后不再过期。
- 发布目标必须与 `package.json` 的 `repository.url` **完全一致**
  （本仓库：`git+https://github.com/yidao2000/dsh-local-background.git` ✓）。
- 触发事件只能用 `push` / `release` / `workflow_dispatch`；npm **拒绝**来自
  `issue_comment` 和 `pull_request_target` 的 trusted publishing token。

配置好之后，在包设置里还可以把 **Publishing access** 设为
**"Require two-factor authentication and disallow tokens"** —— 这只影响传统 token，
trusted publisher 用的是 OIDC 短时令牌，不受影响。

---

## 发新版本的标准流程

```powershell
# 1) 改 package.json 的 version
# 2) 提交
git add -A
git commit -m "release: v1.4.0"
git push origin main
# 3) 打 tag（tag 名必须与 package.json 的 version 一致，workflow 会校验）
git tag v1.4.0
git push origin v1.4.0
```

workflow 会自动：校验 tag 与 `package.json` 版本一致 → `npm publish --access public`（走 OIDC）
→ 自动生成 provenance（用 OIDC 发布时 provenance 是默认行为，不需要 `--provenance`）。

---

## 环境要求（都已满足）

| 要求 | 本仓库 |
| --- | --- |
| npm CLI ≥ 11.5.1（信任发布） | Node 24 自带 npm **11.19.1** ✓ |
| npm CLI ≥ 11.15.0 + Node ≥ 22.14.0（staged publishing） | ✓ |
| GitHub **托管** runner（自托管不支持） | `ubuntu-latest` ✓ |
| workflow 有 `id-token: write` 权限 | ✓ |
| 仓库公开、包公开（provenance 需要） | ✓ |

本机 npm 是 10.9.7（太老，没有 `stage` 子命令），所以本地操作用
`npx --yes npm@12.2.0 …` 顶上去。
