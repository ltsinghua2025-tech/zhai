# ZHAI · 文件处理工作台

ZHAI 可以批量排版 Word、公文套红、合并 Excel 和处理 PDF。经样本测试后发布的离线能力包由本地文件引擎执行。使用这类能力包无需 API Key、网络或本地模型，成果另存为新文件。

[浏览器体验](https://ltsinghua2025-tech.github.io/zhai/)可直接运行公文排版，支持内置合成样例和单个不超过 10 MB 的 DOCX。排版在浏览器中完成，无需填写 API Key。桌面版提供批量操作、更多能力包和联网文件 Agent。网站依赖使用 `python3 preview/build_browser_runtime.py` 构建，授权与校验见 `preview/runtime/`。

自托管的 Sealos 网页版同样使用本仓库的前端和文件引擎。`server/` 提供会话、文件处理和能力包接口。镜像构建、存储、健康检查及模型配置见 [Sealos ARM64 镜像说明](deploy/sealos/IMAGE.md)。

## 下载与安装

评委请打开下载说明，按电脑系统选择安装包。银河麒麟和 Mac 评委版均已配置天翼，安装后即可使用联网文件 Agent。Windows 轻量版在本机离线处理文件。[国内入口（腾讯文档）](https://docs.qq.com/doc/DYktkWlJXZklUTEdZ) · [GitHub 下载页](https://ltsinghua2025-tech.github.io/zhai/download/)

| 系统 | 适用范围 | 安装包 |
| --- | --- | --- |
| 银河麒麟 · 推荐版 | V10 SP1，ARM64 | 0.29.0-2 评委 ZIP。完整解压，在含有 `安装.sh` 的文件夹打开终端，执行 `bash 安装.sh`。 |
| Mac · 测试版 | Apple 芯片（M 系列），macOS 13 或更新 | 0.29.0 评委 DMG。打开后将 `zhai.app` 拖入「应用程序」，首次启动会自动配置天翼。 |
| Windows · 离线工具测试版 | Windows 10 / 11，x64 | 0.29.1 轻量版。运行 EXE，打开「离线工具」，选择工具并添加文件。已装 WebView2 的电脑可断网安装，缺少时安装器会联网补齐。 |

Mac 测试版使用本地签名。首次打开若提示无法验证开发者，可在「系统设置 → 隐私与安全性」选择「仍要打开」。GitHub 另有自行配置模型的通用版和校验值。[Mac 0.29.0 测试版发行说明](https://github.com/ltsinghua2025-tech/zhai/releases/tag/v0.29.0-macos-beta)

麒麟版安装与功能测试在 Ubuntu 20.04 ARM64 对照环境完成。需要手动安装 DEB 时，可执行 `sudo apt install ./zhai_0.29.0-2_arm64.deb`，安装或升级 OCR 时在同一命令中加入 `./zhai-ocr_0.29.0-2_arm64.deb`。[银河麒麟 0.29.0-2 发行说明与校验值](https://github.com/ltsinghua2025-tech/zhai/releases/tag/v0.29.0-2-linux)

## 配置自己的 API

Windows 离线工具版使用本机文件引擎，无需账号或 API。可读取 Word 和 Excel、批量修改文字、合并 Word、按一级标题拆章、按表头汇总 Excel、按工作表拆分，并可处理 PDF。DOC 转 DOCX 等旧格式转换需要本机安装 LibreOffice。安装包、中文说明和校验值见 [Windows 0.29.1 离线工具测试版](https://github.com/ltsinghua2025-tech/zhai/releases/tag/v0.29.1-windows-offline-beta)。以下模型设置适用于有联网 Agent 的桌面版本。

使用通用版或希望接入自己的模型时，在「模型服务」添加 DeepSeek 或兼容接口，填写服务地址、模型 ID 和自己账户的 API Key，再点「测试连接」。自定义兼容接口的地址和模型 ID 以服务商的文档或模型列表为准。首次启动即可在「能力包」直接试用离线功能。

麒麟与 Mac 的 0.29.0 系列使用内置 Codex CLI 0.171.0。应用会实测网关能否调用工具并接收结果。通过后，Agent 可连续选工具、试跑，在同一轮根据实际错误调整做法。可以直接「设计能力包」，也可以把普通对话中成功的文件任务保存为测试版，换样本验证后再发布。

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
