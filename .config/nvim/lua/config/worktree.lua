local M = {}
local did_setup = false

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

local function sync_listed_buffers(prev_path, next_path)
  local skipped = {}
  local prev_root = normalize_path(prev_path)
  local next_root = normalize_path(next_path)
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

    sync_listed_buffers(metadata.prev_path, git_worktree.get_worktree_path(metadata.path))
  end)
end

local function parse_worktrees(output)
  local worktrees = {}
  local current
  local first = true

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
        current = { path = value, primary = first }
        first = false
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

local function list_worktrees(cwd, opts)
  local result = vim.system({ "git", "-C", cwd, "worktree", "list", "--porcelain", "-z" }, opts):wait()
  if result.code ~= 0 then
    return nil, vim.trim(result.stderr or "")
  end
  return parse_worktrees(vim.split(result.stdout, "\0", { plain = true }))
end

local function get_current_root(cwd, opts)
  local result = vim.system({ "git", "-C", cwd, "rev-parse", "--show-toplevel" }, opts):wait()
  if result.code == 0 then
    return (result.stdout:gsub("\n$", ""))
  end
end

local function prioritize_current(worktrees, current_root)
  for i, worktree in ipairs(worktrees) do
    if worktree.path == current_root then
      if i > 1 then
        table.remove(worktrees, i)
        table.insert(worktrees, 1, worktree)
      end
      break
    end
  end
end

local function display_path(path)
  return vim.fn.strtrans(vim.fn.fnamemodify(path, ":~"))
end

function M.select_directory(on_choice, picker_opts)
  picker_opts = picker_opts or {}
  local cwd = picker_opts.cwd or vim.fn.getcwd()
  -- Discover the repository at cwd, not a Git directory inherited from dotfiles config.
  local env = vim.fn.environ()
  env.GIT_DIR = nil
  env.GIT_WORK_TREE = nil
  env.GIT_COMMON_DIR = nil
  local opts = { clear_env = true, env = env }
  local worktrees = list_worktrees(cwd, opts)
  if not worktrees or #worktrees == 0 then
    on_choice(cwd, false)
    return
  end

  local current_root = get_current_root(cwd, opts)
  prioritize_current(worktrees, current_root)
  vim.ui.select(worktrees, {
    prompt = picker_opts.prompt or "Terminal worktree",
    format_item = function(worktree)
      local marker = worktree.path == current_root and "* " or ""
      return marker .. worktree.branch .. "  " .. display_path(worktree.path)
    end,
  }, function(worktree)
    if not worktree then
      return
    end
    if vim.fn.isdirectory(worktree.path) ~= 1 then
      vim.notify("Worktree directory no longer exists: " .. worktree.path, vim.log.levels.WARN)
      return
    end
    on_choice(worktree.path, true)
  end)
end

function M.open_menu()
  local existing = Snacks.picker.get({ source = "worktrees" })[1]
  if existing then
    existing:focus()
    return
  end

  local cwd = vim.fn.getcwd()
  local current_root = get_current_root(cwd)
  local items
  local pending, force_path
  local deleting = false

  local function notice(message, level)
    vim.notify(message, level, { title = "Git Worktrees" })
  end

  local function refresh()
    local worktrees, err = list_worktrees(cwd)
    if not worktrees then
      notice(err, vim.log.levels.ERROR)
      return false
    end
    prioritize_current(worktrees, current_root)
    items = vim.tbl_map(function(worktree)
      worktree.label = worktree.branch == "(detached)" and ("(detached) " .. worktree.sha) or worktree.branch
      worktree.display_path = display_path(worktree.path)
      worktree.text = worktree.label .. " " .. worktree.display_path
      return worktree
    end, worktrees)
    return true
  end

  if not refresh() then
    return
  elseif #items == 0 then
    notice("No git worktrees found", vim.log.levels.INFO)
    return
  end

  local function delete_worktree(picker, item)
    if deleting or not item then
      return
    end
    local path = item.path
    if item.primary or path == current_root then
      pending = nil
      notice("Cannot delete the main or current worktree.", vim.log.levels.WARN)
      return
    end

    local force = force_path == path
    local now = vim.uv.hrtime()
    if not pending or pending.path ~= path or pending.force ~= force or now >= pending.expires then
      pending = { path = path, force = force, expires = now + 2e9 }
      local action = force and "force-delete" or "delete"
      local warning = force and " (discards uncommitted changes)" or ""
      notice("Press Ctrl+X again within 2s to " .. action .. " " .. item.label .. warning, vim.log.levels.WARN)
      return
    end

    pending = nil
    deleting = true
    local args = { "git", "-C", cwd, "worktree", "remove" }
    if force then
      args[#args + 1] = "--force"
    end
    vim.list_extend(args, { "--", path })
    -- Let Git refuse dirty or locked worktrees; do not turn other errors into force requests.
    vim.system(args, { text = true, env = { LC_ALL = "C" } }, vim.schedule_wrap(function(result)
      deleting = false
      local error_text = vim.trim(result.stderr or "")
      if result.code == 0 then
        force_path = nil
        notice("Removed worktree " .. item.label, vim.log.levels.INFO)
      elseif not force and error_text:find("contains modified or untracked files", 1, true) then
        force_path = path
        notice(
          item.label .. " has uncommitted changes. Press Ctrl+X twice to force-delete and discard them.",
          vim.log.levels.WARN
        )
        return
      else
        force_path = nil
        notice(error_text ~= "" and error_text or "Could not remove worktree " .. item.label, vim.log.levels.ERROR)
      end

      if not picker.closed and refresh() then
        picker:refresh()
      end
    end))
  end

  local keys = {
    ["<C-x>"] = { "worktree_delete", mode = { "n", "i" }, desc = "Delete worktree (press twice)" },
    ["<C-c>"] = { "cancel", mode = { "n", "i" } },
  }
  Snacks.picker.pick({
    source = "worktrees",
    title = "Git Worktrees",
    layout = { preset = "select" },
    main = { current = true },
    finder = function() return items end,
    format = function(item)
      return {
        { item.path == current_root and "* " or "  ", "PickerTitle" },
        { item.label },
        { "  " .. item.display_path, "SnacksPickerDir" },
      }
    end,
    actions = { worktree_delete = delete_worktree },
    win = { input = { keys = keys }, list = { keys = keys } },
    on_change = function(_, item)
      if pending and (not item or item.path ~= pending.path) then
        pending = nil
      end
    end,
    on_close = function()
      pending = nil
    end,
    confirm = function(picker, item)
      if deleting or not item then
        return
      end
      if vim.fn.isdirectory(item.path) ~= 1 then
        notice("Worktree directory is missing: " .. item.display_path, vim.log.levels.WARN)
        if refresh() then
          picker:refresh()
        end
        return
      end
      picker:close()
      if item.path ~= current_root then
        -- Let Snacks finish closing its buffers before syncing the editor.
        vim.schedule(function()
          vim.cmd.tcd(item.path)
          vim.cmd.clearjumps()
          sync_listed_buffers(current_root, item.path)
        end)
      end
    end,
  })
end

return M
