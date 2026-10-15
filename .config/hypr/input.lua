hl.config({
  input = {
    kb_options = "caps:super",
    kb_variant = "altgr-intl",
    repeat_delay = 600,
    follow_mouse = 0,
  },
})

-- Focus on scrolling, not hovering. Keep scroll events going to the app.
local function contains(pos, x, y, width, height)
  return pos.x >= x and pos.x < x + width and pos.y >= y and pos.y < y + height
end

local function focus_on_scroll()
  local pos = hl.get_cursor_pos()
  if not pos then return end

  local monitor = hl.get_monitor_at_cursor()
  if not monitor then return end
  local workspace = monitor.active_special_workspace or monitor.active_workspace
  if not workspace then return end

  -- Leave panels and overlay surfaces alone. Notifications use a fullscreen
  -- surface with a smaller input mask, so their bounds must not block focus.
  for _, layer in ipairs(hl.get_layers()) do
    if layer.mapped and layer.layer >= 2 and layer.namespace ~= "omarchy-notifications"
      and contains(pos, layer.x, layer.y, layer.w, layer.h) then
      return
    end
  end

  local target
  -- `visible` does not mean the window's workspace is currently displayed.
  -- Query only this monitor's displayed workspace to prevent workspace jumps.
  for _, window in ipairs(hl.get_windows({ mapped = true, monitor = monitor, workspace = workspace })) do
    if window.visible and not window.hidden and window.accepts_input then
      local at, size = window.at, window.size
      if contains(pos, at.x, at.y, size.x, size.y) then
        -- Floating windows sit above tiles; prefer the most recently focused
        -- window when floating windows overlap.
        if not target or (window.floating and not target.floating)
          or (window.floating == target.floating and window.focus_history_id < target.focus_history_id) then
          target = window
        end
      end
    end
  end

  if target and not target.active then
    -- The focus dispatcher normally warps the pointer; suppress that only here.
    local no_warps = hl.get_config("cursor.no_warps")
    hl.config({ cursor = { no_warps = true } })
    hl.dispatch(hl.dsp.focus({ window = target }))
    hl.config({ cursor = { no_warps = no_warps } })
  end
end

for _, key in ipairs({ "mouse_up", "mouse_down", "mouse_left", "mouse_right" }) do
  hl.bind(key, focus_on_scroll, { non_consuming = true })
end
