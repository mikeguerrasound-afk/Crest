/*
 * REAPER link. Crest cannot call into REAPER, so it installs a small ReaScript ("Crest receiver") that keeps
 * running inside REAPER, and drops the file to insert into an inbox file the script polls.
 */
'use strict';
const fs = require('fs');
const path = require('path');

function resourceDir(platform, env, home) {
  if (env && env.CREST_REAPER_DIR) return env.CREST_REAPER_DIR;
  if (platform === 'win32') return path.join((env && env.APPDATA) || path.join(home, 'AppData', 'Roaming'), 'REAPER');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'REAPER');
  return path.join(home, '.config', 'REAPER');
}

const LUA = `-- Crest receiver: inserts the sounds you send from Crest at the edit cursor of the selected track.
-- Run it once (Actions > Show action list > ReaScript: Load...). It keeps running in the background.
local inbox = reaper.GetResourcePath() .. "/crest_inbox.txt"

local function poll()
  local f = io.open(inbox, "r")
  if f then
    local data = f:read("*a")
    f:close()
    os.remove(inbox)
    for line in data:gmatch("[^\\r\\n]+") do
      reaper.Undo_BeginBlock()
      reaper.InsertMedia(line, 0)
      reaper.Undo_EndBlock("Insert from Crest", -1)
      reaper.UpdateArrange()
    end
  end
  reaper.defer(poll)
end

poll()
`;

/** Writes (or refreshes) the receiver script. Returns { file, isNew }. */
function install(dir) {
  const sd = path.join(dir, 'Scripts');
  fs.mkdirSync(sd, { recursive: true });
  const file = path.join(sd, 'Crest_receiver.lua');
  const isNew = !fs.existsSync(file);
  if (isNew || fs.readFileSync(file, 'utf8') !== LUA) fs.writeFileSync(file, LUA);
  return { file, isNew };
}

/** Queues a file for the receiver. */
function enqueue(dir, wavPath) {
  const f = path.join(dir, 'crest_inbox.txt');
  fs.appendFileSync(f, wavPath + '\n');
  return f;
}

module.exports = { resourceDir, install, enqueue, LUA };
