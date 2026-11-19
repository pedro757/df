// Builds what "Bring back" hands to the main session: the sidechat's own conversation, after the messages the fork
// copied from the main session.

export interface MessageLike {
  readonly id: string
  readonly type: string
  readonly text?: string
  readonly command?: string
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>
  readonly snapshot?: { readonly files?: ReadonlyArray<string> }
}

/** Messages after `base`, oldest first. `newestFirst` is a page of messages in descending order. */
export function ownMessages<Message extends { readonly id: string }>(
  newestFirst: readonly Message[],
  base: string | undefined,
): { readonly messages: Message[]; readonly reachedBase: boolean } {
  const result: Message[] = []
  for (const message of newestFirst) {
    if (base && message.id === base) return { messages: result.reverse(), reachedBase: true }
    result.push(message)
  }
  return { messages: result.reverse(), reachedBase: !base }
}

interface Block {
  readonly role: "user" | "assistant" | "shell"
  readonly text: string
}

function blocksOf(messages: readonly MessageLike[], perMessage: number): { blocks: Block[]; files: string[] } {
  const blocks: Block[] = []
  const files = new Set<string>()
  const cut = (text: string) => (text.length <= perMessage ? text : `${text.slice(0, perMessage).trimEnd()}\n…`)
  for (const message of messages) {
    if (message.type === "user" && message.text?.trim()) blocks.push({ role: "user", text: cut(message.text.trim()) })
    if (message.type === "shell" && message.command?.trim())
      blocks.push({ role: "shell", text: cut(`$ ${message.command.trim()}`) })
    if (message.type === "assistant") {
      const text = (message.content ?? [])
        .filter((part) => part.type === "text" && part.text?.trim())
        .map((part) => part.text!.trim())
        .join("\n\n")
      if (text) {
        // Consecutive assistant messages are one reply split by tool calls.
        const last = blocks.at(-1)
        if (last?.role === "assistant")
          blocks[blocks.length - 1] = { role: "assistant", text: cut(`${last.text}\n\n${text}`) }
        else blocks.push({ role: "assistant", text: cut(text) })
      }
      for (const file of message.snapshot?.files ?? []) files.add(file)
    }
  }
  return { blocks, files: [...files].sort() }
}

function escapeAttribute(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
}

export interface BringBack {
  /** What the main session's model receives. */
  readonly text: string
  /** How many user and assistant turns it carries. */
  readonly turns: number
  readonly omitted: number
  readonly files: readonly string[]
}

/** The sidechat's conversation for the main session, or undefined when it has nothing to bring back yet. */
export function bringBackText(input: {
  readonly title: string
  readonly messages: readonly MessageLike[]
  readonly maxChars?: number
  readonly perMessage?: number
}): BringBack | undefined {
  const maxChars = input.maxChars ?? 30_000
  const { blocks, files } = blocksOf(input.messages, input.perMessage ?? 8_000)
  if (!blocks.some((block) => block.role === "assistant")) return
  const render = (block: Block) => `<${block.role}>\n${block.text}\n</${block.role}>`
  // Keep the newest turns when the conversation is too long.
  const kept: string[] = []
  let size = 0
  for (const block of [...blocks].reverse()) {
    const rendered = render(block)
    if (kept.length > 0 && size + rendered.length > maxChars) break
    kept.unshift(rendered)
    size += rendered.length + 1
  }
  const omitted = blocks.length - kept.length
  const lines = [
    "The user brought back a sidechat. A sidechat is a side conversation forked from this session: it ran on its own, and none of it was part of this conversation until now. Use what was learned there. Changes it made to files are already on disk.",
    "",
    `<sidechat title="${escapeAttribute(input.title)}">`,
    ...(omitted > 0 ? [`(${omitted} earlier message${omitted === 1 ? "" : "s"} omitted)`] : []),
    ...kept,
    "</sidechat>",
  ]
  if (files.length > 0) lines.push("", `Files the sidechat changed: ${files.join(", ")}`)
  return { text: lines.join("\n"), turns: kept.length, omitted, files }
}
