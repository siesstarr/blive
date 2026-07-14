const https = require('https')
const { exec, spawn } = require('child_process')

/** 正在运行的 mpv 进程，key 为 room_id */
const mpvProcesses = {}

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
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
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

  /** 使用 mpv 播放直播流 */
  startMpv(roomId) {
    if (mpvProcesses[roomId]) return { action: 'start', roomId, skipped: true, reason: '已在播放' }
    const url = `https://live.bilibili.com/${roomId}`
    const args = ['--no-video', url]
    try {
      const env = { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH || ''}` }
      const entry = { proc: null, stdout: '', stderr: '' }
      const proc = spawn('/opt/homebrew/bin/mpv', args, { env, stdio: 'pipe' })
      entry.proc = proc
      proc.stdin.end()
      proc.stdout.on('data', (chunk) => { entry.stdout += chunk.toString() })
      proc.stderr.on('data', (chunk) => { entry.stderr += chunk.toString() })
      proc.on('exit', (code) => {
        // 只在 entry 没被 stopMpv 清理时才更新
        if (mpvProcesses[roomId] === entry) {
          entry.code = code
        }
      })
      proc.on('error', (err) => {
        if (mpvProcesses[roomId] === entry) {
          entry.error = err.message
        }
      })
      mpvProcesses[roomId] = entry
      return { action: 'start', roomId, command: ['mpv', ...args], pid: proc.pid }
    } catch (err) {
      return { action: 'start', roomId, command: ['mpv', '--no-video', url], error: err.message }
    }
  },

  /** 获取 mpv 的所有输出 */
  getMpvOutput(roomId) {
    const entry = mpvProcesses[roomId]
    return entry ? { stdout: entry.stdout || '', stderr: entry.stderr || '' } : { stdout: '', stderr: '' }
  },

  /** 测试子进程是否可用 */
  testExec() {
    return new Promise((resolve) => {
      exec('echo hello && which mpv', { timeout: 5000 }, (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: stdout?.trim(), stderr: stderr?.trim(), error: err?.message })
      })
    })
  },

  /** 停止 mpv 播放 */
  stopMpv(roomId) {
    const entry = mpvProcesses[roomId]
    if (!entry) return { action: 'stop', roomId, skipped: true, reason: '未在播放' }
    delete mpvProcesses[roomId]  // 先删，防止 exit 事件误判
    try { entry.proc.kill('SIGTERM') } catch {}
    // 延迟强制杀，确保进程终止
    setTimeout(() => { try { entry.proc.kill('SIGKILL') } catch {} }, 500)
    return { action: 'stop', roomId, killed: true, pid: entry.proc.pid, stdout: entry.stdout, stderr: entry.stderr }
  },
}
