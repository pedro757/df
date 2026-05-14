-- Keymaps are automatically loaded on the VeryLazy event
-- Default keymaps that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/keymaps.lua
-- Add any additional keymaps here
local m = vim.keymap.set

-- m("n", "<leader>E", vim.cmd.NvimTreeToggle, { silent = true, desc = "File Explorer" })
m("n", "<leader>e", vim.cmd.Oil, { silent = true, desc = "File Explorer" })

-- " New Line Pressing Enter
m("n", "<S-Enter>", ":call AddEmptyLineAbove()<CR>", { silent = true })
m("n", "<CR>", ":call AddEmptyLineBelow()<CR>", { silent = true })

m("c", "<c-a>", "<Home>")
m("n", "<leader>c", ":nohl<cr>:redraw<cr>:<BS>", { desc = "Clear" })
-- Vim Defaults
m("i", "<c-c>", "<Esc>", { remap = true })

m("t", "<Esc>", [[<C-\><C-n>]])
m("t", "<C-h>", [[<Cmd>wincmd h<CR>]])
m("t", "<C-j>", [[<Cmd>wincmd j<CR>]])
m("t", "<C-k>", [[<Cmd>wincmd k<CR>]])
m("t", "::", [[<C-\><C-n>:]])
m({ "n", "t" }, "<C-t>", ":TermNew cmd=fish<CR>", { silent = true, desc = "New Terminal" })

m("n", "<leader>o", ":NeoZoomToggle<CR>zz", { desc = "Zoom", silent = true })
m("n", "j", '(v:count > 5 ? "m\'" . v:count : "") . \'gj\'', { expr = true })
m("n", "k", '(v:count > 5 ? "m\'" . v:count : "") . \'gk\'', { expr = true })
m("", "H", "^", { remap = true })
m("", "L", "g_", { remap = true })
m("i", ",", ",<c-g>u")
m("i", ".", ".<c-g>u")
m("i", "!", "!<c-g>u")
m("i", "?", "?<c-g>u")

m("n", "<c-k>", "<c-w>k")
m("n", "<c-j>", "<c-w>j")
m("n", "<c-l>", "<c-w>l")
m("n", "<c-h>", "<c-w>h")

m({ "i", "c" }, "<c-h>", "<left>")
m("i", "<c-l>", "<right>")
m({ "i", "c" }, "<c-j>", "<down>")
m({ "i", "c" }, "<c-k>", "<up>")
m("c", "<c-l>", "<CR>", { remap = true })

-- " QuickFixList
m("n", "<C-q>", ":call ToggleList('Location List', 'l')<CR>", { silent = true })
m("n", "<leader>q", ":call ToggleList('Quickfix List', 'c')<CR>", { silent = true, desc = "Quickfix List" })

-- " LSP
m("n", "gd", vim.lsp.buf.definition, { desc = "Declaration", silent = true })
m("n", "gh", function()
  vim.lsp.buf.hover {
    border = "rounded",
    max_width = math.floor(vim.o.columns * 0.4),
    max_height = math.floor(vim.o.lines * 0.3)
  }
end, { desc = "Hover", silent = true })
m("n", "gr", vim.lsp.buf.references, { desc = "References", silent = true })
m("n", "gD", vim.lsp.buf.declaration, { desc = "Declaration", silent = true })
m("n", "<leader>i", vim.lsp.buf.implementation, { desc = "Implementation", silent = true })
m("n", "<leader>D", vim.lsp.buf.type_definition, { desc = "Type Definition", silent = true })
m("n", "<leader>r", vim.lsp.buf.rename, { desc = "Rename", silent = true })
m("n", "<leader>d", vim.diagnostic.open_float, { desc = "Diagnostic", silent = true })

local severity_levels = {
  vim.diagnostic.severity.ERROR,
  vim.diagnostic.severity.WARN,
  vim.diagnostic.severity.INFO,
  vim.diagnostic.severity.HINT,
}

