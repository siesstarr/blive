# blive

> Bilibili 直播间监控 + 内置音频播放，ZTools 插件

基于 **React 19 + Vite 6 + TypeScript** 构建。

## 功能

### 直播间监控

- 添加多个 Bilibili 直播间 room_id，API 验证后保存
- 卡片式展示直播间封面、标题、主播名、分区、在线人数
- 直播状态标签（直播中 / 未开播），B 站粉色风格
- 可配置的轮询间隔（1 / 5 / 10 / 30 分钟）
- 数据持久化到 localStorage，重启不丢失

### 音频播放

- 鼠标移至**开播中**的卡片封面，显示播放遮罩
- 点击 ▶ 通过 `mpegts.js` 解码直播流音频（仅音频，不渲染视频）
- 再次点击 ⏹ 停止播放
- 每个房间独立播放状态，互不干扰
- 播放出错时展示详细日志，便于排查

## 环境依赖

无外部系统依赖。音频播放由 npm 包 `mpegts.js` 在渲染进程内完成，无需安装 `mpv`、`yt-dlp` 等命令行工具。

## 项目结构

```
.
├── public/
│   ├── logo.png              # 插件图标
│   ├── plugin.json           # 插件配置（功能注册、指令定义）
│   └── preload/
│       ├── package.json      # Preload 模块类型
│       └── services.js       # Node.js 能力：API 请求、流地址解析、本地流代理
├── src/
│   ├── main.tsx              # React 入口
│   ├── main.css              # 全局样式（暗色模式支持）
│   ├── App.tsx               # 根组件（路由分发）
│   ├── env.d.ts              # TypeScript 类型声明
│   └── Live/
│       ├── index.tsx         # 直播间列表 + 监控 + 播放控制
│       ├── index.css         # 卡片布局、遮罩动画
│       └── player.ts         # mpegts.js 音频播放封装
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
- **图片防盗链**：`index.html` 设置了 `<meta name="referrer" content="no-referrer">`，解决 Bilibili CDN 图片的 Referer 校验
- **API 403**：Bilibili API 会检测请求头判断是否为脚本请求，插件通过 preload 层的 Node.js `https` 模块绕过浏览器的 `sec-fetch` 检测
- **直播流 Referer 校验**：直播流的 CDN 会校验 `Referer`，插件在 preload 层通过本地 HTTP 代理转发流并附带正确的 `Referer` 头，同时解决跨域问题
- **仅支持 macOS**：`plugin.json` 中 `platform` 限定为 `darwin`
- **Bilibili API**：使用 `getRoomBaseInfo` 接口，支持一次请求查询多个房间，无需 WBI 签名

## 技术要点

### 为什么用 preload 发 API 请求？

浏览器渲染进程的 `fetch()` 会自动添加 `sec-fetch-mode: cors` 头，Bilibili CDN 据此拦截非浏览器导航请求返回 403。通过 preload 层 Node.js 的 `https` 模块发请求可以完全控制请求头，模拟浏览器行为。

### 音频播放（mpegts.js + 本地流代理）

- `getStreamUrl` 调用 `playUrl` 接口解析出 FLV 直播流地址
- 在 preload 层启动本地 HTTP 代理服务器（`127.0.0.1` 随机端口），把 FLV 流转发给渲染进程，并附带 `Referer: https://live.bilibili.com/` 与 CORS 头
- 渲染进程用 `mpegts.js` 解封装 FLV 并仅解码音频（`hasVideo: false`），通过隐藏的 `<audio>` 元素 + Media Source Extensions 播放
- 停止播放时中止上游连接并释放播放器与音频元素

## 开源协议

MIT License
