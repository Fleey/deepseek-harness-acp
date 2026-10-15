import type { ContentBlock as AcpContentBlock } from '@agentclientprotocol/sdk'
import type { ContentBlock, GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import { fileHandleText, offloadedImageText, requestImageHandleText, textOnlyImageText } from '@deepseek-ai/dsh-llm'

type ImageAttachmentRef = Extract<ContentBlock, { type: 'image' }>['attachment']

/** One image prepared for the agent: base64 request bytes plus the size its handle text names. */
export interface PromptImage {
  data: string
  mimeType: string
  width: number
  height: number
}

/**
 * Image bytes for the turn being sent. Building a prompt records every image it would
 * send in `wanted`; the caller reads those and builds again with them in `read`.
 */
export interface PromptImages {
  read: ReadonlyMap<string, PromptImage>
  wanted: Map<string, ImageAttachmentRef>
}

type Conversation = GenerateOptions['messages']

const CONTINUE_PROMPT = 'Continue.'

function blockText(block: ContentBlock): string | undefined {
  switch (block.type) {
    case 'text':
      return block.text
    case 'image':
      return block.offloaded === true ? offloadedImageText(block.attachment) : textOnlyImageText(block.attachment)
    case 'file':
      return fileHandleText(block.attachment, undefined)
    case 'tool-call':
      return `[tool call ${block.name} ${block.arguments}]`
    default:
      return undefined
  }
}

function messageText(message: RequestMessage): string {
  return message.content.map(blockText).filter((text): text is string => text !== undefined && text.length > 0).join('\n')
}

function toAcpBlocks(messages: readonly RequestMessage[], images?: PromptImages): AcpContentBlock[] {
  const blocks: AcpContentBlock[] = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'image' && images !== undefined && block.offloaded !== true) {
        const id = String(block.attachment.attachmentId)
        const image = images.read.get(id)
        if (image !== undefined) {
          blocks.push({ type: 'text', text: requestImageHandleText(block.attachment, image) })
          blocks.push({ type: 'image', data: image.data, mimeType: image.mimeType })
          continue
        }
        images.wanted.set(id, block.attachment)
      }
      const text = blockText(block)
      if (text !== undefined && text.length > 0)
        blocks.push({ type: 'text', text })
    }
  }
  return blocks.length > 0 ? blocks : [{ type: 'text', text: CONTINUE_PROMPT }]
}

const ROLE_LABEL: Record<string, string> = {
  user: 'User',
  assistant: 'Assistant',
  tool: 'Tool result',
}

export function systemText(options: GenerateOptions): string {
  const parts = options.messages.filter(message => message.role === 'system').map(messageText)
  if (options.system !== undefined)
    parts.unshift(options.system)
  return parts.filter(part => part.length > 0).join('\n\n')
}

export function conversationOf(options: GenerateOptions): Conversation {
  return options.messages.filter(message => message.role !== 'system')
}

export function consumedIds(conversation: Conversation): string[] {
  return conversation.flatMap(message => message.id === undefined ? [] : [message.id])
}

export function incrementalPrompt(conversation: Conversation, consumed: readonly string[], route: string, images?: PromptImages): AcpContentBlock[] | undefined {
  if (consumed.length > conversation.length)
    return undefined
  for (const [index, id] of consumed.entries()) {
    if (conversation[index]?.id !== id)
      return undefined
  }
  const fresh: RequestMessage[] = []
  for (const message of conversation.slice(consumed.length)) {
    if (message.role === 'assistant') {
      if (message.source.provider === route && fresh.length === 0)
        continue
      return undefined
    }
    if (message.role === 'tool')
      return undefined
    if (message.role === 'user')
      fresh.push(message)
  }
  return toAcpBlocks(fresh, images)
}

export function fullPrompt(conversation: Conversation, system: string | undefined, images?: PromptImages): AcpContentBlock[] {
  let split = conversation.length
  while (split > 0 && conversation[split - 1]?.role === 'user')
    split--
  const history = conversation.slice(0, split)
  const current = conversation.slice(split)
  const preface: string[] = []
  if (system !== undefined && system.length > 0)
    preface.push(`<system_instructions>\n${system}\n</system_instructions>`)
  const lines = history
    .filter(message => message.role in ROLE_LABEL)
    .map(message => [message, messageText(message)] as const)
    .filter(([, text]) => text.length > 0)
    .map(([message, text]) => `${ROLE_LABEL[message.role]}: ${text}`)
  if (lines.length > 0)
    preface.push(`<conversation_history>\n${lines.join('\n\n')}\n</conversation_history>`)
  const blocks = toAcpBlocks(current, images)
  return preface.length === 0 ? blocks : [{ type: 'text', text: preface.join('\n\n') }, ...blocks]
}