local get_highest_error_severity = function()
  for _, level in ipairs(severity_levels) do
    local diags = vim.diagnostic.get(0, { severity = { min = level } })
    if #diags > 0 then
      return level, diags
    end
  end
end

m("n", "<leader>dn", function()
  vim.diagnostic.jump({
    count = 1,
    severity = get_highest_error_severity(),
  })
  vim.cmd('normal! zz')
end, { desc = "Next Diagnostic", silent = true })
m("n", "<leader>dN", function()
  vim.diagnostic.jump({
    count = -1,
    severity = get_highest_error_severity(),
  })
  vim.cmd('normal! zz')
end, { desc = "Previous Diagnostic", silent = true })
m("n", "<leader>dq", vim.diagnostic.setloclist, { desc = "Send to LocList", silent = true })
m("n", "<leader>=", function()
  vim.lsp.buf.format({ async = true, filter = function(client) return client.name ~= "tsgo" end })
end, { desc = "Format file", silent = true })

m({ "n", "v" }, "<leader>a", vim.lsp.buf.code_action, { desc = "Code Action", silent = true })

m("n", "gs", "<plug>(GrepperOperator)", { remap = true })
m("x", "gs", "<plug>(GrepperOperator)<cr>", { remap = true })

-- m(
--   "n",
--   "<leader>tt",
--   require("neotest").run.run,
--   { desc = "Test Nearest", silent = true }
-- )
-- m(
--   "n",
--   "<leader>ta",
--   function() require("neotest").run.run(vim.fn.expand("%")) end,
--   {
--     desc = "Test File",
--     silent = true,
--   }
-- )
-- m(
--   "n",
--   "<leader>to",
--   function() require("neotest").output.open({ enter = true }) end,
--   {
--     desc = "Test Output",
--     silent = true,
--   }
-- )

m("x", "p", '"_dP', { desc = "Paste over" })

m("n", "S", '"_S', {
  desc = "Delete the highlighted lines [into register _] and start insert mode.",
})
m("n", "-", "<CMD>Oil<CR>", { desc = "Open parent directory" })

local function accept_line()
  local line = vim.fn.line(".")
  local line_count = vim.fn.line("$")

  require("supermaven-nvim.completion_preview").on_accept_suggestion()

  local added_lines = vim.fn.line("$") - line_count

  if added_lines > 1 then
    vim.api.nvim_buf_set_lines(0, line + 1, line + added_lines, false, {})
    local last_col = #vim.api.nvim_buf_get_lines(0, line, line + 1, true)[1] or 0
    vim.api.nvim_win_set_cursor(0, { line + 1, last_col })
  end
end

m("i", "<C-e>", accept_line, { desc = "Accept suggestion" })

local function copy_location(is_visual)
  vim.ui.input({ prompt = "Prompt for opencode to copy" }, function(user_input)
    if user_input == nil then
      return
    end

    local full_path = vim.fn.expand("%:p")
    local home = vim.fn.expand("~")
    local path
    if full_path:sub(1, #home) == home then
      path = "~" .. full_path:sub(#home + 1)
    else
      path = full_path
    end

    local location
    if is_visual then
      local start_line = vim.fn.line("'<")
      local end_line = vim.fn.line("'>")
      if start_line == end_line then
        location = string.format("%s:L%s", path, start_line)
      else
        location = string.format("%s:L%s-L%s", path, start_line, end_line)
      end
    else
      local line = vim.fn.line(".")
      local col = vim.fn.col(".")
      location = string.format("%s:L%s:C%s", path, line, col)
    end

    if user_input ~= "" then
      location = location .. "\n\n" .. user_input
    end

    vim.fn.setreg("+", location)
    vim.fn.setreg('"', location)
    vim.notify("Prompt copied to clipboard successfully", vim.log.levels.INFO)
  end)
end

m("n", "<leader>oa", function() copy_location(false) end, { desc = "Yank file location" })
m("x", "<leader>oa", function() copy_location(true) end, { desc = "Yank file location range" })
