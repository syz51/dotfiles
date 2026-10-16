function! config#vimtex#start(...) abort dict
  if self.is_running() | return | endif
  call config#vimtex#protect(self.get_output_signature('pdf'))

  let l:compiler = vimtex#compiler#_template#new({})
  return call(l:compiler.start, a:000, self)
endfunction

function! config#vimtex#protect(pdf, ...) abort
  let l:result = system([
        \ 'osascript', '-l', 'JavaScript',
        \ stdpath('config') . '/scripts/protect-skim-notes.js',
        \ a:pdf,
        \ a:0 ? a:1 : 'build',
        \ ])
  if v:shell_error
    throw 'Build/refresh stopped to protect PDF annotations: ' . trim(l:result)
  endif
endfunction

function! config#vimtex#refresh(pdf) abort dict
  " Save notes added while the compiler was running before Skim reverts.
  call config#vimtex#protect(a:pdf, 'refresh')
  return call(self.config_skim_callback, [a:pdf], self)
endfunction
