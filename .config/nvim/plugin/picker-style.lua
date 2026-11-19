local function get_hl(name)
  return vim.api.nvim_get_hl(0, { name = name, link = false, create = false })
end

local function mix(bg, fg, amount)
  local color = 0
  for _, shift in ipairs({ 16, 8, 0 }) do
    local base = math.floor(bg / 2 ^ shift) % 256
    local tint = math.floor(fg / 2 ^ shift) % 256
    color = color + math.floor(base + (tint - base) * amount + 0.5) * 2 ^ shift
  end
  return color
end

local function apply()
  local dark = vim.o.background == "dark"
  local normal = get_hl("Normal")
  local bg = normal.bg or (dark and 0x202020 or 0xf5f5f5)
  local fg = normal.fg or (dark and 0xf5f5f5 or 0x202020)
  local accent = get_hl("Directory").fg or fg
  local highlight = vim.api.nvim_set_hl

  -- Keep the float transparent, but give the current row a solid fill.
  local row_bg = mix(bg, fg, dark and 0.34 or 0.25)
  highlight(0, "PickerCurrentRow", { bg = row_bg, blend = 0 })
  highlight(0, "PickerBorder", { fg = accent })
  highlight(0, "PickerTitle", { fg = accent, bold = true })

  local cursorline = get_hl("CursorLine")
  if not cursorline.bg or cursorline.bg == bg then
    cursorline.bg = mix(bg, fg, dark and 0.13 or 0.10)
    highlight(0, "CursorLine", cursorline)
  end

  for source, target in pairs({
    SnacksPickerListCursorLine = "PickerCurrentRow",
    SnacksPickerCursorLine = "PickerCurrentRow",
    SnacksPickerBorder = "PickerBorder",
    SnacksPickerTitle = "PickerTitle",
    SnacksPickerSelected = "PickerTitle",
  }) do
    highlight(0, source, { link = target })
  end
end

local group = vim.api.nvim_create_augroup("PickerStyle", { clear = true })
-- VimEnter runs after the startup colorscheme and transparency overrides.
vim.api.nvim_create_autocmd({ "ColorScheme", "VimEnter" }, {
  group = group,
  callback = apply,
})
vim.api.nvim_create_autocmd("FileType", {
  group = group,
  pattern = "harpoon",
  callback = function()
    vim.wo.winhighlight =
      "CursorLine:PickerCurrentRow,FloatBorder:PickerBorder,FloatTitle:PickerTitle"
    vim.wo.cursorline = true
  end,
})
apply()
