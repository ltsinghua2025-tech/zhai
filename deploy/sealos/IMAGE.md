# 构建 Sealos ARM64 评委版

该镜像提供免登录 Web 应用。浏览器通过签名 Cookie 访问自己的会话、材料和成果。文件引擎和前端随镜像提供，联网对话使用管理员配置的模型服务。网页能力包调用服务端登记的文件工具。

## 从公开源码构建

在仓库根目录运行。准备 Node.js 22、Python 3、Git 和能构建 Linux ARM64 的 Docker 环境。以下固定提交提供已经过哈希校验的 Python 3.12 ARM64 wheels。

```sh
mkdir -p .build/sealos
git clone --bare https://github.com/ltsinghua2025-tech/zhai-sealos.git .build/sealos/wheels.git
git --git-dir=.build/sealos/wheels.git archive --format=zip \
  --output=.build/sealos/wheels.zip ae71ef6b76954a939beef887aa194df4b5a38b8e \
  zhai/manifest.json zhai/engine/requirements.txt zhai/wheels/aarch64
npm ci
npx tsc --noEmit
VITE_WEB_API=1 node --input-type=module -e \
  'import { build } from "vite"; await build({build:{outDir:".build/sealos/dist",license:true}})'
python3 deploy/sealos/image/prepare.py --frontend .build/sealos/dist \
  --offline-zip .build/sealos/wheels.zip --context .build/sealos/context
docker buildx build --platform linux/arm64 --network none --load \
  -t zhai-web:0.29.0-arm64-r2 .build/sealos/context
```

首次构建需要取得 Dockerfile 固定摘要的 Python 基础镜像。生成上下文时请使用新目录。准备脚本核对依赖清单及每个 wheel 的摘要，镜像内离线安装。运行时无需重新安装依赖。

## 部署参数

| 项目 | 值 |
| --- | --- |
| 服务端口 | TCP 8080，平台对外使用 HTTPS |
| 实例 | 1 |
| 持久卷 | `/app/zhai/data`，升级时沿用原卷 |
| 健康检查 | `GET /api/health` |
| 模型凭据 | 在平台 Secret 配置 `ZHAI_LLM_API_KEY`，或挂载已有服务端配置文件到 `/run/zhai/private-config.json` |
| 默认服务 | 天翼云，`https://ai.ctaigw.cn/v1`，模型 `deepseek-v4-flash-0731-new` |

已有实例可在原应用变更镜像标签，沿用原端口、路由、存储和 Secret。替换前备份持久卷并记录旧镜像标签。升级后通过原域名检查健康接口，用原浏览器打开已有会话，下载一份旧成果，再用新样本试跑。
