# better-sessions

An OpenCode TUI plugin that replaces the session list (`session.list`) with three tabs:

| Tab         | What is in it                                                                     | Order                                                                                                          |
| ----------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Active**  | Sessions that still need you: finished, waiting on you, or still working          | Waiting on you (permission `!`, question `?`) first, then finished, then still working (spinner). No date groups |
| **Settled** | Sessions you settled, and sessions with no activity for 7 days                    | By date, like the built-in list (Today, then one group per day)                                                 |
| **Snoozed** | Sessions hidden until a time you picked                                           | Soonest wake first, grouped by wake day, with the time left (`45m left`, `3h left`, `2d left`)                |

"Finished" means completely finished. The built-in list stops the spinner as soon as the model turn ends, even
when a background command (a test suite, a dev server, a subagent) is still running. Here a session counts as
working while any of these is true for it or any of its subagents:

- the session is running,
- a prompt is queued,
- a background job (shell, subagent, image) is running, or finished less than 2 minutes ago and its result has
  not been delivered yet,
- a shell it started is still running.

## Moving sessions between tabs

- **Settle** (`ctrl+e`): move to Settled. Not available while the session is running (the spinner): it stays
  in Active until it is completely done. Sessions waiting on you (`!`/`?`) can be settled.
- **Snooze** (`ctrl+t`): pick a time (In 1 hour, In 3 hours, This evening, Tomorrow, Next week, or Custom… with
  `45m`, `2h`, `3d`, `1h30m`, `14:00`, `tomorrow 09:00`, `2026-11-10 14:00`).
- **Restore** (`ctrl+a`, for Active): back to Active.
- **Sending a message** to a settled or snoozed session moves it back to Active.
- A snooze ends at its time (with a toast and a `woke` marker in Active until you open the session), or early
  when the session asks for a permission, asks a new question, or fails. This follows t3code's rules: a
  question that was already pending when you snoozed does not wake it, and a session that keeps working in the
  background stays snoozed.

The same actions are in the command palette for the session you are in: "Settle session", "Snooze session…" and
"Restore session to Active".

## Moving around the list

- `ctrl+d` / `ctrl+u`: half page down / up, like vim. The list scrolls by half its height and the selection
  moves the same number of lines; at either end the selection keeps moving until the first or last row.
- **Jump** (the session list key again, `ctrl+s`): labels every visible row, like folke/flash.nvim's
  `jump({ search = { mode = "search", max_length = 0 }, label = { after = { 0, 0 } }, pattern = "^" })`. Type a
  label to move the selection to that row. Labels use flash's order: `asdfghjklqwertyuiopzxcvbnm`, then the same
  letters in uppercase, handed out by distance from the selected row (the selected row gets `a`, then rows
  alternate below and above, below first). The rest of the list dims while labels are shown. `esc` or the same
  key again cancels. A letter that is not a label just ends the jump; other keys (arrows, `return`, `ctrl+e`, ...)
  end it and then do what they always do. Jump also works in the snooze menu.
- Arrow keys and the other `dialog.select.*` keybinds work as before.

## Everything else works like the built-in list

The list shows the sessions of the current directory (there is no all-projects toggle). Search (server search
plus local matches, debounced), delete (`ctrl+x`, press twice), rename (`ctrl+r`), pin/unpin (`ctrl+f`) when
session tabs are off, the `!`/`?`/spinner status gutter (the spinner honors `animations` in cli.json), worktree
labels, the current-session marker, mouse hover and click, and the "Switch session" palette entry, `/sessions`,
`/resume` and `/continue`. Pinned sessions show their quick switch slot number; the list has no in-dialog quick
switch (`ctrl+x` is delete there), but `session.quick_switch.1`–`9` still works everywhere else.

Switch tabs with `tab` / `shift+tab` or by clicking them. Tab labels show how many sessions are in each tab and
how many are waiting on you.

## Options

Options go in `~/.config/opencode/cli.json`. The plugin loads from `~/.config/opencode/plugins/better-sessions`
without configuration; add an entry only to change options:

```json
{
  "plugins": [
    {
      "package": "./plugins/better-sessions",
      "options": {
        "autoSettleAfterDays": 7,
        "replaceSessionList": true,
        "notifyOnWake": true,
        "snoozePresets": [
          { "kind": "after", "minutes": 60 },
          { "kind": "after", "minutes": 180 },
          { "kind": "at", "day": "today", "time": "18:00" },
          { "kind": "at", "day": "tomorrow", "time": "09:00" },
          { "kind": "at", "day": "monday", "time": "09:00" }
        ],
        "keybinds": {
          "settle": "ctrl+e",
          "snooze": "ctrl+t",
          "restore": "ctrl+a",
          "delete": "ctrl+x",
          "halfPageDown": "ctrl+d",
          "halfPageUp": "ctrl+u",
          "nextTab": "tab",
          "previousTab": "shift+tab"
        }
      }
    }
  ]
}
```

- `autoSettleAfterDays`: days without activity before a session settles by itself (t3code's default is 7).
  `0` or `null` turns it off. Sessions that are working or waiting on you never settle by themselves.
- `replaceSessionList`: `false` keeps the built-in list on `session.list` and adds "Better sessions" to the palette
  and `/better-sessions` instead.
- `notifyOnWake`: toast when a snooze timer ends.
- `snoozePresets`: the snooze menu, in t3code's preset format.
- `keybinds`: keys inside the list. `rename`, `pin/unpin` and arrow navigation keep using their regular keybind
  ids (`session.rename`, `session.pin.toggle`, `dialog.select.*`). Jump uses the `session.list` key, so it needs
  `replaceSessionList` on.

## State

Settled, snoozed and pinned sessions are stored in the TUI's plugin storage
(`~/.local/state/opencode/<channel>/tui/plugin.better-sessions.state.json`), shared live by every TUI on this
machine. Pins are copied once from the built-in list. Quick switch
(`session.quick_switch.1`–`9`) follows this plugin's pins.

Disable the plugin with `"-better-sessions"` in `plugins` in cli.json to get the built-in list back.

The list uses the TUI's current design; the experimental `new-designs` layout is not mirrored.

## Tests

`bun test ./test` from this directory covers the placement, wake and ordering rules and the snooze presets,
labels and custom input.
