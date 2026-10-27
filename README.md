# 抖音知识库 · Douyin Knowledge Vault

把抖音收藏的视频自动整理成本地 Obsidian 知识库：自动采集收藏 → 下载音视频 → Whisper 本地转录 → AI 提炼知识点 → 按分类归档成 Markdown 笔记，全程在你自己电脑上跑，不碰你的账号密码。

## ✨ 功能

- 一键采集抖音收藏夹，自动跳过广告/短剧/无对白视频，不浪费 API 额度
- 内置 Whisper 本地转录，不上传你的视频到第三方
- 支持自定义 LLM API（DeepSeek/OpenAI 兼容接口），用你自己的 Key 生成结构化笔记
- 自动分类归档成 Obsidian 可用的 Markdown 文件，按收藏夹/大类/子类分层整理
- 每周自动同步新增收藏，支持 Windows 开机自启定时任务
- 8 款风景主题皮肤，液态玻璃 UI，全程本地运行
- 内置 Python/Whisper/FFmpeg 运行时，双击安装包即可使用，无需额外配置环境

## 🚀 快速开始

1. 去 [Releases](https://github.com/jinmm1233/douyin-knowledge-vault/releases) 下载最新的 `抖音知识库-Setup-1.0.0.exe`
2. 双击安装，打开软件
3. 第一步：在设置里选好你的 Obsidian 知识库保存路径
4. 第二步：填入你自己的 LLM API Key（DeepSeek 等 OpenAI 兼容接口）
5. 第三步：点「开始处理收藏」，扫码登录抖音，就会自动开始整理你的收藏了

## 📝 从源码运行

```bash
# 安装依赖
npm install

# 开发模式运行
npm start

# 打包 Windows 安装包
npm run dist
```

需要本地有 Node.js 环境，Python 依赖需要自己装 faster-whisper、playwright 等。

## ⚠️ 注意事项

- 软件只读取你自己账号的收藏，用你自己的登录态，不爬别人的数据
- 所有 AI 处理都在你自己的电脑或你自己的 API Key 下运行，软件作者看不到你的内容
- 知识库是纯 Markdown 文件，你可以用任何编辑器打开，不被软件锁死
- Whisper 模型首次运行会自动从国内镜像下载，约几百 MB
- 目前仅支持 Windows 系统，Mac/Linux 版本后续会考虑

## 🤝 贡献

欢迎提 Issue 和 PR，新功能建议可以直接提。

## ☕ 支持作者

如果这个工具帮到了你，欢迎请作者喝点东西，微信扫码即可：

（打赏二维码放在 assets 目录里）

所有功能永久免费开放，打赏 purely 是支持作者持续更新。
