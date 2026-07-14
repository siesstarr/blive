/// <reference types="vite/client" />
/// <reference types="@ztools-center/ztools-api-types" />

interface FetchResult {
  status: number
  statusText: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

interface MpvOutput {
  stdout: string
  stderr: string
}

interface MpvResult {
  action: string
  roomId?: number
  command?: string | string[]
  pid?: number
  killed?: boolean
  skipped?: boolean
  reason?: string
  error?: string
  stdout?: string
  stderr?: string
  ok?: boolean
}

// Preload services 类型声明（对应 public/preload/services.js）
interface TestExecResult {
  ok: boolean
  stdout: string
  stderr: string
  error?: string
}

interface Services {
  fetchRoomInfo(ids: number[]): Promise<FetchResult>
  startMpv(roomId: number): MpvResult
  stopMpv(roomId: number): MpvResult
  getMpvOutput(roomId: number): MpvOutput
  testExec(): Promise<TestExecResult>
}

interface Window {
  services: Services
}
