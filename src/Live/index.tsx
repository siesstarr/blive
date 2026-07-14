import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './index.css'

const ROOM_IDS_KEY = 'blive-room-ids'
const INTERVAL_KEY = 'blive-poll-interval'

interface RoomInfo {
  room_id: number
  uid: number
  area_id: number
  live_status: number
  live_url: string
  parent_area_id: number
  title: string
  parent_area_name: string
  area_name: string
  live_time: string
  description: string
  tags: string
  attention: number
  online: number
  short_id: number
  uname: string
  cover: string
  background: string
  join_slide: number
  live_id: number
  live_id_str: string
  lock_status: number
  hidden_status: number
  is_encrypted: boolean
}

interface ApiResponse {
  code: number
  message: string
  data: {
    by_uids: Record<string, RoomInfo>
    by_room_ids: Record<string, RoomInfo>
  }
}

interface DebugInfo {
  status: number
  statusText: string
  responseHeaders: Record<string, string>
  body: string
}

function loadIds(): number[] {
  try {
    const raw = localStorage.getItem(ROOM_IDS_KEY)
    return raw ? (JSON.parse(raw) as number[]) : []
  } catch {
    return []
  }
}

function saveIds(ids: number[]) {
  localStorage.setItem(ROOM_IDS_KEY, JSON.stringify(ids))
}

function loadInterval(): number {
  try {
    const raw = localStorage.getItem(INTERVAL_KEY)
    const v = raw ? parseInt(raw, 10) : 0
    return [1, 5, 10, 30].includes(v) ? v : 1
  } catch {
    return 1
  }
}

async function fetchApi(ids: number[]): Promise<{ json: ApiResponse; debug: DebugInfo }> {
  const result = await window.services.fetchRoomInfo(ids)
  const responseHeaders: Record<string, string> = {}
  for (const [k, v] of Object.entries(result.headers)) {
    responseHeaders[k] = String(v ?? '')
  }
  const debug: DebugInfo = { status: result.status, statusText: result.statusText, responseHeaders, body: result.body }
  if (result.status !== 200) {
    throw Object.assign(new Error(`HTTP ${result.status} ${result.statusText}`), { debug })
  }
  if (!result.body) {
    throw Object.assign(new Error('响应为空'), { debug })
  }
  const json = JSON.parse(result.body) as ApiResponse
  return { json, debug }
}

