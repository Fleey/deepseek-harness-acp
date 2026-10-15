import type { ContentBlock as AcpContentBlock, PromptResponse, Usage } from '@agentclientprotocol/sdk'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ModelModality,
  ReasoningEffortId,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AcpAgentProfile } from '../../shared/types.ts'
import type { AdapterHost } from '../types/index.ts'
import type { AcpAdvertisedModel, AcpSession } from './acp-agent.ts'
import type { PromptImage, PromptImages } from './transcript.ts'
import type { PermissionTurn } from './permission.ts'
import { homedir } from 'node:os'
import { LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PLUGIN_ID } from '../../shared/constants.ts'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MODEL_ID } from '../config/constants.ts'
import { AcpAgentProcess, applyConfigOptions } from './acp-agent.ts'
import { ChunkTranslator, usageDelta } from './chunk-translator.ts'
import { decidePermission } from './permission.ts'
import { consumedIds, conversationOf, fullPrompt, incrementalPrompt, systemText } from './transcript.ts'

interface Binding {
  session: AcpSession
  cwd: string
  model: string
  consumed: string[]
  usage: Usage | undefined
}

const TEXT_ONLY: readonly ModelModality[] = ['text']

const TEXT_AND_IMAGE: readonly ModelModality[] = ['text', 'image']

type Outcome =
  | { kind: 'response', response: PromptResponse }
  | { kind: 'error', error: unknown }
  | { kind: 'aborted' }
  | { kind: 'timeout' }

const NO_RETRY = { mode: 'normal', maxRetries: 0 } as const

const CANCEL_GRACE_MS = 5_000

function spawnFacts(profile: AcpAgentProfile): string {
  return JSON.stringify([profile.command, profile.args, profile.env, profile.cwd ?? null, profile.authMethod ?? null])
}

function contextKey(route: string, model: string): string {
  return `${route}\u0000${model}`
}

function failure(code: string, message: string): { code: string, message: string } {
  return { code, message }
}

function failureOf(error: unknown): { code: string, message: string } {
  const known = typeof error === 'object' && error !== null ? Reflect.get(error, 'failure') as { code?: unknown, message?: unknown } | undefined : undefined
  if (typeof known?.code === 'string' && typeof known.message === 'string')
    return failure(known.code, known.message)
  return failure('TRANSPORT', error instanceof Error ? error.message : String(error))
}

export class AcpAdapter extends LlmAdapter {
  private readonly agents = new Map<string, { process: AcpAgentProcess, facts: string }>()
  private readonly bindings = new Map<string, Binding>()
  private readonly turns = new Map<string, PermissionTurn>()
  /** Context window sizes agents reported through `usage_update`, keyed by route and model. */
  private readonly contextSizes = new Map<string, number>()
  private readonly retryPolicy: ResolvedRetryPolicy = resolveRetryPolicy(NO_RETRY, `${PLUGIN_ID}: retryPolicy`)

  constructor(
    private readonly host: AdapterHost,
    private readonly profiles: () => ReadonlyMap<string, AcpAgentProfile>,
  ) {
    super()
  }

  sync(): void {
    const profiles = this.profiles()
    for (const [route, entry] of this.agents) {
      const profile = profiles.get(route)
      if (profile !== undefined && spawnFacts(profile) === entry.facts)
        continue
      entry.process.dispose()
      this.agents.delete(route)
      this.dropBindings(route)
    }
  }

