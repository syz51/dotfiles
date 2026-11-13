# t3code notes (read these first on resume)

Repo copy: $S/repo/t3code (matches checkout, prune_branches.py and settle_children.py diff-clean).
Probes: $S/t3-probes/ (probe_prune_window.py, probe_settle_plan.py; outputs out-*.txt).

## settle_children (machine 11, prior)
- Read in full: settle_children.py (135), tests/test_settle_children.py (257), settle-children.prompt.md (41).
- Plan is a snapshot. Probe probe_settle_plan.py: fresh query [child]; plan printed [child];
  after a running run is inserted, fresh query [], printed plan still [child]; verify printed []. exit 0.
  Confirmed. Consequence depends on T3 refusing an active thread (prompt line 19-20 says T3 refuses). Unverified.
- Suite: tests/test_settle_children.py: Ran 19, OK, exit 0.

## prune_branches (machine 12, prior)
- Read in full: prune_branches.py (534), tests/test_prune_branches.py (992).
- Recheck: fresh read line 360; blocking_reason 373; abandoned restore check 374-375; delete_branch 377.
- Probe probe_prune_window.py (exit 0):
  - control: deleted [t3/late].
  - run starts during delete window: deleted, branch gone, run status running in DB. CONFIRMED.
  - abandoned thread restored during delete window: deleted with archive; branch gone; thread archived_at None. CONFIRMED (work kept in archive ref).
- Suite: tests/test_prune_branches.py: Ran 57, OK, exit 0 (60 s total; slowest single test about 6 s; no one 60 s wait found).
- Lookups have 60 s timeouts (LOOKUP_TIMEOUT_SECONDS line 67). git() helper at 169-178 has no timeout (local git only).
- Test pins: restore during lookups 793-810 (before the 360 read, so not the window). Not pinned: the 360-377 window.

## Remaining (in order)
1. Prior 15-19 and Interactions (prior record lines 156-205) and hooks-scripts-verdicts.md.
2. shell, ghostty, tuios, explore, nvim, cargo, git, setups.toml, bunfig.toml, mpv (conf, script-opts only).
3. git log --since=2026-11-12 --stat per path.
4. LaunchAgent map for t3code, tuios, explore (from SETUP.md, README.md; plists read only).
5. machines.md, probes.md; final reply < 6000 chars.

## shell (read in full: cache.zsh, interactive.zsh, completions.zsh, bin/vp, test-vp-launcher.py, apply-startup-fixes.py, test-startup-fixes.py)
- Cache states/transitions: cache.zsh 49-50 (live fallback), 70-73 (dir create/insecure 74-78), 80-89 (file insecure 82-86, read 88), 90 (signature match -> reuse 117), 91-95 (gen fail: keep old 93, else return 1), 97-103 (tmp write fail), 104-109 (syntax fail keep old 107), 110-115 (mv fail).
- Prior verdict 12 (BY DESIGN) still holds: lines 92-93 and 106-107 match; test-startup-fixes.py 171-183 pins it.
- Non-exported vars excluded: cache.zsh 66; test 258-260 pins. BY DESIGN.
- Switching exported values regenerates each time: test 255-256 pins (calls 6). BY DESIGN (cost only).
- apply-startup-fixes.py: transforms both files first (101-118), then backups (126-130), then os.replace per file (131-141). Not atomic across files.
- Probe probe_partial_install.py (shell-probes/out-partial-install.txt, exit 0): second replace fails -> .zshrc new, .bashrc old; RUN2 fixes .bashrc. CONFIRMED (S). Task: new (check board).
- No test covers a failure after the first replace (test-startup-fixes.py 436-517 tests refusals before writes only).
- vp launcher: shell/bin/vp 3-10 (walk up), 13-23 (ps walk, caller vp), 24-25 (127). test-vp-launcher.py 33-63 pins four cases. ps walk word-splits: a caller path with spaces does not match (untested, unverified impact).
- Board: no open task found for apply-startup-fixes partial install (search "startup" still to run).

## ghostty (read in full: tuios-launcher.py 81, tuios-launcher.sh 3, test-tuios-launcher.py 202, config 18; themes/Nocturne not yet read)
- Launcher states/transitions: lock wait LOCK_EX 30 (no timeout); list ls 32 (timeout 2 s, read_list 14-22); choose attach newest detached 38-41 / new 43 / restore when rc 3 36; spawn 45; confirm poll 46-56 (deadline 15 s 46, 54-55; list-clients errors tolerated 48-51); unlock 57; wait 58; finally terminate/kill 59-66; close 67; main catch 77-81.
- Prior 13 "TimeoutExpired unhandled" REFUTED still holds: main catches SubprocessError at 79.
- Prior 13 "ValueError/KeyError at line 50" still holds, line now 49-51 (catches CalledProcessError, TimeoutExpired only). Probe probe_listclients.py (ghostty-probes/out-listclients.txt, exit 0): empty reply -> rc 1 in 0.07 s, client killed; row without keys -> rc 1 in 0.08 s with "'pid'". CONFIRMED (S, latent). Task dotfiles-444 holds it.
- Prior 13 cited test :189 for "list-clients errors ignored for 15 s": WRONG. Test 189-198 pins the deadline and lock release, not list-clients tolerance. No test pins 48-51. Verdict: BY DESIGN (comment 51), not pinned.
- Test pins: concurrency 138-157, latest detached 159-167, all attached 169-173, bad listing 175-181, failed client releases 183-187, deadline 189-198.
- Lock file ghostty/tuios-launcher.lock (0 bytes) is tracked in git (git ls-files). Check: git ls-files --error-unmatch.

## tuios install-fork + wrapper (read: install-fork.sh 61, bin/tuios 12, tests/test_install_fork.py 116)
- States: go check 15-18; legacy migration 20-23; dirty refuse 26-29 (exit 1); fetch+checkout+ff-only 30-34 (diverged -> set -e exit, binary kept); clone 36 (src absent or empty); build tuios.new 42-47; mv 48; link 52-58 (regular file -> .bak 55, overwrites an older .bak); version check 60.
- Test pins: migration + repeat 76-84; remote ff 86-92; divergence keeps binary 94-104; dirty 106-112. Clone branch (36) NOT pinned.
- Probe tuios-probes/out-clone-branch.txt (copy with local remote, fake go, exit 0 shell wrapper): non-empty src w/o .git -> exit 128 "already exists and is not an empty directory", stray file kept, no install. CONFIRMED (S, fails safe). Prior 15 still holds. Task dotfiles-444 item (3).
- Unverified: two concurrent install-fork runs share tuios.new and no lock (not run).
- bin/tuios: fork if executable (7), else brew (8-10), else 127 (11-12). A broken fork (executable but failing) does not fall back: by design (wrapper header 2-4).