export default function Live() {
  const [roomIds, setRoomIds] = useState<number[]>(loadIds)
  const [roomsData, setRoomsData] = useState<Record<number, RoomInfo>>({})
  const [inputValue, setInputValue] = useState('')
  const [pollInterval, setPollInterval] = useState(loadInterval)
  const [error, setError] = useState('')
  const [debugInfo, setDebugInfo] = useState<DebugInfo | null>(null)
  const [mpvLog, setMpvLog] = useState<MpvResult[]>([])
  const [playing, setPlaying] = useState<Record<number, boolean>>({})
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined)

  const sortedIds = useMemo(() => (
    [...roomIds].sort((a, b) => {
      const sa = roomsData[a]?.live_status ?? -1
      const sb = roomsData[b]?.live_status ?? -1
      return sb - sa
    })
  ), [roomIds, roomsData])

  const fetchRooms = useCallback(async (ids: number[]) => {
    if (!ids.length) {
      setRoomsData({})
      return
    }
    try {
      const { json } = await fetchApi(ids)
      if (json.code === 0) {
        setRoomsData(json.data.by_room_ids)
        setError('')
      } else {
        setError(json.message || '请求失败')
      }
    } catch (e: any) {
      setDebugInfo(e.debug || null)
      setError(e.message || '网络错误')
    }
  }, [])

  const handleAdd = useCallback(async () => {
    const trimmed = inputValue.trim()
    if (!trimmed) return

    const newId = Number(trimmed)
    if (!Number.isInteger(newId) || newId <= 0) {
      setError('请输入有效的 room_id')
      return
    }
    if (roomIds.includes(newId)) {
      setError('该 room_id 已存在')
      return
    }

    setError('')
    setDebugInfo(null)
    try {
      const { json, debug } = await fetchApi([newId])
      setDebugInfo(debug)
      if (json.code === 0) {
        const next = [...roomIds, newId]
        saveIds(next)
        setRoomIds(next)
        setInputValue('')
        setRoomsData((prev) => ({ ...prev, ...json.data.by_room_ids }))
      } else {
        setError(json.message || 'room_id 无效')
      }
    } catch (e: any) {
      setDebugInfo(e.debug || null)
      setError(e.message || '网络错误')
    }
  }, [inputValue, roomIds])

  const handleRemove = useCallback(
    (id: number) => {
      const next = roomIds.filter((v) => v !== id)
      saveIds(next)
      setRoomIds(next)
      setRoomsData((prev) => {
        const copy = { ...prev }
        delete copy[id]
        return copy
      })
    },
    [roomIds],
  )

  // 轮询 mpv 输出
  useEffect(() => {
    const timer = setInterval(() => {
      const activeIds = Object.entries(playing).filter(([, v]) => v).map(([k]) => Number(k))
      if (!activeIds.length) return
      setMpvLog((prev) => {
        const next = [...prev]
        activeIds.forEach((id) => {
          const out = window.services.getMpvOutput(id)
          if (out.stdout || out.stderr) {
            next.unshift({ action: 'output', roomId: id, stdout: out.stdout, stderr: out.stderr })
          }
        })
        return next.slice(0, 20)
      })
    }, 3000)
    return () => clearInterval(timer)
  }, [playing])

  // 轮询直播间数据
  useEffect(() => {
    if (roomIds.length) fetchRooms(roomIds)
    timerRef.current = setInterval(() => {
      const ids = loadIds()
      if (ids.length) fetchRooms(ids)
    }, pollInterval * 60 * 1000)
    return () => clearInterval(timerRef.current)
  }, [roomIds, pollInterval, fetchRooms])

  return (
    <div className="live">
      {/* 添加区域 */}
      <div className="live-add">
        <input
          className="live-input"
          type="text"
          placeholder="输入 room_id"
          value={inputValue}
          onChange={(e) => {
            setInputValue(e.target.value)
            setError('')
          }}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
        />
        <button className="live-btn" onClick={handleAdd} disabled={!inputValue.trim()}>
          添加
        </button>
      </div>

      {/* 轮询间隔设置 */}
      <div className="live-interval">
        <span className="live-interval-label">数据刷新</span>
        <div className="live-interval-control">
          <select
            className="live-interval-select"
            value={pollInterval}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10)
              localStorage.setItem(INTERVAL_KEY, String(v))
              setPollInterval(v)
            }}
          >
            <option value={1}>1 分钟</option>
            <option value={5}>5 分钟</option>
            <option value={10}>10 分钟</option>
            <option value={30}>30 分钟</option>
          </select>
          <span className="live-interval-current">每 {pollInterval} 分钟自动刷新</span>
        </div>
      </div>

      {error && <div className="live-error">{error}</div>}

      {/* 调试面板 */}
      {debugInfo && (
        <details className="live-debug">
          <summary className="live-debug-summary">请求详情</summary>
          <div className="live-debug-section">
            <div className="live-debug-label">
              Response — {debugInfo.status} {debugInfo.statusText}
            </div>
            <pre className="live-debug-pre">{JSON.stringify(debugInfo.responseHeaders, null, 2)}</pre>
          </div>
          <div className="live-debug-section">
            <div className="live-debug-label">Body</div>
            <pre className="live-debug-pre">{debugInfo.body || '(空)'}</pre>
          </div>
        </details>
      )}

      {/* mpv 请求日志 */}
      {mpvLog.length > 0 && (
        <details className="live-debug">
          <summary className="live-debug-summary">mpv 请求日志 ({mpvLog.length})</summary>
          {mpvLog.map((entry, i) => (
            <div key={i} className="live-debug-section">
              <pre className="live-debug-pre">{JSON.stringify(entry, null, 2)}</pre>
            </div>
          ))}
        </details>
      )}

      {/* 房间信息卡片 */}
      <div className="live-cards">
        {sortedIds.map((id) => {
          const info = roomsData[id]
          return (
            <div key={id} className="live-card">
              {info ? (
                <>
                  <div
                    className="live-card-cover-wrap"
                    onClick={() => {
                      if (info.live_status !== 1) return
                      const isPlaying = playing[id]
                      const result = isPlaying
                        ? window.services.stopMpv(id)
                        : window.services.startMpv(id)
                      setMpvLog((prev) => [result, ...prev].slice(0, 20))
                      setPlaying((prev) => ({ ...prev, [id]: !isPlaying }))
                    }}
                  >
                    <img className="live-card-cover" src={info.cover} alt={info.title} referrerPolicy="no-referrer" />
                    {info.live_status === 1 && (
                      <div className="live-card-overlay">
                        <span className="live-card-play-icon">{playing[id] ? '⏹' : '▶'}</span>
                      </div>
                    )}
                    {info.live_status === 1 && (
                      <span className="live-card-viewer">{info.online.toLocaleString()}</span>
                    )}
                    <span className={`live-card-status${info.live_status === 1 ? ' is-live' : ''}`}>
                      {info.live_status === 1 ? '直播中' : '未开播'}
                    </span>
                  </div>
                  <div className="live-card-body">
                    <div className="live-card-title" title={info.title}>
                      {info.title}
                    </div>
                    <div className="live-card-footer">
                      <div className="live-card-meta">
                        <span className="live-card-uname">{info.uname}</span>
                        {info.live_status === 1 && (
                          <span className="live-card-area">{info.area_name}</span>
                        )}
                      </div>
                      <button className="live-card-del" onClick={() => handleRemove(id)} title="删除">
                        ×
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="live-card-error">
                  <span>获取数据失败</span>
                  <div className="live-card-error-actions">
                    <button onClick={() => fetchRooms([id])}>重试</button>
                    <button onClick={() => handleRemove(id)}>移除</button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
