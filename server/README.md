# zhai Web 服务

Sealos 0.29.0 ARM64 评委版提供免登录网页。评委打开 HTTPS 网址后，服务用签名 Cookie 区分浏览器，分别保存会话、上传材料、能力包和成果。原浏览器可以继续使用升级前的资料。

## 部署

容器以单实例运行，监听 `0.0.0.0:8080`。在 Sealos 挂载持久卷到 `/app/zhai/data`，将健康检查设为 `GET /api/health`。管理员通过服务端 Secret 提供 `ZHAI_LLM_API_KEY`，默认模型为天翼云的 `deepseek-v4-flash-0731-new`。更新时沿用原域名、持久卷和 Secret。构建命令、安装步骤和升级检查见[镜像部署说明](../deploy/sealos/IMAGE.md)。

## 文件处理与能力包

现有 Word 排版、居中页码、文字操作、Excel 汇总和 PDF 文本层提取使用随镜像安装的文件引擎。上传原件保留，只交付重新打开校验过的成果。

从 0.29.0-r2 起，页码工具可以识别 Word 复合页码域。独占一段的页码就地居中；和落款共用一段的普通页码可以移到独立居中段。涉及表格位置或嵌套计算时，按实际布局提示需要确认的选择。首页、奇偶页和已有编号格式随原文保留。

联网文件 Agent 可以先查看所选材料的结构。工具报错后，模型可结合诊断调整调用，再运行验证。在设计会话中输入“试试”会测试当前草稿。带样本设计或点击“自动修复并重测”时，服务可根据失败原因尝试一次修复。改变步骤次序的修法单独保存为候选草稿，通过样本后可打开成果核对、决定是否发布。

可以从“设计能力包”入口描述规则、用样本试跑并发布，也可以在成功的文件处理对话里选择“生成能力包测试版”。后一个入口从本轮单次引擎作业复制真实步骤、执行参数和对应样本，支持复用该作业内的多个连续步骤。历史版本缺少执行记录的任务可从设计入口重新创建。

网页端的能力包由服务端登记的文件工具组成。动态 Python 脚本、完整 Codex Harness、桌面 OCR 和 WPS 桥接详见桌面版。联网对话按所选材料及正文授权调用管理员配置的模型。设计新规则时，样本用于理解处理要求；页面会显示相应提示。

## 开发与验证

从仓库根目录运行。安装 Python 3.12 与 `engine/requirements.txt` 中的依赖后，构建同源前端并启动服务。

```sh
VITE_WEB_API=1 npm run build
ZHAI_JUDGE_MODE=1 ZHAI_COOKIE_SECURE=0 ZHAI_DATA_DIR="$PWD/.build/web-dev-data" \
  ZHAI_WEB_HOST=127.0.0.1 ZHAI_WEB_PORT=8080 python3 server/app.py
```

`ZHAI_COOKIE_SECURE=0` 供本机 HTTP 调试，生产 HTTPS 使用默认的 Secure Cookie。服务测试使用 `engine/.venv-build/bin/python3 -m pytest server/tests -q`。

0.27.1 曾提供独立 DevBox ZIP，当前评委版采用镜像部署。
