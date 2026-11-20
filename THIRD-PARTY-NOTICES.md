# 第三方组件

ZHAI 自有代码使用 MIT 许可证。下列独立程序及依赖保有各自许可证。

- [Tauri](https://github.com/tauri-apps/tauri) 使用 MIT 或 Apache-2.0 双许可证。前端和 Rust 依赖版本见相应锁文件。
- [Codex CLI](https://github.com/openai/codex/tree/rust-v0.171.0) 和 [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.144) 使用 Apache-2.0。包含这些组件的平台附对应的许可证和声明。
- Linux ARM64 安装包包含 [Antiword](https://packages.ubuntu.com/focal/antiword)（GPL-2.0）和 [Bubblewrap](https://github.com/containers/bubblewrap/tree/v0.12.0)（LGPL-2.1）。对应源码与声明随安装包提供，位于 `/usr/share/doc/zhai/`。
- 可选 Linux OCR 包的模型和运行时声明见 [OCR_THIRD_PARTY_NOTICES.md](engine/OCR_THIRD_PARTY_NOTICES.md)。
- 文件引擎使用 Python 及 [requirements.txt](engine/requirements.txt) 列出的依赖。依赖使用各自上游许可证。