  dispose(): void {
    for (const entry of this.agents.values())
      entry.process.dispose()
    this.agents.clear()
    this.bindings.clear()
    this.turns.clear()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.profiles().get(provider)?.displayName ?? provider }
  }

  override providerRetryPolicy(): ResolvedRetryPolicy {
    return this.retryPolicy
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const profile = this.profiles().get(provider)
    if (profile === undefined)
      return []
    const fallback = (): LlmModelInfo => ({ provider, id: DEFAULT_MODEL_ID, name: `${profile.displayName ?? provider} (default)`, inputModalities: this.modalities(provider) })
    if (profile.models.length > 0) {
      return profile.models.map(model => ({
        provider,
        id: model.id,
        name: model.name ?? model.id,
        ...model.description === undefined ? {} : { description: model.description },
        inputModalities: this.modalities(provider),
      }))
    }
    if (!profile.discoverModels)
      return [fallback()]
    try {
      const found = await this.advertisedModels(provider)
      if (found.length === 0)
        return [fallback()]
      return [fallback(), ...found.map(model => ({
        provider,
        id: model.id,
        name: model.name,
        ...model.description === undefined ? {} : { description: model.description },
        inputModalities: this.modalities(provider),
      }))]
    }
    catch (error) {
      this.host.logger.warn(`${PLUGIN_ID}: model discovery for ACP agent "${provider}" failed`, error)
      return [fallback()]
    }
  }

  /**
   * Ask the agent behind one configured route which models it advertises, regardless of
   * the profile's declared `models` and `discoverModels` switch. Settings surfaces use this
   * to offer the agent's own list for adoption.
   */
  async advertisedModels(provider: string, signal?: AbortSignal): Promise<readonly AcpAdvertisedModel[]> {
    const profile = this.profiles().get(provider)
    if (profile === undefined)
      throw new LlmError(`${PLUGIN_ID}: no ACP agent is configured for provider "${provider}"`, 'PROVIDER_NOT_FOUND')
    return this.agent(provider, profile).discoverModels(profile.cwd ?? homedir(), signal)
  }

  /**
   * Exact-model metadata. Capabilities come from the agent itself, so an agent nobody has
   * started yet is probed once (when `discoverModels` allows it): image input from its
   * `promptCapabilities`, reasoning efforts from its `thought_level` option, and the
   * context window it last reported through `usage_update`.
   */
  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const profile = this.profiles().get(provider)
    if (profile?.discoverModels === true && this.agents.get(provider)?.process.advertisedModels === undefined) {
      await this.advertisedModels(provider, signal).catch((error: unknown) => {
        this.host.logger.warn(`${PLUGIN_ID}: probing ACP agent "${provider}" for model metadata failed`, error)
      })
    }
    const process = this.agents.get(provider)?.process
    const configured = profile?.models.find(entry => entry.id === model)
    const advertised = process?.advertisedModels?.find(entry => entry.id === model)
    const efforts = process?.advertisedEfforts
    return {
      provider,
      id: model,
      name: configured?.name ?? advertised?.name ?? model,
      inputModalities: this.modalities(provider),
      context: { contextWindow: configured?.contextWindow ?? this.contextSizes.get(contextKey(provider, model)) ?? profile?.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
      ...efforts === undefined
        ? {}
        : {
            reasoning: {
              efforts: efforts.available.map(level => ({
                id: level.id as ReasoningEffortId,
                name: level.name,
                ...level.description === undefined ? {} : { description: level.description },
              })),
              // The level a fresh session starts with. Without it the picker adds its own
              // "Default" entry, which duplicates agents that already offer one.
              ...efforts.available.some(level => level.id === efforts.initial) ? { defaultEffort: efforts.initial as ReasoningEffortId } : {},
            },
          },
    }
  }

  /** Image input is offered only when the agent accepts images and dsh can read attachments. */
  private modalities(provider: string): readonly ModelModality[] {
    return this.agents.get(provider)?.process.supportsImages === true && this.host.readImage !== undefined ? TEXT_AND_IMAGE : TEXT_ONLY
  }

  /** Read every image the prompt wants, as base64 request versions; unreadable ones stay text. */
  private async readImages(wanted: PromptImages['wanted'], signal: AbortSignal | undefined): Promise<Map<string, PromptImage>> {
    const read = new Map<string, PromptImage>()
    const readImage = this.host.readImage
    if (readImage === undefined)
      return read
    await Promise.all([...wanted].map(async ([id, ref]) => {
      try {
        const image = await readImage(ref, signal)
        read.set(id, { data: Buffer.from(image.data).toString('base64'), mimeType: image.mediaType, width: image.width, height: image.height })
      }
      catch (error) {
        this.host.logger.warn(`${PLUGIN_ID}: could not read image attachment ${id}; sending its text handle instead`, error)
      }
    }))
    return read
  }

  override async* stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    let finished = false
    try {
      for await (const chunk of this.run(options)) {
        finished ||= chunk.type === 'finish'
        yield chunk
      }
    }
    catch (error) {
      if (finished)
        throw error
      yield { type: 'finish', reason: options.signal?.aborted ? { kind: 'aborted', failure: failure('ABORTED', 'request aborted') } : { kind: 'error', failure: failureOf(error) } }
    }
  }

  private async* run(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const route = options.provider
    const profile = this.profiles().get(route)
    if (profile === undefined)
      throw new LlmError(`${PLUGIN_ID}: no ACP agent is configured for provider "${route}"`, 'PROVIDER_NOT_FOUND')
    const signal = options.signal
    if (signal?.aborted) {
      yield { type: 'finish', reason: { kind: 'aborted', failure: failure('ABORTED', 'request aborted before start') } }
      return
    }
    const agent = this.agent(route, profile)
    const purpose = Reflect.get(options, 'purpose') as string | undefined
    const dshSessionId = options.sessionId as string | undefined
    const ephemeral = dshSessionId === undefined || purpose !== undefined
    const key = `${route}\u0000${dshSessionId ?? ''}`
    const cwd = this.cwdOf(dshSessionId, profile)
    const conversation = conversationOf(options)
    const system = profile.systemPrompt === 'forward' ? systemText(options) : undefined

    const effort = options.reasoningEffort as string | undefined
    let images: PromptImages = { read: new Map(), wanted: new Map() }
    let binding = ephemeral ? undefined : this.bindings.get(key)
    let reused = binding !== undefined && binding.session.generation === agent.generation && binding.cwd === cwd && binding.model === options.model
    const consumedBefore = reused ? binding!.consumed : []
    let prompt = reused ? incrementalPrompt(conversation, consumedBefore, route, images) : undefined
    if (prompt === undefined || binding === undefined) {
      reused = false
      if (binding !== undefined)
        agent.closeSession(binding.session)
      const session = await agent.newSession(cwd, signal)
      await agent.selectModel(session, options.model, signal)
      binding = { session, cwd, model: options.model, consumed: [], usage: undefined }
      images = { read: new Map(), wanted: new Map() }
      prompt = fullPrompt(conversation, system, images)
    }
    const wantedEffort = effort ?? binding.session.efforts?.initial
    if (wantedEffort !== undefined)
      await agent.selectEffort(binding.session, wantedEffort, signal)
    if (images.wanted.size > 0 && agent.supportsImages) {
      images = { read: await this.readImages(images.wanted, signal), wanted: new Map() }
      prompt = reused ? incrementalPrompt(conversation, consumedBefore, route, images) ?? prompt : fullPrompt(conversation, system, images)
    }
    if (!ephemeral)
      this.bindings.set(key, binding)
    binding.consumed = consumedIds(conversation)

    const session = binding.session
    const translator = new ChunkTranslator(profile.showToolCalls)
    const queue: StreamChunk[] = []
    let outcome: Outcome | undefined
    let wake: (() => void) | undefined
    const notify = (): void => {
      wake?.()
      wake = undefined
    }
    const settle = (next: Outcome): void => {
      outcome ??= next
      notify()
    }

    let idleTimer: NodeJS.Timeout | undefined
    const armIdle = (): void => {
      if (profile.idleTimeoutMs <= 0)
        return
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        agent.cancel(session)
        settle({ kind: 'timeout' })
      }, profile.idleTimeoutMs)
    }
    let cancelTimer: NodeJS.Timeout | undefined
    const onAbort = (): void => {
      agent.cancel(session)
      cancelTimer = setTimeout(() => settle({ kind: 'aborted' }), CANCEL_GRACE_MS)
    }

    this.turns.set(session.sessionId, { dshSessionId, signal })
    signal?.addEventListener('abort', onAbort, { once: true })
    armIdle()
    const sizeKey = contextKey(route, binding.model)
    agent.prompt(session, prompt, (update) => {
      armIdle()
      if (update.sessionUpdate === 'usage_update' && update.size > 0)
        this.contextSizes.set(sizeKey, update.size)
      else if (update.sessionUpdate === 'config_option_update')
        applyConfigOptions(session, update.configOptions)
      queue.push(...translator.push(update))
      notify()
    }).then(
      response => settle({ kind: 'response', response }),
      error => settle({ kind: 'error', error }),
    )

    try {
      while (true) {
        while (queue.length > 0)
          yield queue.shift()!
        if (outcome !== undefined)
          break
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
      yield* translator.close()
      yield* this.finish(outcome, translator, binding, ephemeral, signal)
    }
    finally {
      clearTimeout(idleTimer)
      clearTimeout(cancelTimer)
      signal?.removeEventListener('abort', onAbort)
      this.turns.delete(session.sessionId)
      if (outcome === undefined)
        agent.cancel(session)
      if (ephemeral)
        agent.closeSession(session)
    }
  }

  private* finish(outcome: Outcome, translator: ChunkTranslator, binding: Binding, ephemeral: boolean, signal: AbortSignal | undefined): Iterable<StreamChunk> {
    if (outcome.kind === 'error') {
      if (signal?.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: failure('ABORTED', 'request aborted') } }
        return
      }
      throw outcome.error
    }
    if (outcome.kind === 'timeout') {
      yield { type: 'finish', reason: { kind: 'error', failure: failure('TIMEOUT', `ACP agent was idle for longer than the configured idleTimeoutMs`) } }
      return
    }
    if (outcome.kind === 'aborted') {
      yield { type: 'finish', reason: { kind: 'aborted', failure: failure('ABORTED', 'request aborted') } }
      return
    }
    const { response } = outcome
    if (response.usage != null) {
      yield { type: 'usage', usage: usageDelta(response.usage, ephemeral ? undefined : binding.usage) }
      binding.usage = response.usage
    }
    switch (response.stopReason) {
      case 'end_turn':
        yield translator.emittedBlocks === 0
          ? { type: 'finish', reason: { kind: 'error', failure: failure('EMPTY_RESPONSE', 'ACP agent ended the turn without any content') } }
          : { type: 'finish', reason: { kind: 'stop' } }
        return
      case 'max_tokens':
        yield { type: 'finish', reason: { kind: 'max-tokens' } }
        return
      case 'cancelled':
        yield { type: 'finish', reason: { kind: 'aborted', failure: failure('ABORTED', 'ACP agent cancelled the turn') } }
        return
      case 'refusal':
        yield { type: 'finish', reason: { kind: 'error', failure: failure('REFUSAL', 'ACP agent refused the request') } }
        return
      default:
        yield { type: 'finish', reason: { kind: 'error', failure: failure('MAX_TURN_REQUESTS', `ACP agent stopped: ${response.stopReason}`) } }
    }
  }

  private agent(route: string, profile: AcpAgentProfile): AcpAgentProcess {
    const existing = this.agents.get(route)
    if (existing !== undefined)
      return existing.process
    const process = new AcpAgentProcess({
      route,
      profile: () => this.profiles().get(route) ?? profile,
      logger: this.host.logger,
      onPermission: (sessionId, request) => decidePermission(
        this.host,
        route,
        (this.profiles().get(route) ?? profile).permission,
        this.turns.get(sessionId),
        request,
      ),
    })
    this.agents.set(route, { process, facts: spawnFacts(profile) })
    return process
  }

  private cwdOf(dshSessionId: string | undefined, profile: AcpAgentProfile): string {
    const sessionCwd = dshSessionId === undefined ? undefined : this.host.agentOf(dshSessionId)?.session.header.cwd
    return sessionCwd ?? profile.cwd ?? homedir()
  }

  private dropBindings(route: string): void {
    for (const key of this.bindings.keys()) {
      if (key.startsWith(`${route}\u0000`))
        this.bindings.delete(key)
    }
  }
}
