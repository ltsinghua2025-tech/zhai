# ZHAI · 文件处理工作台

ZHAI 可以批量排版 Word、公文套红、合并 Excel 和处理 PDF。经样本测试后发布的离线能力包由本地文件引擎执行。使用这类能力包无需 API Key、网络或本地模型，成果另存为新文件。

[浏览器体验](https://ltsinghua2025-tech.github.io/zhai/)可直接运行公文排版，支持内置合成样例和单个不超过 10 MB 的 DOCX。排版在浏览器中完成，无需填写 API Key。桌面版提供批量操作、更多能力包和联网文件 Agent。网站依赖使用 `python3 preview/build_browser_runtime.py` 构建，授权与校验见 `preview/runtime/`。

## 下载与安装

从 [最新版本](https://github.com/ltsinghua2025-tech/zhai/releases/latest) 下载对应系统的安装包。平台验证范围见各版发布说明。

| 系统 | 适用范围 | 安装包 |
| --- | --- | --- |
| macOS | macOS 13 或以上，Apple Silicon | `.dmg` |
| Linux | 银河麒麟 V10 SP1 兼容目标，ARM64，使用 WebKitGTK 4.0 | `.deb` |
| Windows | Windows 10/11，x64，需 WebView2 | 预览 `.exe`（见发布页） |

将 macOS 镜像中的 `zhai.app` 拖入「应用程序」。此版本使用本地签名，未经 Apple 公证。银河麒麟 V10 SP1 ARM64 安装包使用 `sudo apt install ./zhai_0.28.2_arm64.deb` 安装；需要扫描识字时同时指定 `./zhai-ocr_0.28.2_arm64.deb`。Windows 预览提供离线能力包和兼容接口执行，完整 Codex Harness 与临时 Python 脚本在 Windows 上不可用。

## 配置自己的 API

使用联机文件 Agent 时，在「模型服务」添加 DeepSeek 或兼容接口，填写服务地址、模型 ID 和自己账户的 API Key，先点「测试连接」。自定义兼容接口的地址和模型 ID 以服务商的文档或模型列表为准。首次启动即可在「能力包」直接试用离线功能。

公开版随附通用的市民诉求答复示例。使用真实材料前，按所在单位规定核对所用模型服务的访问权限和材料授权。

## 从源码构建

macOS 需要 Apple Silicon、Xcode Command Line Tools、Node.js 22、Rust、Python 3。在仓库目录运行：

```sh
npm ci
npm run package:mac
```

Linux ARM64 兼容包可在 Apple Silicon 上通过 `npm run package:kylin` 在独立 Focal 环境构建。构建环境安装 WebKitGTK 4.0 等系统依赖，并生成主包与可选 OCR 包。

Windows x64 在已安装 Node.js 22、Rust MSVC 工具链和 Python 3.12 的 Windows 环境构建：

```powershell
npm ci
./scripts/build-windows.ps1 -Python3Path (Get-Command python3).Source
```

该脚本会构建冻结的文件引擎和 NSIS 安装包。Windows 构建流程在一次性环境中用 `-TestInstaller` 安装并运行应用自检。本地开发的前端检查为 `npm test` 和 `npm run build`。

## 许可证

ZHAI 自有代码按 [MIT](LICENSE) 许可发布。随安装包提供的第三方组件见 [第三方声明](THIRD-PARTY-NOTICES.md)。
