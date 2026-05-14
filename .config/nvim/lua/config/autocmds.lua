local au = vim.api.nvim_create_autocmd
local aug = vim.api.nvim_create_augroup
local map = vim.keymap.set
local cmd = vim.api.nvim_create_user_command
local buf_opts = { buffer = 0, silent = true }
local clear = { clear = true }
local HelpMappings = aug("HelpMappings", clear)

au("FileType", {
  pattern = "help",
  callback = function()
    vim.cmd [[ nnoremap <buffer> s /\|\zs\S\+\ze\|<CR>]]
  end,
  group = HelpMappings,
})

au("FileType", {
  pattern = "help",
  callback = function()
    vim.cmd [[nnoremap <buffer> S ?\|\zs\S\+\ze\|<CR>]]
  end,
  group = HelpMappings,
})

au("FileType", {
  pattern = "help",
  callback = function()
    map("n", "O", [[?'\l\{2,\}'<CR>]], buf_opts)
  end,
  group = HelpMappings,
})

au("FileType", {
  pattern = "help",
  callback = function()
    map("n", "o", [[/'\l\{2,\}'<CR>]], buf_opts)
  end,
  group = HelpMappings,
})

au("FileType", {
  pattern = "help",
  callback = function()
    map("n", "<BS>", "<C-T>", buf_opts)
  end,
  group = HelpMappings,
})

au("FileType", {
  pattern = "help",
  callback = function()
    map("n", "<cr>", "<C-]>", buf_opts)
  end,
  group = HelpMappings,
})

au("FileType", {
  pattern = {
    "ergoterm",
  },
  callback = function()
    map("t", "gq", "<cmd>q<cr>", buf_opts)
    map("t", "<c-x>", "<cmd>q<cr>", buf_opts)
  end,
  group = HelpMappings,
})

au("FileType", {
  pattern = {
    "help",
    "startuptime",
    "checkhealth",
    [[null-ls-info]],
    "lspinfo",
    "UltestSummary",
    "git",
    "man",
  },
  callback = function()
    map("n", "gq", ":bd<cr>", buf_opts)
    map("n", "<c-x>", ":bd<cr>", buf_opts)
  end,
  group = HelpMappings,
})

au("FileType", {
  pattern = {
    "harpoon",
  },
  callback = function()
    map("n", "gq", ":bd!<cr>", buf_opts)
    map("n", "<c-x>", ":bd!<cr>", buf_opts)
  end,
  group = HelpMappings,
})

au("FileType", {
  pattern = {
    "snacks_input",
  },
  callback = function()
    map({ "i", "n" }, "<c-x>", ":bd<cr>", buf_opts)
  end,
  group = HelpMappings,
})

au("FileType", {
  pattern = {
    "startuptime",
    "harpoon",
    [[null-ls-info]],
    "lspinfo",
    "snacks_input",
  },
  callback = function()
    map("n", "<c-c>", ":bd<cr>", buf_opts)
  end,
  group = HelpMappings,
})

au("FileType", {
  pattern = "harpoon",
  callback = function()
    map("n", "<c-j>", "<down>", buf_opts)
  end,
  group = HelpMappings,
})

au("FileType", {
  pattern = "harpoon",
  callback = function()
    map("n", "<c-k>", "<up>", buf_opts)
  end,
  group = HelpMappings,
})

au("FileType", {
  pattern = "harpoon",
  callback = function()
    map({ "i", "n" }, "<c-l>", require("harpoon.ui").select_menu_item, buf_opts)
  end,
  group = HelpMappings,
})

local HighlightYank = aug("HighlightYank", clear)

au("TextYankPost", {
  callback = function()
    vim.highlight.on_yank { timeout = 300 }
  end,
  group = HighlightYank,
})

local StopNewlineComments = aug("StopNewlineComments", clear)

au("BufEnter", {
  callback = function()
    vim.opt.formatoptions:remove "c"
    vim.opt.formatoptions:remove "r"
    vim.opt.formatoptions:remove "o"
  end,
  group = StopNewlineComments,
})

local TrimSpaces = aug("TrimSpaces", clear)

au("BufWritePre", {
  callback = function()
    local curpos = vim.api.nvim_win_get_cursor(0)
    vim.cmd [[:keepjumps keeppatterns %s/\s\+$//e]]
    vim.cmd [[:keepjumps keeppatterns silent! 0;/^\%(\n*.\)\@!/,$d]]
    local end_row = vim.api.nvim_buf_line_count(0)
    if curpos[1] > end_row then
      curpos[1] = end_row
    end
    vim.api.nvim_win_set_cursor(0, curpos)
  end,
  group = TrimSpaces,
})

local OnlyOneCursorLine = aug("OnlyOneCursorLine", clear)

au({ "WinEnter", "InsertLeave" }, {
  callback = function()
    vim.opt.cursorline = true
  end,
  group = OnlyOneCursorLine,
})

au({ "WinLeave", "InsertEnter" }, {
  callback = function()
    vim.opt.cursorline = false
  end,
  group = OnlyOneCursorLine,
})

-- au("BufEnter", {
--   callback = function()
--     if
--         vim.o.filetype == "oil"
--         or vim.o.filetype == "fugitive"
--         or vim.o.filetype == "help"
--         or vim.o.filetype == "lazy"
--     then
--       local stickybuf = require "stickybuf"
--       stickybuf.pin()
--     end
--   end,
-- })

local Mkdir = aug("Mkdir", clear)

au("BufWritePre", {
  callback = function()
    if vim.o.filetype == "oil" or vim.o.filetype == "fugitive" then
      return
    end
    local dir = vim.fn.expand "<afile>:p:h"
    if vim.fn.isdirectory(dir) == 0 then
      vim.fn.mkdir(dir, "p")
    end
  end,
  group = Mkdir,
})

au({ "BufNewFile", "BufRead" }, {
  pattern = "/dev/shm/gopass*",
  callback = function()
    vim.opt.swapfile = false
    vim.opt.backup = false
    vim.opt.undofile = false
    vim.opt.shada = ""
  end,
})

cmd("WW", "SudoWrite", {})
cmd("DiffSaved", function()
  vim.fn.DiffWithSaved()
end, {})
cmd("Dotfiles", "call FugitiveDetect(expand('~/.dotfiles'))", {})
cmd("Worktree", function()
  require("telescope").extensions.git_worktree.git_worktrees()
end, {})

-- listen lsp-progress event and refresh lualine
vim.api.nvim_create_augroup("lualine_augroup", { clear = true })
vim.api.nvim_create_autocmd("User", {
  group = "lualine_augroup",
  pattern = "LspProgressStatusUpdated",
  callback = require("lualine").refresh,
})

local BigFile = aug("BigFile", clear)

au("BufEnter", {
  callback = function()
    if vim.o.filetype == "bigfile" then
      vim.cmd [[SupermavenStop]]
    end
  end,
  group = BigFile,
})
au("BufLeave", {
  callback = function()
    if vim.o.filetype == "bigfile" then
      vim.cmd [[SupermavenStart]]
    end
  end,
  group = BigFile,
})
