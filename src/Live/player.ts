import mpegts from 'mpegts.js'

export interface LogLine {
  time: string
  level: 'info' | 'error'
  text: string
}

/** 连续多久没有播放进度就判定为断流（毫秒） */
const STALL_TIMEOUT_MS = 10_000
/** 起播阶段的宽限时间，避免缓冲较慢时误判为断流 */
const STARTUP_GRACE_MS = 20_000
const WATCHDOG_INTERVAL_MS = 2_000

/** 断流后最多自动重连几次 */
const MAX_RECONNECT_ATTEMPTS = 5
const RECONNECT_DELAY_MS = 2_000
/** 稳定播放超过这个时长后重置重连计数 */
const STABLE_PLAY_MS = 30_000

/** 起播前先攒够这么多秒的缓冲，抵消上游数据抖动 */
const STARTUP_BUFFER_SECONDS = 4
const STARTUP_BUFFER_TIMEOUT_MS = 20_000

/** 播放状态：正在播放 / 断流后重连中 */
export type PlayStatus = 'playing' | 'reconnecting'

interface Session {
  roomId: number
  onLog: (line: LogLine) => void
  onFatal: (message: string) => void
  onStatus: (status: PlayStatus) => void
  /** 用户主动停止或已放弃重连 */
  stopped: boolean
  player: mpegts.Player | null
  audio: HTMLAudioElement | null
  watchdog: ReturnType<typeof setInterval> | null
  /** 每 5s 输出一次播放状态快照，便于事后排查 */
  statsTimer: ReturnType<typeof setInterval> | null
  lastStats: any
  reconnectTimer: ReturnType<typeof setTimeout> | null
  /** 连续重连次数，稳定播放后归零 */
  attempts: number
  lastTime: number
  lastBufferedEnd: number
  lastProgressAt: number
  everProgressed: boolean
  startedAt: number
}

const sessions = new Map<number, Session>()

/* ── 把 mpegts 内部的告警/错误也收进播放日志 ── */

const mpegtsLogCounts = new Map<string, number>()

function handleMpegtsLog(type: string, str: string) {
  if (type !== 'warn' && type !== 'error') return

  // mpegts 的日志不带房间号，归到最近开始播放的那个会话
  let target: Session | null = null
  sessions.forEach((s) => {
    if (s.stopped || !s.audio) return
    if (!target || s.startedAt > target.startedAt) target = s
  })
  if (!target) return

  // 同一类告警可能刷屏，前 3 条全记，之后每 25 条记一次
  const key = `${type}:${str}`
  const count = (mpegtsLogCounts.get(key) || 0) + 1
  mpegtsLogCounts.set(key, count)
  if (count > 3 && count % 25 !== 0) return

  log(target, type === 'error' ? 'error' : 'info', `[mpegts] ${str}${count > 1 ? ` (x${count})` : ''}`)
}

try {
  mpegts.LoggingControl.addLogListener(handleMpegtsLog)
} catch {}

function line(level: LogLine['level'], text: string): LogLine {
  return { time: new Date().toLocaleTimeString(), level, text }
}

function log(session: Session, level: LogLine['level'], text: string) {
  session.onLog(line(level, text))
}

/** 当前缓冲领先播放头多少秒 */
function bufferedAhead(audio: HTMLAudioElement): number {
  if (!audio.buffered.length) return 0
  return audio.buffered.end(audio.buffered.length - 1) - audio.currentTime
}

