# blive

> Bilibili 直播间监控 + mpv 后台音频播放，ZTools 插件

基于 **React 19 + Vite 6 + TypeScript** 构建。

## 功能

### 直播间监控

- 添加多个 Bilibili 直播间 room_id，API 验证后保存
- 卡片式展示直播间封面、标题、主播名、分区、在线人数
- 直播状态标签（直播中 / 未开播），B 站粉色风格
- 可配置的轮询间隔（1 / 5 / 10 / 30 分钟）
- 数据持久化到 localStorage，重启不丢失

### mpv 音频播放

- 鼠标移至**开播中**的卡片封面，显示播放遮罩
- 点击 ▶ 后台启动 mpv 播放直播音频流（`--no-video`）
- 再次点击 ⏹ 停止播放
- 每个房间独立播放状态，互不干扰

## 环境依赖

| 工具 | 说明 |
|------|------|
| [mpv](https://mpv.io) | 命令行播放器，用于播放直播音频流 |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | 视频提取工具，mpv 通过它解析 Bilibili 直播流地址 |

安装：

```bash
brew install mpv yt-dlp
```

## 项目结构

```
.
├── public/
│   ├── logo.png              # 插件图标
│   ├── plugin.json           # 插件配置（功能注册、指令定义）
│   └── preload/
│       ├── package.json      # Preload 模块类型
│       └── services.js       # Node.js 能力：API 请求、mpv 进程管理
├── src/
│   ├── main.tsx              # React 入口
│   ├── main.css              # 全局样式（暗色模式支持）
│   ├── App.tsx               # 根组件（路由分发）
│   ├── env.d.ts              # TypeScript 类型声明
│   └── Live/
│       ├── index.tsx         # 直播间列表 + 监控 + 播放控制
│       └── index.css         # 卡片布局、遮罩动画
├── index.html                # HTML 模板（含 no-referrer 防盗链策略）
├── vite.config.js            # Vite 配置
├── tsconfig.json             # TypeScript 配置
├── package.json              # 项目依赖
└── README.md
```

## 快速开始

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run dev
```

开发服务器在 `http://localhost:5173` 启动，ZTools 自动加载开发版本。

**注意**：修改 `public/preload/services.js` 后需要 `npm run build` 才能生效，dev server 不会热更新 preload 脚本。

### 构建

```bash
npm run build
```

产物输出到 `dist/` 目录。

## 使用方式

1. 在 ZTools 中输入 `直播` 触发插件
2. 输入 Bilibili 直播间 room_id，点击「添加」
3. 卡片自动加载封面、标题、主播信息
4. 开播中的房间，鼠标移到封面出现 ▶ 图标，点击即可听直播
5. 再次点击封面停止播放

## 注意事项

- **preload 修改需构建**：`public/preload/services.js` 在 dev 模式下不会热更新，修改后必须 `npm run build`
- **PATH 问题**：ZTools 启动的 shell 环境不加载 `.zshrc`，`services.js` 中已硬编码 `/opt/homebrew/bin/mpv` 和 `/opt/homebrew/bin` 路径。如果你的 mpv/yt-dlp 安装在其他位置，需要修改 `services.js` 中的路径
- **图片防盗链**：`index.html` 设置了 `<meta name="referrer" content="no-referrer">`，解决 Bilibili CDN 图片的 Referer 校验
- **API 403**：Bilibili API 会检测请求头判断是否为脚本请求，插件通过 preload 层的 Node.js `https` 模块绕过浏览器的 `sec-fetch` 检测
- **仅支持 macOS**：`plugin.json` 中 `platform` 限定为 `darwin`
- **Bilibili API**：使用 `getRoomBaseInfo` 接口，支持一次请求查询多个房间，无需 WBI 签名

## 技术要点

### 为什么用 preload 发 API 请求？

浏览器渲染进程的 `fetch()` 会自动添加 `sec-fetch-mode: cors` 头，Bilibili CDN 据此拦截非浏览器导航请求返回 403。通过 preload 层 Node.js 的 `https` 模块发请求可以完全控制请求头，模拟浏览器行为。

### mpv 进程管理

- 使用 `child_process.exec` 启动 mpv，通过 shell 执行确保环境一致
- 显式设置 `PATH` 环境变量包含 `/opt/homebrew/bin`
- 每个 room_id 独立追踪进程，停止时 `kill()` 并清理

## 开源协议

MIT License
