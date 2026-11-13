import path from "node:path"
import type { LocationPublicInfo, LocationRef, SessionInfo } from "@opencode/client"
import { usePlugin } from "@opencode/plugin/tui"
import type { KeymapCommand } from "@opencode/plugin/tui/context"
import { TextAttributes } from "@opentui/core"
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
} from "solid-js"
import { readCliConfig, readHostAllProjects, type Options } from "./config"
import type { Inbox } from "./inbox"
import {
  compareActive,
  compareSnoozed,
  compareUpdated,
  dayCategory,
  place,
  TAB_LABEL,
  TABS,
  wakeCategory,
  type Placement,
  type Signals,
  type Tab,
} from "./model"
import { KeybindingsHelp, type HelpGroup } from "./help"
import { Select, typedCharacter, type SelectAction, type SelectOption } from "./select"
import { formatWake, pickSnoozePreset, resolveCustomSnooze, resolveSnoozePresets, snoozeTimeLeft } from "./snooze"
import { DIALOG_LIST_INSET, Prompt, statusGutter, useDialogTheme } from "./ui"
import { createDebouncedSignal, errorMessage, projectName, sessionTitle, truncate } from "./util"

const PAGE = 50
/** Pages fetched without a query while sessions can still be Active (not yet auto-settled). */
const MAX_PAGES = 6

type View =
  | { readonly type: "list" }
  | { readonly type: "snooze"; readonly sessionID: string; readonly standalone?: boolean }
  | { readonly type: "custom"; readonly sessionID: string; readonly standalone?: boolean; readonly error?: string }
  | { readonly type: "rename"; readonly sessionID: string; readonly title: string; readonly error?: string }
  | { readonly type: "help"; readonly groups: readonly HelpGroup[] }

type Row = { session: SessionInfo; signals: Signals; placement: Placement }

export type DialogStart = { readonly view: "snooze"; readonly sessionID: string }

let openDialogs = 0
/** Whether this plugin's dialog is showing, in any view. */
export const isInboxOpen = () => openDialogs > 0

