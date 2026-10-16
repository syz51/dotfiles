-- macOS integration test; requires Skim and Tectonic, and opens a disposable PDF.
-- Run from ~/.config/nvim: nvim --headless -u NONE -i NONE -l tests/vimtex-annotations.lua
assert(jit.os == "OSX", "This test requires macOS")
local dir = vim.fn.tempname() .. " annotation test"
vim.fn.mkdir(dir, "p")
dir = assert(vim.uv.fs_realpath(dir))
local pdf = dir .. "/annotations.pdf"
local tectonic = vim.fn.exepath("tectonic")
assert(tectonic ~= "", "Tectonic must be installed")
-- Leave time to add a note while compilation is in progress.
vim.fn.writefile({ "#!/bin/sh", "sleep 2", "exec " .. vim.fn.shellescape(tectonic) .. ' "$@"' }, dir .. "/tectonic")
vim.fn.setfperm(dir .. "/tectonic", "rwx------")
vim.env.PATH = dir .. ":" .. vim.env.PATH

local function script(name, source)
  vim.fn.writefile(vim.split(source, "\n"), dir .. "/" .. name)
end

script(
  "notes.applescript",
  [[
on run argv
  set pdfPath to item 1 of argv
  set mode to item 2 of argv
  tell application "Skim"
    if mode is "open" then
      open POSIX file pdfPath
      return
    end if
    set d to first document whose path is pdfPath
    if mode is "saved" then
      tell page 2 of d
        make note with properties {type:text note, text:"Saved text note", bounds:{100, 650, 350, 600}}
        make note with properties {type:box note, text:"Saved box note", bounds:{100, 580, 350, 530}}
      end tell
      tell d
        set textSelection to {a reference to characters 1 thru 8 of text of page 2}
        make note with data textSelection with properties {type:highlight note}
      end tell
      save d
      set current page of d to page 2 of d
      set view settings of d to {scale factor:1.2, auto scales:false}
    else if mode is "unsaved" or mode is "during" then
      tell page 2 of d
        make note with properties {type:text note, text:mode & " text note", bounds:{100, 500, 350, 450}}
      end tell
    else if mode is "convert" then
      close d saving no
      set d to open POSIX file pdfPath
      convert notes d waiting true
      save d
    else if mode is "close" then
      close d saving no
    end if
  end tell
end run
]]
)
script(
  "state.js",
  [[
function run(argv) {
  var doc = Application('Skim').documents.whose({file: {_equals: Path(argv[0])}})[0];
  return JSON.stringify({modified: doc.modified(), text: doc.text(), page: doc.currentPage.index(),
    zoom: doc.viewSettings().scaleFactor, notes: doc.notes().map(function(n) {
    return {type: n.type(), text: n.text(), page: n.page.index(), bounds: n.bounds(), color: n.color()};
  })});
}
]]
)
script(
  "embed.js",
  [[
function run(argv) {
  ObjC.import('Foundation');
  ObjC.import('PDFKit');
  var url = $.NSURL.fileURLWithPath(argv[0]);
  var pdf = $.PDFDocument.alloc.initWithURL(url);
  var note = $.PDFAnnotation.alloc.initWithBoundsForTypeWithProperties($.NSMakeRect(100, 600, 24, 24), 'Text', $({}));
  note.contents = 'Embedded note';
  pdf.pageAtIndex(1).addAnnotation(note);
  if (!pdf.writeToURL(url)) throw new Error('Unable to save annotation fixture');
}
]]
)
vim.fn.writefile({
  [[\documentclass{article}]],
  [[\usepackage{hyperref}]],
  [[\begin{document}]],
  [[\href{https://example.com}{A generated link must not block rebuilding.}]],
  [[\newpage]],
  "Annotation fixture: original text.",
  [[\newpage]],
  "Last page.",
  [[\end{document}]],
}, dir .. "/annotations.tex")

dofile("lua/config/options.lua")
vim.g.vimtex_quickfix_mode = 0
vim.g.vimtex_cache_persistent = 0
vim.opt.rtp:prepend(vim.fn.stdpath("data") .. "/lazy/vimtex")
vim.cmd("filetype plugin on")
dofile("lua/config/autocmds.lua")
local started = 0
vim.api.nvim_create_autocmd("User", {
  pattern = "VimtexEventCompileStarted",
  callback = function()
    started = started + 1
  end,
})

local function run(command)
  local result = vim.system(command):wait()
  assert(result.code == 0, result.stderr)
  return result.stdout
end

local function notes(mode)
  run({ "osascript", dir .. "/notes.applescript", pdf, mode })
end

local function state()
  return vim.json.decode(run({ "osascript", "-l", "JavaScript", dir .. "/state.js", pdf }))
end

local function hash()
  return vim.fn.sha256(table.concat(vim.fn.readfile(pdf, "b"), "\n"))
end

local ok, err = xpcall(function()
  vim.cmd.edit(vim.fn.fnameescape(dir .. "/annotations.tex"))
  vim.cmd("setfiletype tex")
  local function build(text, command, during)
    local previous = started
    if text then
      vim.api.nvim_buf_set_lines(0, 5, 6, false, { text })
    end
    vim.cmd(command and "noautocmd silent write" or "silent write")
    if command then
      vim.cmd(command)
    end
    assert(started == previous + 1, "Compilation did not start")
    if during then
      during()
    end
    assert(
      vim.wait(45000, function()
        return vim.b.vimtex.compiler.status == 2
      end, 50),
      "Compilation failed"
    )
  end

  build()
  notes("saved")
  local before = state()
  assert(#before.notes == 3 and not before.modified)
  build("Annotation fixture: saved notes survived.")
  local after = state()
  assert(vim.deep_equal(before.notes, after.notes), "Saved notes changed")
  assert(before.page == after.page and before.zoom == after.zoom, "Page or zoom changed")

  notes("unsaved")
  before = state()
  assert(#before.notes == 4 and before.modified)
  build("Annotation fixture: unsaved notes survived.", "VimtexCompile")
  after = state()
  assert(vim.deep_equal(before.notes, after.notes), "Unsaved notes changed")
  assert(before.page == after.page and before.zoom == after.zoom, "Page or zoom changed")
  assert(not after.modified and after.text:find("unsaved notes survived", 1, true))
  local backup = run({ "skimnotes", "format", "text", dir .. "/annotations.skim", "-" })
  assert(backup:find("unsaved text note", 1, true), "Latest note was not backed up")

  build("Annotation fixture: notes added during compilation survived.", "VimtexCompile", function()
    notes("during")
    before = state()
    assert(#before.notes == 5 and before.modified)
    assert(vim.fn.eval("b:vimtex.compiler.is_running()"), "Fixture compiled before the note was added")
  end)
  after = state()
  assert(vim.deep_equal(before.notes, after.notes), "Notes added during compilation changed")
  assert(not after.modified and after.text:find("during compilation survived", 1, true))

  before = after
  notes("close")
  build("Annotation fixture: closed PDF notes survived.")
  notes("open")
  after = state()
  assert(vim.deep_equal(before.notes, after.notes), "Closed PDF notes changed")
  assert(after.text:find("closed PDF notes survived", 1, true))

  run({ "osascript", "-l", "JavaScript", dir .. "/embed.js", pdf })
  local original, previous = hash(), started
  local notify, message = vim.notify, nil
  vim.notify = function(text)
    message = text
  end
  vim.cmd("silent write")
  vim.notify = notify
  assert(message and message:find("embedded annotations", 1, true), "Unsafe rebuild did not report the problem")
  local compiled, failure = pcall(vim.cmd, "VimtexCompile")
  assert(not compiled and failure:find("embedded annotations", 1, true))
  assert(started == previous and hash() == original, "Embedded annotations were overwritten")

  notes("convert")
  before = state()
  assert(#before.notes == 6, "Embedded note was not converted")
  build("Annotation fixture: converted notes survived.", "VimtexCompileSS")
  after = state()
  assert(vim.deep_equal(before.notes, after.notes), "Converted notes changed")
  assert(after.text:find("converted notes survived", 1, true), "Skim did not reload the rebuilt PDF")
end, debug.traceback)
pcall(notes, "close")
vim.fn["vimtex#compiler#stop_all"]()
vim.cmd("silent! %bwipeout!")
if ok then
  vim.fn.delete(dir, "rf")
else
  print("Failed fixture retained at " .. dir)
end
assert(ok, err)
print("Saved, unsaved and converted Skim notes survived; embedded notes blocked unsafe automatic/manual builds")
