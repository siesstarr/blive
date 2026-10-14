import mpegts from 'mpegts.js'

export interface LogLine {
  time: string
  level: 'info' | 'error'
  text: string
}

interface PlayerEntry {
  player: mpegts.Player
  audio: HTMLAudioElement
  onLog: (line: LogLine) => void
  onFatal: (message: string) => void
  closed: boolean
}

const entries = new Map<number, PlayerEntry>()

function line(level: LogLine['level'], text: string): LogLine {
  return { time: new Date().toLocaleTimeString(), level, text }
}

/** 启动某个房间的音频播放（mpegts.js + 本地流代理） */
export async function startPlay(
  roomId: number,
  onLog: (line: LogLine) => void,
  onFatal: (message: string) => void,
): Promise<void> {
  const res = await window.services.getStreamUrl(roomId)
  if (!res.ok) {
    const msg = res.error || '获取直播流失败'
    onLog(line('error', msg))
    throw new Error(msg)
  }
  onLog(line('info', `解析成功，流地址: ${res.flv}`))
  onLog(line('info', `本地代理: ${res.url}`))

  const audio = document.createElement('audio')
  audio.setAttribute('playsinline', '')
  audio.style.display = 'none'
  document.body.appendChild(audio)

  const player = mpegts.createPlayer(
    { type: 'flv', isLive: true, hasAudio: true, hasVideo: false, url: res.url! },
    // 音频解码在主线程完成，避免 file:// 协议下 blob Worker 受限
    { isLive: true, enableWorker: false, enableStashBuffer: true, lazyLoad: false },
  )

  const entry: PlayerEntry = { player, audio, onLog, onFatal, closed: false }
  entries.set(roomId, entry)

  player.on(mpegts.Events.ERROR, (type: string, detail: string) => {
    if (entry.closed) return
    const msg = `播放器错误 ${type} ${detail}`
    entry.onLog(line('error', msg))
    entry.onFatal(msg)
  })
  player.on(mpegts.Events.MEDIA_INFO, (info: any) => {
    if (entry.closed) return
    entry.onLog(line('info', `媒体信息: 音频编码 ${info.audioCodec || '未知'}`))
  })

  player.attachMediaElement(audio)
  player.load()

  try {
    await player.play()
    entry.onLog(line('info', '播放已启动'))
  } catch (err) {
    entry.onLog(line('error', `play() 调用失败: ${(err as Error).message}`))
  }
}

/** 停止某个房间的音频播放并释放资源 */
export function stopPlay(roomId: number): void {
  const entry = entries.get(roomId)
  if (!entry) {
    window.services.stopStream(roomId)
    return
  }
  entry.closed = true
  try { entry.player.unload() } catch {}
  try { entry.player.detachMediaElement() } catch {}
  try { entry.audio.remove() } catch {}
  entries.delete(roomId)
  window.services.stopStream(roomId)
}

/** 停止所有正在播放的音频（组件卸载时调用） */
export function stopAll(): void {
  Array.from(entries.keys()).forEach((id) => stopPlay(id))
}