export function InboxDialog(props: { inbox: Inbox; options: Options; start?: DialogStart }) {
  openDialogs++
  onCleanup(() => openDialogs--)
  const context = usePlugin()
  const inbox = props.inbox
  const data = context.data
  const client = context.client
  const theme = useDialogTheme()
  const config = readCliConfig()
  const animations = config.animations ?? true
  const keys = props.options.keybinds
  const halfPageKeys = { down: keys.halfPageDown, up: keys.halfPageUp }
  // Every project's sessions, or the current directory's. Follows the built-in list's choice until toggled here.
  const hostAllProjects = readHostAllProjects(context.app.channel, config)
  const allProjects = () => inbox.state.allProjects ?? hostAllProjects

  const [view, setView] = createSignal<View>(
    props.start ? { type: "snooze", sessionID: props.start.sessionID, standalone: true } : { type: "list" },
  )
  const [tab, setTab] = createSignal<Tab>("active")
  const [filter, setFilter] = createSignal("")
  const [search, setSearch] = createDebouncedSignal("", 150)
  const [toDelete, setToDelete] = createSignal<string>()
  const [renaming, setRenaming] = createSignal(false)
  const [lastSelected, setLastSelected] = createSignal<string>()
  const deleted = new Set<string>()

  onCleanup(inbox.watch())
  inbox.tick()

  // Sessions the user explicitly snoozed or restored may be older than the pages fetched below.
  for (const [id, entry] of Object.entries(untrack(() => inbox.state.sessions ?? {}))) {
    if (entry.state !== "settled" && !data.session.get(id)) void data.session.sync(id).catch(() => {})
  }

  const route = () => context.ui.router.current()
  const currentSessionID = createMemo(() => {
    const value = route()
    return value.type === "session" ? value.sessionID : undefined
  })
  const pickerLocation = (): LocationRef => {
    const value = route()
    return (
      (value.type === "session" ? data.session.get(value.sessionID)?.location : undefined) ??
      context.location ??
      data.location.default()
    )
  }

  // `data.location.info` is part of the host data store, not the typed plugin API, so it is optional here.
  const hostInfo = (location: LocationRef) =>
    (data.location as unknown as { info?: (ref: LocationRef) => LocationPublicInfo | undefined }).info?.(location)
  const [fetchedInfo] = createResource(
    () => (hostInfo(pickerLocation()) ? undefined : pickerLocation()),
    (location) => client.location.get({ location: { directory: location.directory } }).catch(() => undefined),
  )
  const currentInfo = () => hostInfo(pickerLocation()) ?? fetchedInfo.latest
  async function resolveLocation(location: LocationRef) {
    if (!hostInfo(location)) await data.location.sync(location).catch(() => {})
    return hostInfo(location) ?? (await client.location.get({ location: { directory: location.directory } }))
  }

  const autoSettleMs = props.options.autoSettleAfterDays ? props.options.autoSettleAfterDays * 24 * 60 * 60 * 1_000 : null

  const [searchResults, { mutate: setSearchResults }] = createResource(
    () => ({ query: search().trim(), location: pickerLocation(), allProjects: allProjects() }),
    async ({ query, location, allProjects }) => {
      try {
        const scope = await (async () => {
          if (allProjects) return {}
          const current = await resolveLocation(location)
          if (!current) throw new Error("Location unavailable")
          return current.project.id === "global"
            ? { directory: current.directory }
            : {
                project: current.project.id,
                subpath: path.relative(current.project.directory, current.directory).replaceAll("\\", "/"),
              }
        })()
        const sessions: SessionInfo[] = []
        let cursor: string | undefined
        for (let page = 0; page < (query ? 1 : MAX_PAGES); page++) {
          const response = await client.session.list({
            ...scope,
            ...(query ? { search: query } : {}),
            ...(cursor ? { cursor } : {}),
            limit: PAGE,
            order: "desc",
            parentID: null,
            archived: false,
          })
          sessions.push(...response.data)
          cursor = response.cursor?.next ?? undefined
          if (!cursor || response.data.length < PAGE) break
          // Later pages only hold sessions that already settled by inactivity.
          const oldest = response.data.at(-1)!.time.updated
          if (autoSettleMs !== null && oldest < Date.now() - autoSettleMs) break
        }
        return { query, allProjects, sessions, error: undefined as unknown }
      } catch (error) {
        // A transient transport failure must degrade search, not crash the TUI.
        return { query, allProjects, sessions: [] as SessionInfo[], error: error as unknown }
      }
    },
  )

  const inScope = (session: SessionInfo) => {
    const current = currentInfo()
    return session.projectID === current?.project.id && session.location.directory === current.directory
  }

  const localSessions = createMemo(() => {
    const query = filter().trim().toLowerCase()
    return data.session
      .list()
      .filter(
        (session) =>
          !session.parentID &&
          session.time.archived === undefined &&
          (allProjects() || inScope(session)) &&
          (!query || sessionTitle(session).toLowerCase().includes(query)),
      )
  })

  const sessions = createMemo(() => {
    const byID = new Map<string, SessionInfo>()
    const add = (session: SessionInfo) => {
      if (session.parentID || deleted.has(session.id)) return
      const live = data.session.get(session.id) ?? session
      if (live.time.archived !== undefined) return
      byID.set(session.id, live)
    }
    // Results fetched for the other scope would show the wrong sessions until the new fetch lands.
    const result = searchResults.latest
    if (result && !result.error && result.allProjects === allProjects()) result.sessions.forEach(add)
    localSessions().forEach(add)
    return [...byID.values()]
  })

  const searchState = createMemo(() => {
    const query = filter().trim()
    if (query !== search().trim() || searchResults.loading)
      return { message: query ? "Searching sessions…" : "Loading sessions…", error: false }
    const result = searchResults()
    if (result?.query === query && result.error)
      return {
        message: query ? "Could not search sessions. Change the search to try again." : "Could not load sessions.",
        error: true,
      }
    return { message: query ? "No sessions found" : `No ${TAB_LABEL[tab()].toLowerCase()} sessions`, error: false }
  })

  const rows = createMemo((): Row[] => {
    const at = inbox.clock()
    return sessions().map((session) => {
      const signals = inbox.signals(session.id)
      return {
        session,
        signals,
        placement: place({
          session,
          entry: inbox.entry(session.id),
          signals,
          now: at,
          autoSettleAfterDays: props.options.autoSettleAfterDays,
        }),
      }
    })
  })

  const counts = createMemo(() => {
    const result: Record<Tab, { total: number; attention: number }> = {
      active: { total: 0, attention: 0 },
      settled: { total: 0, attention: 0 },
      snoozed: { total: 0, attention: 0 },
    }
    for (const row of rows()) {
      result[row.placement.tab].total++
      if (row.signals.attention) result[row.placement.tab].attention++
    }
    return result
  })

  const pinsEnabled = () => !context.ui.tabs.enabled()
  const deleteKey = () => context.keymap.shortcuts("better_sessions.delete")[0] ?? keys.delete
  const helpKey = () => {
    const bound = [...new Set(context.keymap.shortcuts("better_sessions.help"))]
    // With a search in place a plain "?" types into it, so the hint shows a key that still opens help (ctrl+/).
    if (filter()) {
      const types = (key: string) => [...key.replace(/^shift\+/, "")].length === 1
      const always = bound.find((key) => !types(key) && key !== "ctrl+_")
      if (always) return always
    }
    return bound[0] ?? "?"
  }

  /**
   * Every key the list answers to, read from the keymap while the list is showing, so custom keys from cli.json
   * appear as they are bound. Actions hidden on the current tab stay registered (disabled), so they are listed too.
   */
  function keybindingGroups(): HelpGroup[] {
    // Spellings of the same key that some terminals send, bound only so the key works everywhere.
    const variants = new Set(["shift+?", "shift+/", "ctrl+_"])
    const keysOf = (id: string) => {
      // Ids the host also registers (session.rename inside a session, for one) report their keys once per layer.
      const list = [...new Set(context.keymap.shortcuts(id))]
      const shown = list.filter((key) => !variants.has(key))
      return (shown.length ? shown : list).join(", ")
    }
    const row = (id: string, label: string) => ({ keys: keysOf(id), label })
    return [
      {
        title: "Selected session",
        rows: [
          row("dialog.select.submit", "Open"),
          row("better_sessions.settle", "Settle"),
          row("better_sessions.snooze", "Snooze…"),
          row("better_sessions.restore", "Restore to Active"),
          ...(pinsEnabled() ? [row("session.pin.toggle", "Pin / unpin")] : []),
          row("session.rename", "Rename"),
          row("better_sessions.delete", "Delete (press twice)"),
        ],
      },
      {
        title: "List",
        rows: [
          row("better_sessions.tab.next", "Next tab"),
          row("better_sessions.tab.previous", "Previous tab"),
          row("better_sessions.all_projects", "All projects / current directory"),
          row("better_sessions.jump", "Jump to a row (type its label)"),
          { keys: "type", label: "Search" },
          row("better_sessions.help", "Keybindings (this view)"),
          { keys: "esc", label: "Close the list" },
        ],
      },
      {
        title: "Move",
        rows: [
          row("dialog.select.prev", "Up"),
          row("dialog.select.next", "Down"),
          row("better_sessions.half_page_down", "Half page down"),
          row("better_sessions.half_page_up", "Half page up"),
          row("dialog.select.page_up", "Page up"),
          row("dialog.select.page_down", "Page down"),
          row("dialog.select.home", "First row"),
          row("dialog.select.end", "Last row"),
        ],
      },
    ]
  }

  function openHelp() {
    setToDelete(undefined)
    setView({ type: "help", groups: keybindingGroups() })
  }

  const currentProjectName = createMemo(() => {
    const current = currentInfo()
    if (!current) return ""
    return projectName(data.project.get(current.project.id)) ?? ""
  })

  const options = createMemo((): SelectOption<string>[] => {
    const at = inbox.clock()
    const active = tab()
    const visible = rows().filter((row) => row.placement.tab === active)
    const byID = new Map(visible.map((row) => [row.session.id, row]))
    const pinned = pinsEnabled() ? inbox.pins().filter((id) => byID.has(id)) : []
    const pinnedSet = new Set(pinned)
    const slotByID = new Map(inbox.slots().map((id, index) => [id, index + 1]))
    const dialogTheme = theme()

    const option = (row: Row, category: string | undefined): SelectOption<string> => {
      const { session, signals, placement } = row
      const project = data.project.get(session.projectID)
      const directory = session.location.directory
      const root = session.subpath ? path.resolve(directory, ...session.subpath.split("/").map(() => "..")) : directory
      const relative = path.relative(project?.canonical ?? root, root)
      const worktree =
        relative.startsWith("..") || path.isAbsolute(relative) ? truncate(path.basename(relative), 25) : undefined
      const footer = [placement.until !== undefined ? snoozeTimeLeft(placement.until, at) : undefined, worktree].filter(
        Boolean,
      )
      const slot = pinsEnabled() ? slotByID.get(session.id) : undefined
      const deleting = toDelete() === session.id
      return {
        title: deleting ? `Press ${deleteKey()} again to confirm` : sessionTitle(session),
        value: session.id,
        category,
        footer: footer.length ? footer.join(" · ") : undefined,
        bg: deleting ? dialogTheme.background.action.destructive.focused : undefined,
        fg: deleting ? dialogTheme.text.action.destructive.focused : undefined,
        ...statusGutter(
          dialogTheme,
          { attention: signals.attention, woke: !!placement.woke, working: signals.working },
          animations,
          slot === undefined ? undefined : () => <text fg={dialogTheme.hue.accent[200]}>{slot}</text>,
        ),
      }
    }

    const rest = visible.filter((row) => !pinnedSet.has(row.session.id))
    const head = pinned.map((id) => option(byID.get(id)!, "Pinned"))
    if (active === "active") {
      // Waiting on the user and finished first, still working last. No date buckets.
      return [...head, ...rest.sort(compareActive).map((row) => option(row, pinned.length ? "Sessions" : undefined))]
    }
    if (active === "snoozed") {
      return [
        ...head,
        ...rest
          .map((row) => ({ ...row, until: row.placement.until }))
          .sort(compareSnoozed)
          .map((row) => option(row, wakeCategory(row.until ?? at, at))),
      ]
    }
    return [...head, ...rest.sort(compareUpdated).map((row) => option(row, dayCategory(row.session.time.updated, at)))]
  })

  function cycle(direction: 1 | -1) {
    const index = TABS.indexOf(tab())
    setTab(TABS[(index + direction + TABS.length) % TABS.length]!)
    setToDelete(undefined)
  }

  function titleOf(id: string) {
    const session = data.session.get(id) ?? sessions().find((item) => item.id === id)
    return session ? sessionTitle(session) : id
  }

  function openSnooze(id: string, standalone = false) {
    const blocker = inbox.canSnooze(id)
    if (blocker) {
      context.ui.toast.show({ message: blocker, variant: "warning" })
      if (standalone) context.ui.dialog.clear()
      return
    }
    setLastSelected(id)
    setView({ type: "snooze", sessionID: id, standalone })
  }

  function backToList(standalone?: boolean) {
    if (standalone) {
      context.ui.dialog.clear()
      return
    }
    setView({ type: "list" })
  }

  function applySnooze(id: string, until: number, standalone?: boolean) {
    const error = inbox.snooze(id, until)
    if (error) return error
    if (standalone) {
      context.ui.toast.show({ message: `Snoozed until ${formatWake(until, Date.now())}`, variant: "success" })
      context.ui.dialog.clear()
      return
    }
    setView({ type: "list" })
    return undefined
  }

  const actions = createMemo((): SelectAction<string>[] => {
    const active = tab()
    return [
      {
        command: "better_sessions.restore",
        title: "restore",
        bind: keys.restore,
        hidden: active === "active",
        onTrigger: (option) => void inbox.restore(option.value),
      },
      {
        command: "better_sessions.snooze",
        title: "snooze",
        bind: keys.snooze,
        onTrigger: (option) => openSnooze(option.value),
      },
      {
        command: "better_sessions.settle",
        title: "settle",
        bind: keys.settle,
        hidden: active === "settled",
        blocked: (option) => inbox.canSettle(option.value),
        onTrigger: (option) => {
          const error = inbox.settle(option.value)
          if (error) context.ui.toast.show({ message: error, variant: "warning" })
        },
      },
      {
        command: "session.pin.toggle",
        title: "pin/unpin",
        hidden: !pinsEnabled(),
        onTrigger: (option) => void inbox.togglePin(option.value),
      },
      {
        command: "better_sessions.delete",
        title: "delete",
        bind: keys.delete,
        onTrigger: (option) => {
          if (toDelete() !== option.value) {
            setToDelete(option.value)
            return
          }
          void client.session
            .remove({ sessionID: option.value })
            .then(() => {
              deleted.add(option.value)
              setToDelete(undefined)
              setSearchResults((result) =>
                result
                  ? { ...result, sessions: result.sessions.filter((session) => session.id !== option.value) }
                  : result,
              )
            })
            .catch((error) => {
              setToDelete(undefined)
              context.ui.toast.show({
                message: `Failed to delete session: ${errorMessage(error)}`,
                variant: "error",
                duration: 5000,
              })
            })
        },
      },
      {
        command: "session.rename",
        title: "rename",
        onTrigger: (option) => {
          setLastSelected(option.value)
          setToDelete(undefined)
          setView({ type: "rename", sessionID: option.value, title: titleOf(option.value) })
        },
      },
    ]
  })

  const bindings = createMemo((): KeymapCommand[] => [
    {
      id: "better_sessions.tab.next",
      title: "Next tab",
      group: "Dialog",
      bind: keys.nextTab,
      run: () => cycle(1),
    },
    {
      id: "better_sessions.tab.previous",
      title: "Previous tab",
      group: "Dialog",
      bind: keys.previousTab,
      run: () => cycle(-1),
    },
    {
      id: "better_sessions.help",
      title: "Show keybindings",
      group: "Dialog",
      bind: keys.help,
      run: (_input, event) => {
        // While searching, "?" is part of the query; ctrl+/ still opens help.
        if (filter() && event && typedCharacter(event) !== undefined) return false
        openHelp()
      },
    },
    {
      id: "better_sessions.all_projects",
      title: allProjects() ? "Show current directory sessions" : "Show all project sessions",
      group: "Dialog",
      bind: keys.allProjects,
      run: () => {
        setToDelete(undefined)
        void inbox.setAllProjects(!allProjects())
      },
    },
  ])

  const tabsView = () => (
    // Pulled left by the tabs' own padding so the first label lines up with the title.
    <box flexDirection="row" gap={1} marginLeft={-1}>
      <For each={TABS}>
        {(item) => {
          const selected = () => tab() === item
          const count = () => counts()[item]
          return (
            <box
              flexDirection="row"
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={selected() ? theme().background.action.primary.focused : undefined}
              onMouseUp={() => {
                setTab(item)
                setToDelete(undefined)
              }}
            >
              <text
                fg={selected() ? theme().text.action.primary.focused : theme().text.base}
                attributes={selected() ? TextAttributes.BOLD : undefined}
              >
                {TAB_LABEL[item]}
                <span style={{ fg: selected() ? theme().text.action.primary.focused : theme().text.muted }}>
                  {" " + count().total}
                </span>
                <Show when={count().attention > 0}>
                  <span
                    style={{
                      fg: selected() ? theme().text.action.primary.focused : theme().text.feedback.warning.base,
                    }}
                  >
                    {` · ${count().attention} waiting`}
                  </span>
                </Show>
              </text>
            </box>
          )
        }}
      </For>
      <box flexGrow={1} />
      <text fg={theme().text.muted} flexShrink={0}>
        {`${keys.nextTab}/${keys.previousTab}`}
      </text>
    </box>
  )

  const emptyMessage = () => (
    <box paddingLeft={DIALOG_LIST_INSET} paddingRight={DIALOG_LIST_INSET}>
      <text fg={searchState().error ? theme().text.feedback.error.base : theme().text.muted}>
        {searchState().message}
      </text>
    </box>
  )

  const size = createMemo(() => (view().type === "list" ? "large" : "medium"))
  onMount(() => context.ui.dialog.set({ size: size() }))
  createEffect(on(size, (next) => context.ui.dialog.set({ size: next }), { defer: true }))

  return (
    <Switch>
      <Match when={view().type === "list"}>
        <Select<string>
          title="Sessions"
          titleView={
            <box flexDirection="row">
              <text fg={theme().text.base} attributes={TextAttributes.BOLD}>
                Sessions
              </text>
              <Show when={!allProjects() && currentProjectName()}>
                <text fg={theme().text.muted}> for {currentProjectName()}</text>
              </Show>
            </box>
          }
          headerExtra={tabsView()}
          reservedRows={3}
          initialFilter={filter()}
          options={options()}
          current={currentSessionID()}
          focus={lastSelected()}
          resetKey={tab()}
          config={config}
          onFilter={(query) => {
            setFilter(query)
            setSearch(query)
          }}
          bindings={bindings()}
          emptyView={emptyMessage()}
          noMatchView={emptyMessage()}
          onMove={(option) => {
            setToDelete(undefined)
            setLastSelected(option.value)
          }}
          onSelect={(option) => {
            context.ui.router.navigate({ type: "session", sessionID: option.value })
            context.ui.dialog.clear()
          }}
          actions={actions()}
          actionHints={false}
          footerHints={[{ title: "keybindings", label: helpKey(), side: "right" }]}
          halfPageKeys={halfPageKeys}
          jumpKey={keys.jump}
        />
      </Match>
      <Match when={view().type === "help" && (view() as Extract<View, { type: "help" }>)}>
        {(current) => (
          <KeybindingsHelp
            groups={current().groups}
            helpBind={keys.help}
            halfPageKeys={halfPageKeys}
            onClose={() => setView({ type: "list" })}
          />
        )}
      </Match>
      <Match when={view().type === "snooze" && (view() as Extract<View, { type: "snooze" }>)}>
        {(current) => <SnoozePicker view={current()} />}
      </Match>
      <Match when={view().type === "custom" && (view() as Extract<View, { type: "custom" }>)}>
        {(current) => (
          <Prompt
            title="Snooze until"
            config={config}
            placeholder="45m, 2h, 3d, 14:00, tomorrow 09:00 or 2026-11-10 14:00"
            description={() => (
              <text fg={theme().text.muted} wrapMode="word">
                {truncate(titleOf(current().sessionID), 54)}
              </text>
            )}
            error={current().error}
            onCancel={() => setView({ type: "snooze", sessionID: current().sessionID, standalone: current().standalone })}
            onConfirm={(value) => {
              const result = resolveCustomSnooze(value, new Date())
              if ("error" in result) {
                setView({ ...current(), error: result.error })
                return
              }
              const error = applySnooze(current().sessionID, result.until, current().standalone)
              if (error) setView({ ...current(), error })
            }}
          />
        )}
      </Match>
      <Match when={view().type === "rename" && (view() as Extract<View, { type: "rename" }>)}>
        {(current) => (
          <Prompt
            title="Rename session"
            placeholder="Session title"
            value={current().title}
            busy={renaming()}
            error={current().error}
            config={config}
            onCancel={() => setView({ type: "list" })}
            onConfirm={(value) => {
              const title = value.trim()
              if (!title) return
              setRenaming(true)
              void client.session
                .update({ sessionID: current().sessionID, title })
                .then(() => setView({ type: "list" }))
                .catch((error) => {
                  context.ui.toast.show({
                    message: `Failed to rename session: ${errorMessage(error)}`,
                    variant: "error",
                    duration: 5000,
                  })
                })
                .finally(() => setRenaming(false))
            }}
          />
        )}
      </Match>
    </Switch>
  )

  function SnoozePicker(pickerProps: { view: Extract<View, { type: "snooze" }> }) {
    const shown = createMemo(() => resolveSnoozePresets(new Date(inbox.clock()), props.options.snoozePresets))
    const entry = () => inbox.entry(pickerProps.view.sessionID)
    const pickerOptions = createMemo((): SelectOption<string>[] => [
      ...shown().map((preset) => ({ title: preset.label, value: preset.id, footer: preset.whenLabel })),
      { title: "Custom…", value: "custom", footer: "duration or time" },
    ])
    const currentWake = () => {
      const value = entry()
      return value?.state === "snoozed" && value.until > inbox.clock() ? value.until : undefined
    }
    return (
      <Select<string>
        title="Snooze session"
        titleView={
          <box flexDirection="row" flexShrink={1}>
            <text fg={theme().text.base} attributes={TextAttributes.BOLD} flexShrink={0}>
              Snooze
            </text>
            <text fg={theme().text.muted} wrapMode="none" overflow="hidden">
              {" " + truncate(titleOf(pickerProps.view.sessionID), 40)}
            </text>
          </box>
        }
        headerExtra={
          <Show when={currentWake()}>
            {(until) => (
              <text fg={theme().text.muted}>
                {`Snoozed until ${formatWake(until(), inbox.clock())}, ${snoozeTimeLeft(until(), inbox.clock())}`}
              </text>
            )}
          </Show>
        }
        renderFilter={false}
        options={pickerOptions()}
        config={config}
        halfPageKeys={halfPageKeys}
        jumpKey={keys.jump}
        onCancel={() => backToList(pickerProps.view.standalone)}
        onSelect={(option) => {
          if (option.value === "custom") {
            setView({ type: "custom", sessionID: pickerProps.view.sessionID, standalone: pickerProps.view.standalone })
            return
          }
          const preset = pickSnoozePreset({
            shown: shown(),
            id: option.value,
            now: new Date(),
            presets: props.options.snoozePresets,
          })
          if (!preset) return
          const error = applySnooze(pickerProps.view.sessionID, preset.until, pickerProps.view.standalone)
          if (error) context.ui.toast.show({ message: error, variant: "warning" })
        }}
      />
    )
  }
}
