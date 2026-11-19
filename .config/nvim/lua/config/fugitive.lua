local M = {}

function M.select_status()
  local win = vim.api.nvim_get_current_win()
  local git_dir = vim.fn.FugitiveGitDir()
  local root = vim.fn.FugitiveWorkTree(git_dir)
  require("config.worktree").select_directory(function(dir, picked)
    if not vim.api.nvim_win_is_valid(win) then
      return
    end
    vim.api.nvim_set_current_win(win)

    local target_git_dir = picked and vim.fn.FugitiveExtractGitDir(dir .. "/")
      or git_dir
    if target_git_dir == "" then
      vim.notify("No Git repository found for Fugitive.", vim.log.levels.WARN)
      return
    end

    -- Edit the status buffer directly so Fugitive cannot jump to an existing
    -- window showing it. :hide keeps unsaved edits in the previous buffer.
    local status = vim.fn.FugitiveFind(":", target_git_dir)
    vim.cmd.edit({
      args = { status },
      mods = { hide = true },
      magic = { file = false, bar = false },
    })
    vim.wo.foldmarker = "<<<<<<<<,>>>>>>>>"
  end, {
    cwd = type(root) == "string" and root ~= "" and root or nil,
    prompt = "Fugitive worktree",
  })
end

return M
