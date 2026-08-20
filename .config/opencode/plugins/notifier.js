import { Plugin } from "@opencode-ai/plugin"
import { spawn, spawnSync } from "node:child_process"
import { basename } from "node:path"

const sounds = {
  permission: "dialog-warning",
  question: "dialog-question",
  done: "complete",
  error: "dialog-error",
}

const seen = (globalThis[Symbol.for("pedro.opencode-notifier.seen")] ??= new Set())

function firstDelivery(id) {
  if (seen.has(id)) return false
  seen.add(id)

  const timer = setTimeout(() => seen.delete(id), 10_000)
  timer.unref()
  return true
}

function openCodeIsFocused() {
  const result = spawnSync("hyprctl", ["-j", "activewindow"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
  if (result.status !== 0) return false

  try {
    const window = JSON.parse(result.stdout)
    return /opencode/i.test(window.title ?? "")
  } catch {
    return false
  }
}

function alert(id, event, message, directory) {
  if (!firstDelivery(id)) return
  if (openCodeIsFocused()) return

  const project = directory && directory !== "/" ? ` (${basename(directory)})` : ""
  const notification = spawn(
    "notify-send",
    ["--app-name=OpenCode", "--expire-time=5000", `OpenCode${project}`, message],
    { stdio: "ignore" },
  )
  notification.unref()

  const sound = spawn("canberra-gtk-play", ["--id", sounds[event]], { stdio: "ignore" })
  sound.unref()
}

export default Plugin.define({
  id: "pedro.opencode-notifier",
  setup: async (ctx) => {
    const controller = new AbortController()
    const childSessions = new Set()

    const events = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const directory = event.location?.directory

          if (event.type === "session.created" && event.data.parentID) {
            childSessions.add(event.data.sessionID)
          }

          if (event.type === "session.deleted") {
            childSessions.delete(event.data.sessionID)
          }

          if (event.type === "permission.asked") {
            alert(event.id, "permission", "Session needs permission", directory)
          }

          if (event.type === "session.execution.succeeded" && !childSessions.has(event.data.sessionID)) {
            alert(event.id, "done", "Session has finished", directory)
          }

          if (event.type === "session.execution.failed") {
            alert(event.id, "error", "Session encountered an error", directory)
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error("opencode-notifier event stream failed", error)
      }
    })()

    const toolHook = await ctx.tool.hook("execute.before", (input) => {
      if (input.tool === "question") alert(input.id, "question", "Session has a question")
    })

    return async () => {
      controller.abort()
      await toolHook.dispose()
      await events
    }
  },
})