/** 等缓冲攒到 STARTUP_BUFFER_SECONDS 再开播；超时就直接播，避免一直等 */
async function waitForStartupBuffer(audio: HTMLAudioElement, isCurrent: () => boolean): Promise<void> {
  const deadline = Date.now() + STARTUP_BUFFER_TIMEOUT_MS
  while (isCurrent() && Date.now() < deadline) {
    if (bufferedAhead(audio) >= STARTUP_BUFFER_SECONDS) return
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** 把 buffered TimeRanges 格式化成 "0.0-15.2,16.0-30.4" */
function formatBuffered(audio: HTMLAudioElement): string {
  const parts: string[] = []
  for (let i = 0; i < audio.buffered.length; i++) {
    parts.push(`${audio.buffered.start(i).toFixed(1)}-${audio.buffered.end(i).toFixed(1)}`)
  }
  return parts.length ? parts.join(',') : '空'
}

/** 一行播放状态快照，用于定位断流发生在哪一步 */
function snapshot(session: Session): string {
  const audio = session.audio
  const sinceProgress = ((Date.now() - session.lastProgressAt) / 1000).toFixed(1)
  if (!audio) return `无音频元素 sinceProgress=${sinceProgress}s`

  const bufferedEnd = audio.buffered.length ? audio.buffered.end(audio.buffered.length - 1) : 0
  const stats = session.lastStats
  const parts = [
    `t=${audio.currentTime.toFixed(2)}s`,
    `buffered=${formatBuffered(audio)}`,
    `latency=${Math.max(0, bufferedEnd - audio.currentTime).toFixed(1)}s`,
    `paused=${audio.paused}`,
    `readyState=${audio.readyState}`,
    `networkState=${audio.networkState}`,
    `sinceProgress=${sinceProgress}s`,
  ]
  if (stats) parts.push(`speed=${stats.speed ?? '?'}KB/s`)
  if (audio.error) parts.push(`mediaError=${audio.error.code}`)
  return parts.join(' ')
}

/* ── 会话生命周期 ── */

/** 释放当前播放器与音频元素，但保留 session（用于重连） */
function teardown(session: Session) {
  if (session.watchdog) {
    clearInterval(session.watchdog)
    session.watchdog = null
  }
  if (session.statsTimer) {
    clearInterval(session.statsTimer)
    session.statsTimer = null
  }
  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer)
    session.reconnectTimer = null
  }

  const { player, audio } = session
  session.player = null
  session.audio = null
  session.lastStats = null

  if (player) {
    try { player.unload() } catch {}
    try { player.detachMediaElement() } catch {}
    try { player.destroy() } catch {}
  }
  if (audio) {
    try { audio.pause() } catch {}
    try { audio.removeAttribute('src') } catch {}
    try { audio.load() } catch {}
    try { audio.remove() } catch {}
  }

  window.services.stopStream(session.roomId)
}

/** 彻底结束会话 */
function stopSession(session: Session) {
  session.stopped = true
  teardown(session)
  sessions.delete(session.roomId)
}

/* ── 断流检测与重连 ── */

function stopWatchdog(session: Session) {
  if (session.watchdog) {
    clearInterval(session.watchdog)
    session.watchdog = null
  }
}

function stopStatsLogger(session: Session) {
  if (session.statsTimer) {
    clearInterval(session.statsTimer)
    session.statsTimer = null
  }
}

/** 每 5s 打一条状态快照，断流后回看日志能看出是从哪一刻开始不动的 */
function startStatsLogger(session: Session) {
  stopStatsLogger(session)
  session.statsTimer = setInterval(() => {
    if (session.stopped || !session.audio) return
    log(session, 'info', `状态 ${snapshot(session)}`)
  }, 5_000)
}

/**
 * 监控播放进度。直播流断流时 mpegts.js 往往不会抛 ERROR 事件，
 * 音频只是悄悄停下，所以这里用 currentTime / 缓冲末尾是否推进来兜底。
 */
