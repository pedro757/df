local function focus_rank(window)
  local rank = window.focus_history_id
  return rank >= 0 and rank or math.huge
end

return function(step)
  local active = hl.get_active_window()
  local monitor = active and active.monitor
  local workspace = monitor and (monitor.active_special_workspace or monitor.active_workspace)
  if not workspace or (active.workspace ~= workspace and (not active.pinned or workspace.special)) then
    return
  end

  local floats, base = {}, nil
  -- Read the live bottom-to-top order on every press. Clicking an already
  -- focused float raises it without changing focus, so a cached order is wrong.
  -- Restrict candidates: visible alone also includes other workspaces.
  for _, window in ipairs(hl.get_windows({ mapped = true, monitor = monitor })) do
    local on_workspace = window.workspace == workspace or (window.pinned and not workspace.special)
    if on_workspace and window.visible and not window.hidden and window.accepts_input then
      if window.floating then
        floats[#floats + 1] = window
      elseif not base or focus_rank(window) < focus_rank(base) then
        -- Tiles share one depth; return to the last focused tile. H/L select
        -- other tiles without making J/K cycle through the whole workspace.
        base = window
      end
    end
  end

  local order = {}
  if base then order[#order + 1] = base end
  for _, window in ipairs(floats) do
    order[#order + 1] = window
  end

  for index, window in ipairs(order) do
    if window == active then
      local target = order[index + step]
      -- No wrapping: J stops at the tiles; K stops at the top float.
      if target then
        -- Keyboard focus does not raise Wayland windows; leave their visual
        -- stacking unchanged, unlike a click or bring_to_top dispatcher.
        hl.dispatch(hl.dsp.focus({ window = target }))
      end
      return
    end
  end
end
