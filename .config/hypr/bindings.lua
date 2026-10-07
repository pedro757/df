-- hl.unbind("SUPER + RETURN")
-- o.bind("SUPER + RETURN", "Terminal", 'uwsm-app -- ghostty --working-directory="$(omarchy-cmd-terminal-cwd)"')

hl.unbind("SUPER + SHIFT + B")
o.bind("SUPER + SHIFT + B", "Browser", "brave")

hl.unbind("SUPER + SHIFT + ALT + B")
o.bind("SUPER + SHIFT + ALT + B", "Browser (private)", "brave --private")

hl.unbind("SUPER + SHIFT + W")
o.bind("SUPER + SHIFT + W", "Typora", "uwsm-app -- typora --enable-wayland-ime")

hl.unbind("SUPER + SHIFT + C")
o.bind("SUPER + SHIFT + C", "Calculator", "omacalc")

o.bind("SUPER + Q", nil, hl.dsp.layout("colresize -conf"))
o.bind("SUPER + SHIFT + Q", nil, hl.dsp.layout("colresize +conf"))
o.bind("SUPER + R", "Omarchy menu", "omarchy-menu")

for _, key in ipairs({ "H", "J", "K", "L" }) do
  hl.unbind("SUPER + " .. key)
end

o.bind("SUPER + H", nil, hl.dsp.focus({ direction = "l" }))
o.bind("SUPER + L", nil, hl.dsp.focus({ direction = "r" }))
o.bind("SUPER + K", nil, hl.dsp.focus({ direction = "u" }))
o.bind("SUPER + J", nil, hl.dsp.focus({ direction = "d" }))

o.bind("SUPER + F1", "Volume down", "omarchy-swayosd-client --output-volume lower", { locked = true, repeating = true })
o.bind("SUPER + F2", "Volume up", "omarchy-swayosd-client --output-volume raise", { locked = true, repeating = true })
o.bind("SUPER + F3", "Mute", "omarchy-swayosd-client --output-volume mute-toggle", { locked = true })
o.bind("SUPER + F4", "Mute microphone", "omarchy-audio-input-mute", { locked = true })
o.bind("SUPER + F5", "Play", "omarchy-swayosd-client --playerctl play-pause", { locked = true })
o.bind("SUPER + F6", "Previous track", "omarchy-swayosd-client --playerctl previous", { locked = true })
o.bind("SUPER + F7", "Next track", "omarchy-swayosd-client --playerctl next", { locked = true })

o.window("org.kde.kruler", { float = true })
