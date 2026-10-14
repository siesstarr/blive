const http = require('http')
const https = require('https')

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'
const REFERER = 'https://live.bilibili.com/'

/** 正在播放的直播流，key 为 room_id */
const streams = {}

/** 本地 HTTP 代理服务器：把 Bilibili 的 FLV 流转发给渲染进程，附带 CORS 头绕过浏览器限制 */
let proxyServer = null
let proxyReady = null

function now() {
  return new Date().toISOString()
}

/** 记录一条日志到对应房间的缓冲区，并同步输出到主进程控制台 */
function log(roomId, message) {
  const line = `[${now()}] ${message}`
  const entry = streams[roomId]
  if (entry) entry.log.push(line)
  console.log(`[blive][room ${roomId}] ${message}`)
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': '*',
  }
}

/** 确保本地代理服务器已启动，返回监听端口 */
function ensureProxy() {
  if (proxyServer) return Promise.resolve(proxyServer.address().port)
  if (proxyReady) return proxyReady
  proxyReady = new Promise((resolve, reject) => {
    proxyServer = http.createServer(handleProxy)
    proxyServer.on('error', (err) => {
      console.error('[blive] proxy server error:', err)
      reject(err)
    })
    proxyServer.listen(0, '127.0.0.1', () => {
      const port = proxyServer.address().port
      console.log(`[blive] stream proxy listening on http://127.0.0.1:${port}`)
      resolve(port)
    })
  })
  return proxyReady
}

/** 跟随重定向拉取直播流，返回可 destroy 的句柄 */
function fetchStream(url, roomId, onResponse, onError, redirects = 3) {
  let req = null
  const headers = { 'User-Agent': UA, 'Referer': REFERER, 'Accept': '*/*' }
  const attempt = (target) => {
    req = https.get(target, { headers }, (res) => {
      const code = res.statusCode || 0
      const location = res.headers.location
      if (code >= 300 && code < 400 && location) {
        log(roomId, `上游重定向 ${code} -> ${location}`)
        res.resume()
        if (redirects <= 0) {
          onError(new Error('重定向次数过多'))
          return
        }
        try {
          attempt(new URL(location, target).toString())
        } catch (err) {
          onError(err)
        }
        return
      }
      onResponse(res)
    })
    req.on('error', onError)
  }
  attempt(url)
  return { destroy: () => { try { req.destroy() } catch {} } }
}

function handleProxy(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders())
    res.end()
    return
  }

  const match = /^\/stream\/(\d+)\/?$/.exec(req.url || '')
  if (!match) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }

  const roomId = Number(match[1])
  const entry = streams[roomId]
  if (!entry || !entry.url) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('no active stream for room ' + roomId)
    return
  }

  // 若已有旧连接（如重连），先中止旧的上游请求
  if (entry.upstream) {
    log(roomId, '客户端重连，中止旧上游连接')
    entry.upstream.destroy()
    entry.upstream = null
  }

  log(roomId, `客户端连接，开始代理 ${entry.url}`)
  res.writeHead(200, { ...corsHeaders(), 'Content-Type': 'video/x-flv', 'Cache-Control': 'no-store' })

  let byteCount = 0
  const handle = fetchStream(
    entry.url,
    roomId,
    (upRes) => {
      const code = upRes.statusCode || 0
      if (code !== 200) {
        log(roomId, `上游返回 ${code}，结束连接`)
        res.end()
        return
      }
      log(roomId, `上游响应 ${code} ${upRes.headers['content-type'] || ''}`)
      upRes.on('data', (chunk) => {
        byteCount += chunk.length
        if (byteCount % (1024 * 1024) < chunk.length) {
          log(roomId, `已转发 ${(byteCount / 1024 / 1024).toFixed(1)} MB`)
        }
        res.write(chunk)
      })
      upRes.on('end', () => {
        log(roomId, '上游流结束')
        res.end()
      })
      upRes.on('error', (err) => {
        log(roomId, `上游读取错误: ${err.message}`)
        res.destroy(err)
      })
    },
    (err) => {
      log(roomId, `上游连接失败: ${err.message}`)
      res.destroy(err)
    },
  )
  entry.upstream = handle

  req.on('close', () => {
    if (entry.upstream === handle) {
      log(roomId, '客户端断开，中止上游连接')
      entry.upstream = null
      handle.destroy()
    }
  })
}

