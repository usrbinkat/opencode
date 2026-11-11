-- Run with: nvim --clean --headless --cmd 'set rtp+=sdks/neovim' -l sdks/neovim/test/navigation.lua
local navigation = require("opencode.navigation")
local socket = vim.fn.tempname()
local listener = assert(vim.uv.new_pipe(false))
local peers = {}
local received = {}
local function press(keys)
  vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes(keys, true, false, true), "mtx", false)
end
assert(listener:bind(socket))
assert(listener:listen(8, function(err)
  assert(not err, err)
  local peer = assert(vim.uv.new_pipe(false))
  peers[#peers + 1] = peer
  assert(listener:accept(peer))
  local pending = ""
  assert(peer:read_start(function(read_error, bytes)
    assert(not read_error, read_error)
    if not bytes then
      if not peer:is_closing() then peer:close() end
      return
    end
    pending = pending .. bytes
    if #pending < 4 then return end
    local a, b, c, d = pending:byte(1, 4)
    local size = ((a * 256 + b) * 256 + c) * 256 + d
    if #pending < size + 4 then return end
    received[#received + 1] = vim.json.decode(pending:sub(5, size + 4))
    local response = '{"type":"ok"}'
    assert(peer:write(string.char(0, 0, 0, #response) .. response))
    peer:read_stop()
  end))
end))

local ok, failure = xpcall(function()
  vim.env.OPENCODE_PTY_CONTROL_SOCKET = nil
  local standalone = vim.fn.maparg("<C-h>", "n")
  navigation.setup()
  assert(vim.fn.maparg("<C-h>", "n") == standalone, "standalone mappings changed")
  vim.env.OPENCODE_PTY_CONTROL_SOCKET = socket
  vim.env.OPENCODE_PTY_CONTROL_TOKEN = nil
  vim.env.OPENCODE_PTY_ID = nil
  navigation.setup()
  assert(vim.fn.maparg("<C-h>", "n") == standalone, "socket-only capability installed mappings")
  vim.env.OPENCODE_PTY_CONTROL_TOKEN = "test-child"
  navigation.setup()
  assert(vim.fn.maparg("<C-h>", "n") == standalone, "missing terminal ID installed mappings")
  vim.env.OPENCODE_PTY_ID = "invalid"
  navigation.setup()
  assert(vim.fn.maparg("<C-h>", "n") == standalone, "invalid terminal ID installed mappings")
  vim.env.OPENCODE_PTY_ID = "42"
  navigation.setup()
  local child = vim.fn.jobstart({ vim.v.progpath, "--clean", "--embed", "--headless", "-i", "NONE" }, { rpc = true })
  assert(child > 0, "could not start escape-test Neovim")
  local function rpc(method, ...) return vim.rpcrequest(child, method, ...) end
  local tested, escape_error = pcall(function()
    rpc("nvim_ui_attach", 80, 24, {})
    rpc("nvim_exec_lua", [[
      vim.opt.rtp:prepend(...)
      local navigation = require("opencode.navigation")
      navigation.setup()
      _G.navigation_calls = 0
      navigation.navigate = function() _G.navigation_calls = _G.navigation_calls + 1 end
    ]], { vim.fn.getcwd() .. "/sdks/neovim" })
    for _, mode in ipairs({ "i", "t" }) do
      if mode == "t" then rpc("nvim_command", "terminal cat") end
      rpc("nvim_input", "i")
      assert(vim.wait(2000, function() return rpc("nvim_get_mode").mode == mode end), "failed to enter " .. mode)
      rpc("nvim_input", "<C-\\><C-n>")
      assert(vim.wait(2000, function() return rpc("nvim_get_mode").mode:sub(1, 1) == "n" end), "escape did not leave " .. mode)
      assert(rpc("nvim_exec_lua", "return _G.navigation_calls", {}) == 0, mode .. " escape invoked navigation")
    end
  end)
  vim.fn.jobstop(child)
  if not tested then error(escape_error) end
  for _, mode in ipairs({ "n", "i", "t" }) do
    for _, key in ipairs({ "h", "j", "k", "l" }) do
      assert(vim.fn.maparg("<C-" .. key .. ">", mode) ~= "", "missing " .. mode .. " mapping")
    end
  end
  vim.cmd("vsplit")
  vim.cmd("wincmd h")
  local left = vim.api.nvim_get_current_win()
  press("<C-l>")
  local right = vim.api.nvim_get_current_win()
  assert(left ~= right, "internal right navigation failed")
  assert(#received == 0, "internal move escaped to OpenCode")
  press("<C-\\>")
  assert(vim.api.nvim_get_current_win() == left, "previous window was not restored")
  press("i<C-l><Esc>")
  assert(vim.api.nvim_get_current_win() == right, "insert-mode internal navigation failed")
  press("i<C-l><Esc>")
  assert(vim.wait(2000, function() return #received == 1 end), "boundary request missing")
  assert(vim.api.nvim_get_current_win() == right, "boundary changed editor window")
  assert(received[1].token == "test-child", "child credential missing")
  assert(received[1].request.id == 42, "wrong terminal identity")
  assert(received[1].request.op == "notify_controller", "wrong operation")
  assert(received[1].request.message == "pane.navigate.right", "wrong direction")
  vim.cmd("only")
  for _, direction in ipairs({ "h", "j", "k", "l", "p" }) do
    press("<C-" .. (direction == "p" and "\\" or direction) .. ">")
  end
  assert(vim.wait(2000, function() return #received == 6 end), "single-window boundaries missing")
  vim.cmd("enew")
  vim.cmd("terminal cat")
  local terminal = vim.api.nvim_get_current_buf()
  vim.keymap.set("t", "<Esc>", "<C-\\><C-n>")
  for _, key in ipairs({ "h", "j", "k", "l" }) do
    local count = #received
    press("i<C-" .. key .. "><Esc>")
    assert(vim.wait(2000, function() return #received == count + 1 end),
      "terminal-mode boundary missing for " .. key)
  end
  vim.cmd("vsplit")
  vim.cmd("wincmd h")
  local terminal_left = vim.api.nvim_get_current_win()
  press("i<C-l><Esc>")
  assert(vim.api.nvim_get_current_win() ~= terminal_left, "terminal-mode internal navigation failed")
  assert(#received == 10, "terminal-mode internal move escaped to OpenCode")
  vim.cmd("only")
  vim.cmd("bdelete! " .. terminal)
end, debug.traceback)

listener:close()
for _, peer in ipairs(peers) do
  if not peer:is_closing() then peer:close() end
end
vim.uv.fs_unlink(socket)
if not ok then error(failure) end
print("Neovim internal windows, previous window, child identity, and boundary transport passed")
