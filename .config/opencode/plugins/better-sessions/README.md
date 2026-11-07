# better-sessions

A session list for the [OpenCode](https://github.com/anomalyco/opencode) TUI that keeps track of what still needs
you. It replaces the built-in `session.list` with three tabs, **Active**, **Settled** and **Snoozed**, borrows
t3code's settle and snooze model, and adds flash.nvim-style jump labels and vim half-page scrolling.

![The three tabs](https://raw.githubusercontent.com/pedro757/better-sessions/main/media/tabs.gif)

<sub>The recordings use a sandboxed OpenCode with made-up sessions and a local mock model (see [demo/](https://github.com/pedro757/better-sessions/tree/main/demo)).</sub>

## The tabs

| Tab         | What is in it                                                            | Order                                                                                                              |
| ----------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| **Active**  | Sessions that still need you: finished, waiting on you, or still working | Waiting on you (permission `!`, question `?`) first, then finished, then still working (spinner). No date groups |
| **Settled** | Sessions you settled, and sessions with no activity for 7 days           | By date, like the built-in list (Today, then one group per day)                                                    |
| **Snoozed** | Sessions hidden until a time you picked                                  | Soonest wake first, grouped by wake day, with the time left (`45m left`, `3h left`, `2d left`)                    |

| Active                                                                                        | Settled                                                                                         | Snoozed                                                                                         |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| ![Active](https://raw.githubusercontent.com/pedro757/better-sessions/main/media/active.png) | ![Settled](https://raw.githubusercontent.com/pedro757/better-sessions/main/media/settled.png) | ![Snoozed](https://raw.githubusercontent.com/pedro757/better-sessions/main/media/snoozed.png) |

"Finished" means completely finished. The built-in list stops the spinner as soon as the model turn ends, even
when a background command (a test suite, a dev server, a subagent) is still running. Here a session counts as
working while any of these is true for it or any of its subagents:

- the session is running,
- a prompt is queued,
- a background job (shell, subagent, image) is running, or finished less than 2 minutes ago and its result has
  not been delivered yet,
- a shell it started is still running.

In the recordings, "Run the e2e suite against staging" has finished its turn but its background command is still
going, so it keeps its spinner.

## Settle, snooze, restore

![Settle, snooze and restore](https://raw.githubusercontent.com/pedro757/better-sessions/main/media/actions.gif)

- **Settle** (`ctrl+e`): move to Settled. Not available while the session is running (the spinner): it stays
  in Active until it is completely done. Sessions waiting on you (`!`/`?`) can be settled.
- **Snooze** (`ctrl+t`): pick a time (In 1 hour, In 3 hours, This evening, Tomorrow, Next week, or Custom… with
  `45m`, `2h`, `3d`, `1h30m`, `14:00`, `tomorrow 09:00`, `2026-11-10 14:00`).
- **Restore** (`ctrl+a`, for Active): back to Active.

The same actions are in the command palette for the session you are in: "Settle session", "Snooze session…" and
"Restore session to Active".

| Settling a running session                                                                                       | The snooze menu                                                                                         |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| ![Settle is blocked](https://raw.githubusercontent.com/pedro757/better-sessions/main/media/settle-blocked.png) | ![Snooze menu](https://raw.githubusercontent.com/pedro757/better-sessions/main/media/snooze-menu.png) |

### Sending a message brings a session back

Sending a message to a settled or snoozed session moves it back to Active.

![Sending a message](https://raw.githubusercontent.com/pedro757/better-sessions/main/media/message.gif)

### Snoozes wake up

A snooze ends at its time, with a toast and a `woke` marker in Active until you open the session. It also ends
early when the session asks for a permission, asks a new question, or fails. This follows t3code's rules: a
question that was already pending when you snoozed does not wake it, and a session that keeps working in the
background stays snoozed.

![A snooze ending](https://raw.githubusercontent.com/pedro757/better-sessions/main/media/wake.gif)

## Jump labels and half-page scrolling

![Jump labels and half-page scrolling](https://raw.githubusercontent.com/pedro757/better-sessions/main/media/jump.gif)

- **Jump** (`ctrl+s`): labels every visible row, like folke/flash.nvim's
  `jump({ search = { mode = "search", max_length = 0 }, label = { after = { 0, 0 } }, pattern = "^" })`. Type a
  label to move the selection to that row. Labels use flash's order: `asdfghjklqwertyuiopzxcvbnm`, then the same
  letters in uppercase, handed out by distance from the selected row (the selected row gets `a`, then rows
  alternate below and above, below first). The rest of the list dims while labels are shown. `esc` or `ctrl+s`
  again cancels. A letter that is not a label just ends the jump; other keys (arrows, `return`, `ctrl+e`, ...)
  end it and then do what they always do. Jump also works in the snooze menu. Pressing the `session.list` key
  while the list is open toggles labels too, instead of reopening the list.
- `ctrl+d` / `ctrl+u`: half page down / up, like vim. The list scrolls by half its height and the selection
  moves the same number of lines; at either end the selection keeps moving until the first or last row.
- Arrow keys and the other `dialog.select.*` keybinds work as before.

![Jump labels](https://raw.githubusercontent.com/pedro757/better-sessions/main/media/jump-labels.png)

## Everything else works like the built-in list

![Search, pin, rename and delete](https://raw.githubusercontent.com/pedro757/better-sessions/main/media/manage.gif)

The list shows the sessions of the current directory. Search (server search plus local matches, debounced),
delete (`ctrl+x`, press twice), rename (`ctrl+r`), pin/unpin (`ctrl+f`) when session tabs are off, the
`!`/`?`/spinner status gutter (the spinner honors `animations` in cli.json), worktree labels, the current-session
marker, mouse hover and click, and the "Switch session" palette entry, `/sessions`, `/resume` and `/continue`.

Inside the list `ctrl+x` is delete, so leader sequences (OpenCode's default leader is `ctrl+x`) don't start there.
That includes quick switch: pinned sessions show their slot number, and `session.quick_switch.1`–`9` works
everywhere else, following this plugin's pins.

Switch tabs with `tab` / `shift+tab` or by clicking them. Tab labels show how many sessions are in each tab and
how many are waiting on you.

## Install

Built and tested on OpenCode 2.2.6.

```sh
git clone https://github.com/pedro757/better-sessions ~/.config/opencode/plugins/better-sessions
```

Running TUIs pick it up right away. Open it with your `session.list` key (`<leader>l` by default), the "Switch
session" palette entry or `/sessions`. Disable it with `"-better-sessions"` in `plugins` in
`~/.config/opencode/cli.json` to get the built-in list back.

## Keys

| Key                     | In the list                                     | Option                        |
| ----------------------- | ----------------------------------------------- | ----------------------------- |
| `tab` / `shift+tab`     | Next / previous tab                             | `nextTab` / `previousTab`     |
| `ctrl+e`                | Settle                                          | `settle`                      |
| `ctrl+t`                | Snooze                                          | `snooze`                      |
| `ctrl+a`                | Restore to Active                               | `restore`                     |
| `ctrl+x` (twice)        | Delete                                          | `delete`                      |
| `ctrl+r`                | Rename                                          | `session.rename` keybind      |
| `ctrl+f`                | Pin / unpin                                     | `session.pin.toggle` keybind  |
| `ctrl+s`                | Jump labels                                     | `jump`                        |
| `ctrl+d` / `ctrl+u`     | Half page down / up                             | `halfPageDown` / `halfPageUp` |
| `return`                | Open the session                                |                               |
| `esc`                   | Cancel jump labels, or close                    |                               |

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
          "jump": "ctrl+s",
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
  ids (`session.rename`, `session.pin.toggle`, `dialog.select.*`).

## State

Settled, snoozed and pinned sessions are stored in the TUI's plugin storage
(`~/.local/state/opencode/<channel>/tui/plugin.better-sessions.state.json`), shared live by every TUI on this
machine. Pins are copied once from the built-in list.

The list uses the TUI's current design; the experimental `new-designs` layout is not mirrored.

## Development

`bun test ./test` covers the placement, wake and ordering rules, the snooze presets and custom input, the jump
label order and half-page movement. The [demo/](https://github.com/pedro757/better-sessions/tree/main/demo) folder has the scripts that recorded the media.

## Credits

- [pingdotgg/t3code](https://github.com/pingdotgg/t3code): the Active / Settled / Snoozed model, snooze presets,
  wake rules and time labels.
- [folke/flash.nvim](https://github.com/folke/flash.nvim): the jump label algorithm.
- [anomalyco/opencode](https://github.com/anomalyco/opencode): the built-in session list this mirrors.
