/** Profile shapes shared by the host schema and the client settings editor. */

export type PermissionPolicy = 'ask' | 'allow' | 'read-only' | 'reject'

export type SystemPromptMode = 'drop' | 'forward'

export interface AcpModelProfile {
  id: string
  name?: string
  description?: string
  contextWindow?: number
}

export interface AcpAgentProfile {
  displayName?: string
  command: string
  args: string[]
  env: Record<string, string>
  cwd?: string
  authMethod?: string
  models: AcpModelProfile[]
  discoverModels: boolean
  permission: PermissionPolicy
  systemPrompt: SystemPromptMode
  showToolCalls: boolean
  contextWindow: number
  startupTimeoutMs: number
  idleTimeoutMs: number
}
