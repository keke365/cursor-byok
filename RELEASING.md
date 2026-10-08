# 桌面应用发行

当前发行仓库是 [`keke365/cursor-byok`](https://github.com/keke365/cursor-byok)。发布 GitHub Release 后，`.github/workflows/release.yml` 自动构建并上传安装包，无需用户自行编译。

## 触发方式

```text
将发行代码推送到 main
    │
    └── 仅更新代码，不发布安装包（CI 检查由 pull request 触发）

仓库所有者在 GitHub 发布 Release
    │
    ├── 校验标签格式、发行类型和 main 中的提交
    ├── 各平台独立 checkout 后，按标签同步桌面版本再构建
    ├── Linux x86_64：.deb、.AppImage、.rpm
    ├── Windows x86_64：NSIS setup.exe、便携 .zip
    ├── macOS：ARM64 和 x86_64 应用包
    └── 上传产物，确认 .deb 和 setup.exe 已上传且非空
        └── 在发行说明顶部写入直接下载链接，再标记为 Latest
```

创建草稿、仅推送标签、编辑已发布的 Release 都不会触发发行。点击 **Publish release** 才会触发。安装包会在编译完成后出现在同一 Release 的 Assets 中，通常需要数分钟或更久；不是点击发布后立即可下载。

## 发布步骤

1. 确认仓库的 GitHub Actions 已启用。Fork 仓库可能需要先在 **Actions** 页面启用工作流。
2. 选择尚未发布的版本标签，例如 `v2.1.2`。**标签是发行版本的唯一来源，无需预先手动修改源码中的版本号。**
3. 将经过检查、包含当前发布工作流和脚本的发行提交推送到 `main`。
4. 由仓库所有者在 **Releases → Draft a new release** 创建 Release：
   - 标签必须是 `vMAJOR.MINOR.PATCH`，例如 `v2.1.2`；构建版本自动变为 `2.1.2`，不要求与提交中的旧版本相等。
   - 标签必须指向已经包含在 `main` 中的发行提交。
   - 使用完整版本号，例如 `v2.0.0`，不要使用 `2.0` 或 `v2.0`。
   - 不勾选 **Set as a pre-release**。Beta 使用 `v2.2.0-beta.1`，后缀会完整保留到应用版本中，标题或说明须明确标注 Beta。更新客户端使用 `/releases/latest/download/`，因此 Beta 也采用普通 Release。
   - 建议取消 **Set as the latest release**，让工作流在全部平台成功后自动设置 Latest，避免自动更新客户端读取构建中的发行版。
5. 点击 **Publish release**，查看 **Actions → Release desktop app**。
6. 等待全部任务成功，确认 Assets 包含对应版本的 `*_amd64.deb` 和 `*_x64-setup.exe`。

工作流直接使用已发布 Release 的 ID 上传文件，不创建第二个 Release，也不会因 Release 已发布而跳过构建。保留手写的标题和发行说明。

全部平台构建和附件上传成功后，发行说明顶部会显示 **安装包下载**，包含 Linux x86_64 `.deb` 和 Windows x64 `.exe` 的可点击下载链接。链接直接取自 GitHub 附件 API 的 `browser_download_url`，指向该版本的真实文件，不指向 Actions 临时产物或其他版本。用户无需进入 Actions 页面，Release 下方的 Assets 也保留全部附件。

下载区域由 `.github/scripts/release-downloads.mjs` 生成，用隐藏的 `installer-downloads:start/end` 注释标记。重试工作流只替换此区域，不重复添加链接，也不删除区域外的手写内容。缺少安装包、文件为空、上传未完成或版本不匹配时会报错，不写入无效下载链接。工作流只监听 `published`，更新发行说明不会递归触发构建。

修改工作流不会补跑以前的 `2.0` Release。发布新版本时使用新标签，不删除、移动或复用既有标签。工作流失败后，先修复问题；重试原任务会构建原标签指向的代码，不会自动使用新的 `main` 代码。只有修复了外部环境或仓库配置时才适合重试，否则应提交修复并发行新版本。

## 自动版本同步

`.github/scripts/release-version.mjs` 统一负责标签校验和版本同步，无需安装额外依赖：

- `prepare` 使用 `--check` 从 Release 标签解析完整版本，通过任务输出供后续打包和更新清单使用。
- Linux、Windows、macOS 的每个 `publish` 任务都在独立 checkout 后、`npm ci` 和 Tauri 构建前执行 `--write`。任务之间不共享工作目录，因此不能只在 `prepare` 修改文件。
- 自动同步 `apps/desktop/package.json`、`apps/desktop/package-lock.json` 的顶层及 `packages[""]`、`apps/desktop/src-tauri/tauri.conf.json`、`apps/desktop/src-tauri/Cargo.toml` 和根目录 `Cargo.lock` 的 `cursor-byok-desktop` 条目。
- `cursor-server` 和依赖版本保持不变；同步结果只存在于构建工作目录，不自动提交或回写 `main`。源码中保留的版本用于未执行同步的本地开发构建，不限制后续发行版本。
- 无效标签（如 `v2.1`、`v02.1.1`）或 GitHub prerelease 会直接失败。正式标签和 Beta 标签都必须指向 `main` 中的提交。

现有旧标签仍使用它所指向提交中的工作流。将修复推送到 `main` 后，需要在包含修复的提交上创建新标签并发布 Release，重试旧标签不会加载新脚本。

## 安装包和自动更新签名

**生成 `.deb` 和 `.exe` 不需要任何签名 Secret。** 默认发行会关闭 Tauri 更新签名产物生成；用户可以下载安装包并手动升级。Windows 仍会提示未经过 Windows 代码签名的发布者，Tauri 更新签名不是 Windows Authenticode 代码签名。

若要启用应用内自动更新，在 **Settings → Secrets and variables → Actions** 配置成对的密钥：

- Secret `TAURI_SIGNING_PRIVATE_KEY`：本仓库自己的 Tauri 签名私钥。
- Variable `TAURI_SIGNING_PUBLIC_KEY`：与私钥对应的 Tauri 编码公钥。
- Secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：仅私钥有密码时配置。

可以通过 Tauri CLI 的 `signer generate` 生成密钥；私钥必须存放在 Git 忽略的 `.tauri/` 或其他安全位置，绝不能提交。Fork 不会继承上游仓库的 Secrets，也不能继续使用上游公钥签发本仓库的更新。

私钥、公钥都未配置时正常构建无更新签名的安装包。仅配置其中一个时，工作流会明确报错，避免生成无法通过签名校验的更新。

签名配置完整时，工作流通过临时 `tauri.release.conf.json` 注入本仓库的公钥、启用更新产物，并上传 `latest.json`、`portable-latest.json` 和对应 `.sig` 文件。临时配置只包含公钥和构建选项，不包含私钥，并且已加入 Git 忽略规则。

桌面程序的安装版和 Windows 便携版都从 `keke365/cursor-byok` 检查更新。自动更新签名始终保留；无签名发行只支持下载安装包手动升级。

## 本地检查

从仓库根目录运行：

```bash
node --test .github/scripts/*.test.mjs
cargo fmt --all -- --check
```

工作流的脚本测试也会在普通 CI 中执行。可选的 GitHub Actions 语法检查：

```bash
go run github.com/rhysd/actionlint/cmd/actionlint@latest -shellcheck= -pyflakes= .github/workflows/release.yml .github/workflows/ci.yml
```

跨平台安装包的最终验证需要 GitHub Actions 的 Linux、Windows 和 macOS 环境。修改本地配置、通过静态检查，不代表已在 GitHub 成功发布。
