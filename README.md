# 抖音知识库 (Douyin Knowledge Vault)

把你抖音里收藏的视频自动整理成一个本地 Markdown 知识库，落进 Obsidian。

## 它做什么

1. **拉收藏**：用你自己的抖音登录态，把"我的收藏"列表里的视频拉下来
2. **转文字**：本地用 faster-whisper 把视频音频转成文字稿（不上传音频）
3. **AI 提炼**：用你自己填的 OpenAI 兼容 API Key（DeepSeek / OpenAI / Kimi / 通义等都行），把文字稿提炼成结构化笔记——分类、观点、行动项、概念
4. **写进 Obsidian**：纯 `.md` 文件落到你指定的 vault 目录，软件只是读写文件，不建私有数据库
5. **可视化**：知识卡片、观点印证网络图谱、语义检索、每周学习周报

## 目录结构

```
├── main.js / preload.js        Electron 主进程 + 预加载
├── cangjie-runner.js           蒸馏流水线执行器
├── renderer/                   前端 UI（原生 HTML/CSS/JS）
├── cli/                        命令行采集器（Node + Python）
│   ├── src/                    采集/转录/分类/蒸馏逻辑
│   ├── scripts/                Windows 启动脚本（定时任务用）
│   ├── python/                 Whisper 转录脚本
│   └── requirements.txt       Python 依赖
└── assets/                     图标、默认背景、打赏码
```

## 自己跑（开发模式）

前置：Node.js ≥ 22、Python ≥ 3.10、一个 OpenAI 兼容 API Key

```bash
npm install
# 装 Python 依赖
pip install -r cli/requirements.txt
# 启动
npm start
```

第一次打开会让你填：
- 项目路径（cli/ 目录位置）
- Obsidian vault 路径
- AI Base URL + API Key（不填只能转录，不能提炼笔记）
- 抖音登录态（第一次会弹浏览器让你扫码登录）

## 打安装包

```bash
npx electron-builder --win nsis
```

产物在 `release/`。打包时会把 Node 运行时和 Python/Whisper 模型一起塞进去，用户拿到就能用，不用自己装环境。

## 隐私

- 所有笔记存在你本地磁盘，不上传任何服务器
- 音频转录在本地跑，视频音频不出本机
- AI 提炼只把文字稿发给你自己填的 API Key 对应的服务
- 软件不联网上报、不收集使用数据

## License

MIT
