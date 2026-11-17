zhai 银河麒麟版不捆绑 LibreOffice。

WPS Linux 安装后，zhai 会检测 wps、et 或 wpp，但“检测到 WPS”不等于“官方桥接可用”。
转换只在外部桥接的 --probe 返回对应能力为 true 后启用。

桥接可执行文件的搜索顺序：
1. 环境变量 MATERIAL_ASSISTANT_WPS_BRIDGE
2. /usr/lib/zhai/material-wps-bridge
3. /usr/local/libexec/zhai/material-wps-bridge
4. ~/.local/libexec/zhai/material-wps-bridge
5. PATH 中的 material-wps-bridge

桥接契约：
- material-wps-bridge --probe
- material-wps-bridge convert --action <doc-to-docx|xls-to-xlsx|xlsx-recalculate|docx-to-pdf|xlsx-to-pdf> --input <path> --output <path>

桥接需返回 JSON，并由 zhai 对生成文件重新打开验收。请只使用已授权的 WPS 官方 RPC/加载项组件实现该桥接。