// 通过 window 对象向渲染进程注入 nodejs 能力
window.services = {
  /** 请求 Bilibili 直播间 API，绕过浏览器的 sec-fetch 检测 */
  fetchRoomInfo(ids) {
    const params = new URLSearchParams()
    ids.forEach((id) => params.append('room_ids', String(id)))
    params.append('req_biz', 'web_room_componet')
    const url = `https://api.live.bilibili.com/xlive/web-room/v1/index/getRoomBaseInfo?${params.toString()}`

    return new Promise((resolve, reject) => {
      https.get(url, {
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'User-Agent': UA,
        },
      }, (res) => {
        let body = ''
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: res.headers,
            body,
          })
        })
      }).on('error', (err) => {
        reject(err)
      })
    })
  },

  /** 解析直播流地址并在本地代理服务器上注册，返回可供 mpegts.js 播放的 URL */
  getStreamUrl(roomId) {
    return new Promise((resolve) => {
      const prev = streams[roomId]
      const entry = prev || { url: null, upstream: null, log: [] }
      streams[roomId] = entry

      const api = `https://api.live.bilibili.com/room/v1/Room/playUrl?cid=${roomId}&platform=web&qn=10000`
      log(roomId, `解析直播流: ${api}`)
      https.get(api, { headers: { 'User-Agent': UA, 'Referer': REFERER, 'Accept': '*/*' } }, (res) => {
        let body = ''
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => {
          try {
            log(roomId, `直播流 API 返回 ${res.statusCode}`)
            const json = JSON.parse(body)
            if (json.code !== 0) {
              const msg = json.message || ('code ' + json.code)
              log(roomId, `直播流 API 错误: ${msg}`)
              resolve({ ok: false, error: `获取直播流失败: ${msg}` })
              return
            }
            const durl = json.data && json.data.durl
            if (!durl || !durl.length || !durl[0].url) {
              log(roomId, '直播流 API 未返回可用地址（可能未开播）')
              resolve({ ok: false, error: '直播流为空（可能未开播或不可用）' })
              return
            }
            entry.url = durl[0].url
            log(roomId, `解析到 FLV 流: ${entry.url}`)
            ensureProxy().then((port) => {
              const proxyUrl = `http://127.0.0.1:${port}/stream/${roomId}`
              log(roomId, `代理地址就绪: ${proxyUrl}`)
              resolve({ ok: true, url: proxyUrl, flv: entry.url })
            }).catch((err) => {
              log(roomId, `本地代理启动失败: ${err.message}`)
              resolve({ ok: false, error: `本地代理启动失败: ${err.message}` })
            })
          } catch (err) {
            log(roomId, `解析直播流响应失败: ${err.message}`)
            resolve({ ok: false, error: `解析直播流响应失败: ${err.message}` })
          }
        })
      }).on('error', (err) => {
        log(roomId, `直播流 API 请求失败: ${err.message}`)
        resolve({ ok: false, error: `获取直播流失败: ${err.message}` })
      })
    })
  },

  /** 停止播放并中止对应的上游连接 */
  stopStream(roomId) {
    const entry = streams[roomId]
    if (!entry) return { action: 'stop', roomId, skipped: true, reason: '未在播放' }
    if (entry.upstream) {
      log(roomId, '停止播放，中止上游连接')
      try { entry.upstream.destroy() } catch {}
      entry.upstream = null
    }
    const lines = entry.log.slice()
    delete streams[roomId]
    return { action: 'stop', roomId, stopped: true, log: lines }
  },

  /** 获取某个房间的流日志（用于错误排查） */
  getStreamLog(roomId) {
    const entry = streams[roomId]
    return { lines: entry ? entry.log.slice() : [] }
  },
}
