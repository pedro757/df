-- Read the theme background on each reload (Omarchy reloads after theme changes).
local inactive_border_color
local theme_colors = io.open(os.getenv("HOME") .. "/.local/state/omarchy/current/theme/colors.toml", "r")
if theme_colors then
  for line in theme_colors:lines() do
    local background = line:match([=[^%s*background%s*=%s*["'](#%x%x%x%x%x%x)["']]=])
    if background then
      inactive_border_color = background
      break
    end
  end
  theme_colors:close()
end

hl.config({
  general = {
    gaps_in = 0,
    gaps_out = 0,
    border_size = 2,
    col = {
      inactive_border = inactive_border_color,
    },
    layout = "scrolling",
  },
  scrolling = {
    column_width = 0.5,
  },
  cursor = {
    warp_on_change_workspace = 0,
  },
})

-- Keep border width fixed when focus changes; highlight only the active window.
-- Single-window workspaces still have no border.
o.window({ workspace = "w[1]" }, { border_size = 0 })

-- Half-duration animations; preserve Omarchy's curves, effects, and disabled leaves.
hl.animation({ leaf = "global", enabled = true, speed = 5, bezier = "default" })
hl.animation({ leaf = "border", enabled = true, speed = 2.695, bezier = "easeOutQuint" })
hl.animation({ leaf = "windows", enabled = true, speed = 1.895, bezier = "easeOutQuint" })
hl.animation({ leaf = "windowsMove", enabled = true, speed = 1, bezier = "easeOutQuint" })
hl.animation({ leaf = "windowsIn", enabled = true, speed = 2.05, bezier = "easeOutQuint", style = "popin 87%" })
hl.animation({ leaf = "windowsOut", enabled = true, speed = 0.745, bezier = "linear", style = "popin 87%" })
hl.animation({ leaf = "fadeIn", enabled = true, speed = 0.865, bezier = "almostLinear" })
hl.animation({ leaf = "fadeOut", enabled = true, speed = 0.73, bezier = "almostLinear" })
hl.animation({ leaf = "fade", enabled = true, speed = 1.515, bezier = "quick" })
hl.animation({ leaf = "layers", enabled = true, speed = 1.905, bezier = "easeOutQuint" })
hl.animation({ leaf = "layersIn", enabled = true, speed = 2, bezier = "easeOutQuint", style = "fade" })
hl.animation({ leaf = "layersOut", enabled = true, speed = 0.75, bezier = "linear", style = "fade" })
hl.animation({ leaf = "fadeLayersIn", enabled = true, speed = 0.895, bezier = "almostLinear" })
hl.animation({ leaf = "fadeLayersOut", enabled = true, speed = 0.695, bezier = "almostLinear" })
hl.animation({ leaf = "specialWorkspace", enabled = true, speed = 1.5, bezier = "easeOutQuint", style = "slidevert" })
