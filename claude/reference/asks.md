# Asks and tasks that wait on the user

These rules are part of the global instructions (`~/.claude/CLAUDE.md`, Work board section) and have the same force. Read them before an `ask_user` call, before you write a task that waits on the user, and when the user asks you to explain an item.

- Before `ask_user`, search memory, the board (other tasks' notes and answered asks), the repositories and related threads for the answer; an ask states what you found and asks only for what remains.
- Open each ask, and the body of each task that waits on my decision or action, with a brief in plain, short sentences: what it is, in one sentence; why it waits on me; the options, each with its consequence; your recommendation. Agent detail goes below the brief. Explain an item I ask about in the same structure, with a diagram only when it involves a flow across several parts.
