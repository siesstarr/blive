/// <reference types="vite/client" />
/// <reference types="@ztools-center/ztools-api-types" />

interface FetchResult {
  status: number
  statusText: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

interface GetStreamUrlResult {
  ok: boolean
  url?: string
  flv?: string
  error?: string
}

interface StopStreamResult {
  action: string
  roomId?: number
  skipped?: boolean
  stopped?: boolean
  reason?: string
  log?: string[]
}

interface StreamLog {
  lines: string[]
}

// Preload services 类型声明（对应 public/preload/services.js）
interface Services {
  fetchRoomInfo(ids: number[]): Promise<FetchResult>
  getStreamUrl(roomId: number): Promise<GetStreamUrlResult>
  stopStream(roomId: number): StopStreamResult
  getStreamLog(roomId: number): StreamLog
}

interface Window {
  services: Services
}
