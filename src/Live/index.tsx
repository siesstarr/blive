import { useCallback, useEffect, useRef, useState } from 'react'
import './index.css'
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { arrayMove, rectSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

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

/* ── Sortable wrapper around .live-card ── */

function SortableCard({ id, children }: { id: number; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }

  return (
    <div ref={setNodeRef} className="live-card" style={style} {...attributes} {...listeners}>
      {children}
    </div>
  )
}

/* ── Card inner content (shared between grid & DragOverlay) ── */

interface CardInnerProps {
  id: number
  info: RoomInfo | undefined
  playing: boolean
  onToggleMpv: (id: number) => void
  onRemove: (id: number) => void
  onRetry: (ids: number[]) => void
}

function CardInner({ id, info, playing, onToggleMpv, onRemove, onRetry }: CardInnerProps) {
  if (!info) {
    return (
      <div className="live-card-error">
        <span>获取数据失败</span>
        <div className="live-card-error-actions">
          <button onClick={() => onRetry([id])}>重试</button>
          <button onClick={() => onRemove(id)}>移除</button>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="live-card-cover-wrap" onClick={() => onToggleMpv(id)}>
        <img className="live-card-cover" src={info.cover} alt={info.title} referrerPolicy="no-referrer" draggable={false} />
        {info.live_status === 1 && (
          <div className="live-card-overlay">
            <span className="live-card-play-icon">{playing ? '⏹' : '▶'}</span>
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
          <button
            className="live-card-del"
            onClick={(e) => {
              e.stopPropagation()
              onRemove(id)
            }}
            title="删除"
          >
            ×
          </button>
        </div>
      </div>
    </>
  )
}

/* ── Main component ── */

export default function Live() {
  const [roomIds, setRoomIds] = useState<number[]>(loadIds)
  const [roomsData, setRoomsData] = useState<Record<number, RoomInfo>>({})
  const [inputValue, setInputValue] = useState('')
  const [pollInterval, setPollInterval] = useState(loadInterval)
  const [error, setError] = useState('')
  const [debugInfo, setDebugInfo] = useState<DebugInfo | null>(null)
  const [playing, setPlaying] = useState<Record<number, boolean>>({})
  const [showDebug, setShowDebug] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined)

  /* ── dnd-kit ── */

  const [activeId, setActiveId] = useState<number | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  )

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id as number)
  }, [])

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveId(null)
    const { active, over } = event
    if (over && active.id !== over.id) {
      setRoomIds((prev) => {
        const oldIdx = prev.indexOf(active.id as number)
        const newIdx = prev.indexOf(over.id as number)
        if (oldIdx === -1 || newIdx === -1) return prev
        const next = arrayMove(prev, oldIdx, newIdx)
        saveIds(next)
        return next
      })
    }
  }, [])

  const isDragging = activeId !== null

  /* ── data fetching ── */

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

  const handleMpvToggle = useCallback(
    (id: number) => {
      const info = roomsData[id]
      if (!info || info.live_status !== 1) return
      const isPlaying = playing[id]
      if (isPlaying) window.services.stopMpv(id)
      else window.services.startMpv(id)
      setPlaying((prev) => ({ ...prev, [id]: !isPlaying }))
    },
    [roomsData, playing],
  )

  /* ── auto-sort: bubble live rooms to front on poll updates ── */

  useEffect(() => {
    if (isDragging) return
    setRoomIds((prev) => {
      const live: number[] = []
      const offline: number[] = []
      prev.forEach((id) => {
        ;(roomsData[id]?.live_status === 1 ? live : offline).push(id)
      })
      const next = [...live, ...offline]
      if (next.length !== prev.length) return prev
      if (next.every((id, i) => id === prev[i])) return prev
      saveIds(next)
      return next
    })
  }, [roomsData, isDragging])

  /* ── polling ── */

  useEffect(() => {
    if (roomIds.length) fetchRooms(roomIds)
    timerRef.current = setInterval(() => {
      const ids = loadIds()
      if (ids.length) fetchRooms(ids)
    }, pollInterval * 60 * 1000)
    return () => clearInterval(timerRef.current)
  }, [roomIds, pollInterval, fetchRooms])

  /* ── render ── */

  const activeInfo = activeId ? roomsData[activeId] : undefined

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

      {/* 调试开关 — 仅 dev 环境可见 */}
      {import.meta.env.DEV && (
        <label className="live-debug-toggle">
          <input type="checkbox" checked={showDebug} onChange={(e) => setShowDebug(e.target.checked)} />
          <span>调试</span>
        </label>
      )}

      {/* 调试面板 */}
      {showDebug && debugInfo && (
        <details className="live-debug" open>
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

      {/* 房间信息卡片 */}
      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <SortableContext items={roomIds} strategy={rectSortingStrategy}>
          <div className={`live-cards${isDragging ? ' is-dragging' : ''}`}>
            {roomIds.map((id) => (
              <SortableCard key={id} id={id}>
                <CardInner
                  id={id}
                  info={roomsData[id]}
                  playing={!!playing[id]}
                  onToggleMpv={handleMpvToggle}
                  onRemove={handleRemove}
                  onRetry={fetchRooms}
                />
              </SortableCard>
            ))}
          </div>
        </SortableContext>

        <DragOverlay dropAnimation={null}>
          {activeId && activeInfo ? (
            <div className="live-card live-card-drag-overlay">
              <CardInner
                id={activeId}
                info={activeInfo}
                playing={!!playing[activeId]}
                onToggleMpv={handleMpvToggle}
                onRemove={handleRemove}
                onRetry={fetchRooms}
              />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  )
}
