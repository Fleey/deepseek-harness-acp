export interface HostLogger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export interface HostAgent {
  readonly session: { readonly header: { readonly cwd?: string } }
}

export interface ApprovalRequest {
  agent: HostAgent
  toolName: string
  reason?: string
  signal?: AbortSignal
}

/** One image attachment re-encoded for a model request. */
export interface HostImage {
  data: Uint8Array
  mediaType: string
  width: number
  height: number
}

export interface AdapterHost {
  logger: HostLogger
  agentOf: (sessionId: string) => HostAgent | undefined
  approve: ((request: ApprovalRequest) => Promise<ApprovalOutcome>) | undefined
  /** Request-sized bytes of one image attachment; absent when no attachment store is mounted. */
  readImage: ((ref: unknown, signal?: AbortSignal) => Promise<HostImage>) | undefined
}
