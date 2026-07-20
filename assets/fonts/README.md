# 卡片中文字体（可选）

插件**不会**自动下载字体，也**不会**把大字体打进默认发行包，以保持体积轻量。

## 何时需要

渲染卡片需要能画中文的 `.ttf` / `.otf` / `.ttc`。解析顺序：

1. 配置 `card_font_path`（绝对路径或相对插件根）
2. **本目录**任意字体文件
3. 系统常见路径（Noto CJK / 微软雅黑 / PingFang 等，有则用）

全部找不到时：出卡失败并**回退纯文本**（不会出方块字）。

## 推荐做法

### A. 放到本目录（随插件部署）

```bash
# 示例：自行下载 Noto Sans SC（SIL OFL）后放入
cp /path/to/NotoSansSC-Regular.otf ./NotoSansSC-Regular.otf
```

### B. 配置绝对路径

在插件配置 / WebUI 填写 `card_font_path`，例如：

- Linux: `/usr/share/fonts/google-noto-sans-cjk-vf-fonts/NotoSansCJK-VF.ttc`
- Windows: `C:\Windows\Fonts\msyh.ttc`
- 自备: `/data/fonts/MyCJK.otf`

### C. 系统已装中文字体

多数桌面 Linux / Windows / macOS 已有 CJK 字体，无需额外操作。

## 体积说明

完整中文字体通常 **数 MB～十余 MB**。因此：

- 默认仓库与插件 zip **不内置**大字体
- **不**在运行时往 `~/.cache` 强行下载
- 需要离线/精简系统出卡时，由部署者按上面 A/B 自行放入

若本机曾启用过旧版「自动下载」，可手动清理：

```bash
rm -rf ~/.cache/astrbot_plugin_hapi_connector/fonts
```