function startWatchdog(session: Session) {
  stopWatchdog(session)

  session.lastTime = session.audio?.currentTime ?? 0
  session.lastBufferedEnd = 0
  session.lastProgressAt = Date.now()
  session.everProgressed = false

  session.watchdog = setInterval(() => {
    if (session.stopped) return
    const audio = session.audio
    if (!audio) return

    const bufferedEnd = audio.buffered.length ? audio.buffered.end(audio.buffered.length - 1) : 0
    const progressed = audio.currentTime > session.lastTime || bufferedEnd > session.lastBufferedEnd

    if (progressed) {
      session.lastTime = audio.currentTime
      session.lastBufferedEnd = bufferedEnd
      session.lastProgressAt = Date.now()
      session.everProgressed = true
      if (session.attempts > 0 && Date.now() - session.startedAt > STABLE_PLAY_MS) {
        session.attempts = 0
      }
      return
    }

    const timeout = session.everProgressed ? STALL_TIMEOUT_MS : STARTUP_GRACE_MS
    if (Date.now() - session.lastProgressAt > timeout) {
      recover(session, '没有新的音频数据（疑似断流）')
    }
  }, WATCHDOG_INTERVAL_MS)
}

/** 断流后重连；超过次数上限才通知上层失败 */
function recover(session: Session, reason: string) {
  if (session.stopped) return

  log(session, 'error', `${reason}｜${snapshot(session)}`)

  teardown(session)
  session.attempts += 1

  if (session.attempts > MAX_RECONNECT_ATTEMPTS) {
    log(session, 'error', `已重连 ${MAX_RECONNECT_ATTEMPTS} 次仍失败，放弃`)
    session.stopped = true
    sessions.delete(session.roomId)
    session.onFatal(`${reason}（已重连 ${MAX_RECONNECT_ATTEMPTS} 次仍失败）`)
    return
  }

  log(session, 'error', `${RECONNECT_DELAY_MS / 1000}s 后重连（第 ${session.attempts}/${MAX_RECONNECT_ATTEMPTS} 次）`)
  session.onStatus('reconnecting')
  session.reconnectTimer = setTimeout(() => {
    session.reconnectTimer = null
    connect(session).catch((err) => recover(session, (err as Error).message))
  }, RECONNECT_DELAY_MS)
}

/* ── 建立播放 ── */

