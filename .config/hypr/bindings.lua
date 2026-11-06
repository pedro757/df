hl.unbind("SUPER + RETURN")
o.bind("SUPER + RETURN", "Terminal", 'uwsm-app -- ghostty --working-directory="$(omarchy-cmd-terminal-cwd)"')

hl.unbind("SUPER + SHIFT + B")
o.bind("SUPER + SHIFT + B", "Browser", "brave")

hl.unbind("SUPER + SHIFT + ALT + B")
o.bind("SUPER + SHIFT + ALT + B", "Browser (private)", "brave --private")

hl.unbind("SUPER + SHIFT + W")
o.bind("SUPER + SHIFT + W", "Typora", "uwsm-app -- typora --enable-wayland-ime")

hl.unbind("SUPER + SHIFT + C")
o.bind("SUPER + SHIFT + C", "Calculator", "omacalc")

-- Override Universal paste so OpenCode handles images as well as text.
hl.unbind("SUPER + V")
o.bind("SUPER + V", "Universal paste", function()
  local window = hl.get_active_window()
  local terminal = false
  for _, tag in ipairs(window and window.tags or {}) do
    if tag:gsub("%*$", "") == "terminal" then
      terminal = true
      break
    end
  end

  local title = window and window.title or ""
  local opencode = title == "OpenCode" or title:match("^OC |") ~= nil
  local mods, key = "CTRL", "V"
  if terminal and not opencode then
    mods, key = "SHIFT", "Insert"
  end

  -- Match Omarchy's down/up split to avoid stuck synthetic keys.
  hl.dispatch(hl.dsp.send_key_state({ mods = mods, key = key, state = "down" }))
  hl.timer(function()
    hl.dispatch(hl.dsp.send_key_state({ mods = mods, key = key, state = "up" }))
  end, { timeout = 50, type = "oneshot" })
end)

hl.unbind("SUPER + Q")
o.bind("SUPER + Q", nil, hl.dsp.layout("colresize -conf"))
o.bind("SUPER + R", "Omarchy menu", "omarchy-menu")

for _, key in ipairs({ "H", "J", "K", "L" }) do
  hl.unbind("SUPER + " .. key)
end

o.bind("SUPER + H", nil, hl.dsp.focus({ direction = "l" }))
o.bind("SUPER + L", nil, hl.dsp.focus({ direction = "r" }))
local focus_stack = require("hypr.focus-stack")
o.bind("SUPER + K", "Focus up the window stack", function() focus_stack(1) end)
o.bind("SUPER + J", "Focus down the window stack", function() focus_stack(-1) end)

o.bind("SUPER + F1", "Volume down", "omarchy-swayosd-client --output-volume lower", { locked = true, repeating = true })
o.bind("SUPER + F2", "Volume up", "omarchy-swayosd-client --output-volume raise", { locked = true, repeating = true })
o.bind("SUPER + F3", "Mute", "omarchy-swayosd-client --output-volume mute-toggle", { locked = true })
o.bind("SUPER + F4", "Mute microphone", "omarchy-audio-input-mute", { locked = true })
o.bind("SUPER + F5", "Play", "omarchy-swayosd-client --playerctl play-pause", { locked = true })
o.bind("SUPER + F6", "Previous track", "omarchy-swayosd-client --playerctl previous", { locked = true })
o.bind("SUPER + F7", "Next track", "omarchy-swayosd-client --playerctl next", { locked = true })

o.window("org.kde.kruler", { float = true })
