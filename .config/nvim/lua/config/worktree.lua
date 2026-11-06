local M = {}
local did_setup = false
local menu_win

local function normalize_path(path)
  if not path or path == "" then
    return nil
  end

  return vim.fn.fnamemodify(path, ":p"):gsub("/+$", "")
end

local function path_relative_to(path, root)
  path = normalize_path(path)
  root = normalize_path(root)
  if not path or not root then
    return nil
  end

  if path == root then
    return ""
  end

  local prefix = root .. "/"
  if path:sub(1, #prefix) == prefix then
    return path:sub(#prefix + 1)
  end
end

local function join_path(root, path)
  root = normalize_path(root)
  if not root then
    return nil
  end

  return path == "" and root or root .. "/" .. path
end

local function file_exists(path)
  return path and vim.fn.filereadable(path) == 1
end

local function buffer_target_path(buf, prev_root, next_root)
  local name = vim.api.nvim_buf_get_name(buf)
  if name == "" or name:find("://", 1, true) then
    return nil
  end

  local relative_path = path_relative_to(name, prev_root)
  if relative_path then
    return join_path(next_root, relative_path)
  end

  if path_relative_to(name, next_root) then
    return normalize_path(name)
  end
end

local function set_windows_to_buffer(old_buf, new_buf)
  for _, win in ipairs(vim.api.nvim_list_wins()) do
    if vim.api.nvim_win_get_buf(win) == old_buf then
      vim.api.nvim_win_set_buf(win, new_buf)
    end
  end
end

local function checktime(buf)
  if not vim.api.nvim_buf_is_loaded(buf) then
    pcall(vim.fn.bufload, buf)
  end

  if vim.api.nvim_buf_is_loaded(buf) then
    vim.api.nvim_buf_call(buf, function()
      vim.cmd("silent! checktime")
    end)
  end
end

local function add_skipped_buffer(skipped, buf)
  local name = vim.api.nvim_buf_get_name(buf)
  name = name ~= "" and vim.fn.fnamemodify(name, ":~:.") or "[No Name]"
  if not skipped[name] then
    skipped[name] = true
    table.insert(skipped, name)
  end
end

local function delete_buffer(buf, skipped)
  if vim.bo[buf].modified then
    add_skipped_buffer(skipped, buf)
    return
  end

  pcall(vim.api.nvim_buf_delete, buf, { force = false })
end

local function sync_buffer_to_worktree(buf, target_path, skipped)
  if vim.bo[buf].modified then
    add_skipped_buffer(skipped, buf)
    return
  end

  local existing = vim.fn.bufnr(target_path)
  if existing ~= -1 and existing ~= buf then
    set_windows_to_buffer(buf, existing)
    checktime(existing)
    delete_buffer(buf, skipped)
    return
  end

  if normalize_path(vim.api.nvim_buf_get_name(buf)) ~= normalize_path(target_path) then
    local ok = pcall(vim.api.nvim_buf_set_name, buf, target_path)
    if not ok then
      delete_buffer(buf, skipped)
      return
    end
  end

  if vim.api.nvim_buf_is_loaded(buf) then
    vim.api.nvim_buf_call(buf, function()
      vim.cmd("silent! edit!")
      vim.cmd("silent! checktime")
    end)
  else
    checktime(buf)
  end
end

local function delete_stale_worktree_buffers(prev_root, skipped)
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    local name = vim.api.nvim_buf_get_name(buf)
    if path_relative_to(name, prev_root) then
      delete_buffer(buf, skipped)
    end
  end
end

local function unlist_empty_fallback_buffers()
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.bo[buf].buflisted and not vim.bo[buf].modified and vim.api.nvim_buf_get_name(buf) == "" then
      local lines = vim.api.nvim_buf_get_lines(buf, 0, 2, false)
      if #lines == 1 and lines[1] == "" then
        vim.bo[buf].buflisted = false
      end
    end
  end
end

local function sync_listed_buffers(git_worktree, metadata)
  local skipped = {}
  local prev_root = normalize_path(metadata.prev_path)
  local next_root = normalize_path(git_worktree.get_worktree_path(metadata.path))
  if not next_root or prev_root == next_root then
    vim.cmd("silent! checktime")
    return
  end

  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.bo[buf].buflisted then
      local target_path = buffer_target_path(buf, prev_root, next_root)
      if file_exists(target_path) then
        sync_buffer_to_worktree(buf, target_path, skipped)
      else
        delete_buffer(buf, skipped)
      end
    end
  end

  delete_stale_worktree_buffers(prev_root, skipped)
  unlist_empty_fallback_buffers()

  if #skipped > 0 then
    vim.notify("Skipped modified buffers: " .. table.concat(skipped, ", "), vim.log.levels.WARN)
  end
end

function M.setup(git_worktree)
  if did_setup then
    return
  end

  did_setup = true
  git_worktree = git_worktree or require("git-worktree")

  git_worktree.on_tree_change(function(op, metadata)
    if op ~= git_worktree.Operations.Switch then
      return
    end

    sync_listed_buffers(git_worktree, metadata)
  end)
end

local function parse_worktrees(output)
  local worktrees = {}
  local current

  local function add_current()
    if current and current.path and not current.bare and vim.fn.isdirectory(current.path) == 1 then
      current.branch = current.branch or "(detached)"
      current.sha = current.sha or ""
      table.insert(worktrees, current)
    end
  end

  for _, line in ipairs(output) do
    if line == "" then
      add_current()
      current = nil
    else
      local key, value = line:match("^(%S+)%s*(.*)$")

      if key == "worktree" then
        add_current()
        current = { path = value }
      elseif current and key == "HEAD" then
        current.sha = value:sub(1, 7)
      elseif current and key == "branch" then
        current.branch = value:gsub("^refs/heads/", "")
      elseif current and key == "detached" then
        current.branch = "(detached)"
      elseif current and key == "bare" then
        current.bare = true
      end
    end
  end

  add_current()
  return worktrees
end

local function get_current_root()
  local output = vim.fn.systemlist({ "git", "rev-parse", "--show-toplevel" })
  if vim.v.shell_error ~= 0 then
    return nil
  end

  return output[1]
end

local function menu_lines(worktrees, current_root)
  local branch_width = 0
  for _, worktree in ipairs(worktrees) do
    branch_width = math.max(branch_width, vim.fn.strdisplaywidth(worktree.branch))
  end

  local lines = {}
  for _, worktree in ipairs(worktrees) do
    local marker = worktree.path == current_root and "*" or " "
    local path = vim.fn.fnamemodify(worktree.path, ":~")
    local line = string.format("%s %-" .. branch_width .. "s  %s", marker, worktree.branch, path)
    table.insert(lines, line)
  end

  return lines
end

function M.open_menu()
  if menu_win and vim.api.nvim_win_is_valid(menu_win) then
    vim.api.nvim_set_current_win(menu_win)
    return
  end

  local git_worktree = require("git-worktree")
  local output = vim.fn.systemlist({ "git", "worktree", "list", "--porcelain" })
  if vim.v.shell_error ~= 0 then
    vim.notify(table.concat(output, "\n"), vim.log.levels.ERROR)
    return
  end

  local worktrees = parse_worktrees(output)
  if #worktrees == 0 then
    vim.notify("No git worktrees found", vim.log.levels.INFO)
    return
  end

  local lines = menu_lines(worktrees, get_current_root())
  local max_width = 0
  for _, line in ipairs(lines) do
    max_width = math.max(max_width, vim.fn.strdisplaywidth(line))
  end

  local width = math.min(math.max(max_width + 2, 50), math.max(vim.o.columns - 4, 20))
  local height = math.min(#lines, math.max(vim.o.lines - 6, 1))
  local row = math.max(math.floor((vim.o.lines - height) / 2) - 1, 0)
  local col = math.max(math.floor((vim.o.columns - width) / 2), 0)

  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].bufhidden = "wipe"
  vim.bo[buf].buftype = "nofile"
  vim.bo[buf].filetype = "git-worktree-menu"
  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false

  local menu_footer = " g<number> switch  <C-j>/<C-k> move  <CR>/<C-l> switch  <C-d> delete  q/<C-c>/<C-x> close "
  local win = vim.api.nvim_open_win(buf, true, {
    relative = "editor",
    style = "minimal",
    border = "rounded",
    title = " Git Worktrees ",
    title_pos = "center",
    footer = menu_footer,
    footer_pos = "center",
    width = width,
    height = height,
    row = row,
    col = col,
  })
  menu_win = win

  vim.wo[win].cursorline = true
  vim.wo[win].number = true
  vim.wo[win].relativenumber = false
  vim.wo[win].signcolumn = "no"
  vim.wo[win].wrap = false

  local pending_goto

  local function clear_pending_goto()
    pending_goto = nil
    if vim.api.nvim_win_is_valid(win) then
      vim.api.nvim_win_set_config(win, { footer = menu_footer })
    end
  end

  local function close_menu()
    pending_goto = nil
    if vim.api.nvim_win_is_valid(win) then
      vim.api.nvim_win_close(win, true)
    end
  end

  local pending_delete
  local force_delete_path
  local deleting = false

  local function set_menu_line(line, text)
    if not vim.api.nvim_buf_is_valid(buf) then
      return
    end

    vim.bo[buf].modifiable = true
    vim.api.nvim_buf_set_lines(buf, line - 1, line, false, { text })
    vim.bo[buf].modifiable = false
  end

  local function clear_pending_delete()
    local pending = pending_delete
    pending_delete = nil
    if pending then
      set_menu_line(pending.line, lines[pending.line])
    end
  end

  local function show_pending_goto()
    if pending_goto and vim.api.nvim_win_is_valid(win) then
      local line = tonumber(pending_goto.digits)
      if line and line >= 1 and line <= #worktrees then
        vim.api.nvim_win_set_cursor(win, { line, 0 })
      end

      vim.api.nvim_win_set_config(win, {
        footer = " Select worktree: " .. pending_goto.digits .. "  <CR> confirm  <Esc> cancel ",
      })
    end
  end

  local switch_selected

  local function finish_goto()
    local pending = pending_goto
    if not pending then
      return
    end

    clear_pending_goto()
    if not vim.api.nvim_win_is_valid(win) or pending.digits == "" then
      return
    end

    local line = tonumber(pending.digits)
    if not line or line < 1 or line > #worktrees then
      vim.notify("Worktree number must be between 1 and " .. #worktrees, vim.log.levels.WARN)
      return
    end

    vim.api.nvim_win_set_cursor(win, { line, 0 })
    switch_selected()
  end

  local function start_goto()
    if deleting then
      return
    end

    clear_pending_delete()
    pending_goto = { digits = "" }
    show_pending_goto()
  end

  local function goto_digit(digit)
    if not pending_goto then
      return digit
    end

    local pending = { digits = pending_goto.digits .. digit }
    pending_goto = pending
    vim.schedule(function()
      if pending_goto == pending then
        show_pending_goto()
      end
    end)
    vim.defer_fn(function()
      if pending_goto == pending then
        finish_goto()
      end
    end, 1000)
    return ""
  end

  local function refresh_menu(selected_line)
    if not vim.api.nvim_win_is_valid(win) or not vim.api.nvim_buf_is_valid(buf) then
      return
    end

    clear_pending_goto()
    local refreshed = vim.fn.systemlist({ "git", "worktree", "list", "--porcelain" })
    if vim.v.shell_error ~= 0 then
      set_menu_line(selected_line, lines[selected_line])
      vim.notify(table.concat(refreshed, "\n"), vim.log.levels.ERROR)
      return
    end

    worktrees = parse_worktrees(refreshed)
    if #worktrees == 0 then
      close_menu()
      return
    end

    lines = menu_lines(worktrees, get_current_root())
    vim.bo[buf].modifiable = true
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
    vim.bo[buf].modifiable = false
    local new_height = math.min(#lines, math.max(vim.o.lines - 6, 1))
    vim.api.nvim_win_set_config(win, {
      relative = "editor",
      height = new_height,
      row = math.max(math.floor((vim.o.lines - new_height) / 2) - 1, 0),
      col = col,
    })
    vim.api.nvim_win_set_cursor(win, { math.min(selected_line, #worktrees), 0 })
  end

  local function refresh_missing_worktrees()
    if not vim.api.nvim_win_is_valid(win) or not vim.api.nvim_buf_is_valid(buf) then
      return
    end

    if not deleting then
      for _, worktree in ipairs(worktrees) do
        if vim.fn.isdirectory(worktree.path) ~= 1 then
          local line = vim.api.nvim_win_get_cursor(win)[1]
          clear_pending_delete()
          refresh_menu(line)
          break
        end
      end
    end

    if vim.api.nvim_win_is_valid(win) then
      vim.defer_fn(refresh_missing_worktrees, 1000)
    end
  end

  vim.defer_fn(refresh_missing_worktrees, 1000)

  local function delete_selected()
    if deleting or not vim.api.nvim_win_is_valid(win) then
      return
    end

    clear_pending_goto()
    local line = vim.api.nvim_win_get_cursor(win)[1]
    local worktree = worktrees[line]
    if not worktree then
      return
    end

    local force = force_delete_path == worktree.path
    if not pending_delete or pending_delete.path ~= worktree.path or pending_delete.force ~= force then
      clear_pending_delete()
      local confirmation = { path = worktree.path, line = line, force = force }
      pending_delete = confirmation
      local prompt = force and "! Press <C-d> again within 2s to FORCE delete " or "! Press <C-d> again within 2s to delete "
      local warning = force and " (discards uncommitted changes)" or ""
      set_menu_line(line, prompt .. worktree.branch .. warning)
      vim.defer_fn(function()
        if pending_delete == confirmation then
          clear_pending_delete()
        end
      end, 2000)
      return
    end

    clear_pending_delete()
    deleting = true
    set_menu_line(line, "Deleting " .. worktree.branch .. "...")
    local callbacks = {
      on_success = function()
        deleting = false
        force_delete_path = nil
        refresh_menu(line)
      end,
      on_failure = vim.schedule_wrap(function()
        deleting = false
        force_delete_path = worktree.path
        set_menu_line(
          line,
          "! Delete failed. Press <C-d> twice to FORCE delete " .. worktree.branch .. " (discards uncommitted changes)"
        )
      end),
    }

    local function remove_worktree()
      git_worktree.delete_worktree(worktree.path, force, callbacks)
    end

    if force then
      remove_worktree()
      return
    end

    -- The plugin raises an error on failure even when on_failure is provided.
    -- Handle dirty worktrees here so the expected refusal stays in the menu.
    vim.system({ "git", "-C", worktree.path, "status", "--porcelain", "--untracked-files=normal" }, {
      text = true,
    }, vim.schedule_wrap(function(result)
      if result.code == 0 and result.stdout ~= "" then
        callbacks.on_failure()
      else
        remove_worktree()
      end
    end))
  end

  switch_selected = function()
    if deleting or not vim.api.nvim_win_is_valid(win) then
      return
    end

    clear_pending_goto()
    local line = vim.api.nvim_win_get_cursor(win)[1]
    local worktree = worktrees[line]
    if not worktree then
      return
    end

    if vim.fn.isdirectory(worktree.path) ~= 1 then
      clear_pending_delete()
      vim.notify(
        "Worktree directory is missing: "
          .. worktree.path
          .. "\nIf it was permanently deleted, review stale entries with `git worktree prune --dry-run`.",
        vim.log.levels.WARN
      )
      return
    end

    close_menu()
    git_worktree.switch_worktree(worktree.path)
  end

  local function move_selection(offset)
    if vim.api.nvim_win_is_valid(win) then
      clear_pending_goto()
      clear_pending_delete()
      local line = vim.api.nvim_win_get_cursor(win)[1]
      line = math.max(1, math.min(#worktrees, line + offset))
      vim.api.nvim_win_set_cursor(win, { line, 0 })
    end
  end

  local function opts(desc)
    return { buffer = buf, silent = true, nowait = true, desc = desc }
  end

  vim.keymap.set("n", "<C-j>", function() move_selection(1) end, opts("Next worktree"))
  vim.keymap.set("n", "<C-k>", function() move_selection(-1) end, opts("Previous worktree"))
  vim.keymap.set("n", "g", start_goto, opts("Select worktree by number"))
  for digit = 0, 9 do
    local key = tostring(digit)
    local digit_opts = opts("Enter worktree number digit")
    digit_opts.expr = true
    vim.keymap.set("n", key, function() return goto_digit(key) end, digit_opts)
  end
  vim.keymap.set("n", "<CR>", function()
    if pending_goto then
      finish_goto()
    else
      switch_selected()
    end
  end, opts("Confirm number or switch worktree"))
  vim.keymap.set("n", "<C-l>", switch_selected, opts("Switch worktree"))
  vim.keymap.set("n", "<C-d>", delete_selected, opts("Delete worktree"))
  vim.keymap.set("n", "q", close_menu, opts("Close"))
  vim.keymap.set("n", "<Esc>", function()
    if pending_goto then
      clear_pending_goto()
    else
      close_menu()
    end
  end, opts("Cancel goto or close"))
  vim.keymap.set("n", "<C-c>", close_menu, opts("Close"))
  vim.keymap.set("n", "<C-x>", close_menu, opts("Close"))
end

return M