async function connect(session: Session): Promise<void> {
  if (session.stopped) return

  const { roomId } = session
  // 每次都重新解析地址：直播流 URL 会过期，不能复用旧地址
  const res = await window.services.getStreamUrl(roomId)
  if (session.stopped) return

  if (!res.ok) {
    const msg = res.error || '获取直播流失败'
    if (session.attempts === 0 && !session.everProgressed) {
      // 首次播放在这里失败，直接抛给调用方，由 UI 展示
      throw new Error(msg)
    }
    recover(session, msg)
    return
  }

  log(session, 'info', `解析成功，流地址: ${res.flv}`)
  log(session, 'info', `本地代理: ${res.url}`)

  const audio = document.createElement('audio')
  audio.setAttribute('playsinline', '')
  audio.style.display = 'none'
  document.body.appendChild(audio)

  const player = mpegts.createPlayer(
    { type: 'flv', isLive: true, hasAudio: true, hasVideo: false, url: res.url! },
    {
      // 音频解码在主线程完成，避免 file:// 协议下 blob Worker 受限
      isLive: true,
      enableWorker: false,
      enableStashBuffer: true,
      lazyLoad: false,
      // 长时间直播时回收 SourceBuffer 里的旧数据，避免堆积卡死
      autoCleanupSourceBuffer: true,
      autoCleanupMaxBackwardDuration: 30,
      autoCleanupMinBackwardDuration: 15,
      // 音频时间戳出现大跳变时，默认会生成大量静音帧补位，
      // 结果是「缓冲在涨、时间在走、但完全没声音」。这里关掉补位，
      // 并开启追帧：落后直播太多时直接跳到最新的位置。
      fixAudioTimestampGap: false,
      liveBufferLatencyChasing: true,
      // 阈值要高于起播缓冲，否则会把自己攒的缓冲削掉，反而更卡
      liveBufferLatencyMaxLatency: 8,
      liveBufferLatencyMinRemain: 4,
    },
  )

  session.player = player
  session.audio = audio

  // 旧播放器（重连前那一代）的事件一律忽略
  const isCurrent = () => !session.stopped && session.player === player

  player.on(mpegts.Events.ERROR, (type: string, detail: string) => {
    if (!isCurrent()) return
    recover(session, `播放器错误 ${type} ${detail}`)
  })
  player.on(mpegts.Events.LOADING_COMPLETE, () => {
    if (!isCurrent()) return
    recover(session, '直播流已结束')
  })
  player.on(mpegts.Events.MEDIA_INFO, (info: any) => {
    if (!isCurrent()) return
    log(
      session,
      'info',
      `媒体信息: ${info.audioCodec || '未知'} ${info.audioSampleRate || '?'}Hz ` +
        `${info.audioChannelCount || '?'}ch rate=${info.audioDataRate || '?'} mime=${info.mimeType || '?'}`,
    )
  })
  player.on(mpegts.Events.STATISTICS_INFO, (info: any) => {
    if (!isCurrent()) return
    session.lastStats = info
  })

  audio.addEventListener('waiting', () => {
    if (!isCurrent()) return
    log(session, 'info', `音频缓冲中 (waiting) ${snapshot(session)}`)
  })
  audio.addEventListener('stalled', () => {
    if (!isCurrent()) return
    log(session, 'info', `音频数据停滞 (stalled) ${snapshot(session)}`)
  })

  audio.addEventListener('error', () => {
    if (!isCurrent()) return
    recover(session, `音频元素错误 (code ${audio.error ? audio.error.code : '未知'})`)
  })
  audio.addEventListener('ended', () => {
    if (!isCurrent()) return
    recover(session, '音频播放结束')
  })

  player.attachMediaElement(audio)
  player.load()

  // 直播数据基本按实时速度到达，先攒几秒缓冲再开播，避免一起播就卡
  await waitForStartupBuffer(audio, isCurrent)
  if (!isCurrent()) return
  log(session, 'info', `起播缓冲: ${bufferedAhead(audio).toFixed(1)}s`)

  try {
    await player.play()
    if (!isCurrent()) return
    session.startedAt = Date.now()
    log(session, 'info', '播放已启动')
    session.onStatus('playing')
    startWatchdog(session)
    startStatsLogger(session)
  } catch (err) {
    if (!isCurrent()) return
    log(session, 'error', `play() 调用失败: ${(err as Error).message}`)
    recover(session, `play() 调用失败: ${(err as Error).message}`)
  }
}

/* ── 对外接口 ── */

/** 启动某个房间的音频播放（mpegts.js + 本地流代理） */
export async function startPlay(
  roomId: number,
  onLog: (line: LogLine) => void,
  onFatal: (message: string) => void,
  onStatus: (status: PlayStatus) => void = () => {},
): Promise<void> {
  const prev = sessions.get(roomId)
  if (prev) stopSession(prev)

  const session: Session = {
    roomId,
    onLog,
    onFatal,
    onStatus,
    stopped: false,
    player: null,
    audio: null,
    watchdog: null,
    statsTimer: null,
    lastStats: null,
    reconnectTimer: null,
    attempts: 0,
    lastTime: 0,
    lastBufferedEnd: 0,
    lastProgressAt: Date.now(),
    everProgressed: false,
    startedAt: Date.now(),
  }
  sessions.set(roomId, session)

  // 记录运行环境，便于对照排查（MSE / 直播播放能力）
  try {
    const f = mpegts.getFeatureList()
    log(session, 'info', `环境: mseLive=${f.mseLivePlayback} mseH265=${f.mseH265Playback} loader=${f.networkLoaderName}`)
  } catch {}

  try {
    await connect(session)
  } catch (err) {
    stopSession(session)
    throw err
  }
}

/** 停止某个房间的音频播放并释放资源 */
export function stopPlay(roomId: number): void {
  const session = sessions.get(roomId)
  if (!session) {
    window.services.stopStream(roomId)
    return
  }
  stopSession(session)
}

/** 停止所有正在播放的音频（组件卸载时调用） */
export function stopAll(): void {
  Array.from(sessions.keys()).forEach((id) => stopPlay(id))
}
