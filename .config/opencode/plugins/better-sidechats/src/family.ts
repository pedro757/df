// What the Subagents tab lists. The family tree, agent and title follow OpenCode 2.3.0's own Subagents tab
// (packages/tui/src/routes/session/composer/subagents-tab.tsx and util/session.ts); the model column is new.

export interface ModelRef {
  readonly id: string
  readonly providerID: string
  readonly variant?: string
}

export interface FamilySession {
  readonly id: string
  readonly parentID?: string
  readonly title?: string
  readonly agent?: string
  readonly model?: ModelRef
  readonly time: { readonly created: number }
}

/** Every descendant of `sessionID`'s root, depth first, with the tree prefix OpenCode draws (`├─ `, `└─ `). */
export function sessionFamily<T extends FamilySession>(sessions: readonly T[], sessionID: string) {
  const byID = new Map(sessions.map((session) => [session.id, session]))
  const current = byID.get(sessionID)
  if (!current) return []
  const children = new Map<string, T[]>()
  for (const session of sessions) {
    if (!session.parentID) continue
    const group = children.get(session.parentID)
    if (group) group.push(session)
    else children.set(session.parentID, [session])
  }
  const seen = new Set<string>()
  const root = (session: T): T => {
    if (seen.has(session.id)) return session
    seen.add(session.id)
    const parent = session.parentID ? byID.get(session.parentID) : undefined
    return parent ? root(parent) : session
  }
  const listed = new Set<string>()
  const walk = (parentID: string, ancestors: boolean[]): Array<{ session: T; prefix: string }> => {
    listed.add(parentID)
    const group = (children.get(parentID) ?? []).filter((session) => !listed.has(session.id))
    return group.flatMap((session, index) => {
      const last = index === group.length - 1
      const prefix =
        ancestors.length === 0
          ? ""
          : ancestors
              .slice(1)
              .map((ancestor) => (ancestor ? "   " : "│  "))
              .join("") + (last ? "└─ " : "├─ ")
      return [{ session, prefix }, ...walk(session.id, [...ancestors, last])]
    })
  }
  return walk(root(current).id, [])
}

const titlecase = (value: string) => value.replace(/\b\w/g, (letter) => letter.toUpperCase())

/** The row's `Agent: title`, as OpenCode words it. */
export function rowLabel(session: FamilySession): { readonly agent: string; readonly title: string } {
  const title =
    session.title ?? `${session.parentID ? "Child" : "New"} session - ${new Date(session.time.created).toISOString()}`
  const match = title.match(/@(\w+) subagent/)
  return {
    agent: session.agent ? titlecase(session.agent) : match ? titlecase(match[1]!) : "Subagent",
    title: match ? title.replace(match[0], "").trim() || title : title,
  }
}

/**
 * The model a subagent runs on: its session's selection (OpenCode sets it when it starts the subagent, and on every
 * switch), else its newest reply's model, else its agent's configured model.
 */
export function modelOf(
  session: FamilySession,
  replies: () => readonly { readonly type: string; readonly model?: ModelRef }[] | undefined,
  agents: () => readonly { readonly id: string; readonly model?: ModelRef }[] | undefined,
): ModelRef | undefined {
  // Read lazily: in a Solid computation, reading a session's messages reruns it on every streamed token.
  if (session.model) return session.model
  const reply = replies()?.findLast((message) => message.type === "assistant" && message.model)
  if (reply?.model) return reply.model
  return agents()?.find((agent) => agent.id === session.agent)?.model
}

/** The model's display name and the variant, if one is selected. OpenCode records no variant as `default`. */
export function modelText(
  ref: ModelRef,
  models: readonly { readonly id: string; readonly providerID: string; readonly name: string }[] | undefined,
): { readonly model: string; readonly variant?: string } {
  const name = models?.find((model) => model.providerID === ref.providerID && model.id === ref.id)?.name ?? ref.id
  return ref.variant && ref.variant !== "default" ? { model: name, variant: ref.variant } : { model: name }
}
