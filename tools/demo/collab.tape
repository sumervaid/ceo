# The collaboration recording: two panes, one org. The right pane is a
# shell, the left is the dashboard. A note posted from the shell lands in
# the coder's run as a new turn, and the trace shows it as it happens.
#
#   tools/demo/fixture.sh org && eval "$(tools/demo/fixture.sh env)" && vhs tools/demo/collab.tape

Output docs/collab.gif

Set Shell bash
Set FontFamily "Menlo"
Set FontSize 14
Set Width 1500
Set Height 820
Set Padding 20
Set Theme { "name": "GitHub Dark", "background": "#0d1117", "foreground": "#e6edf3", "selection": "#264f78", "cursor": "#2f81f7", "black": "#484f58", "red": "#ff7b72", "green": "#3fb950", "yellow": "#d29922", "blue": "#58a6ff", "magenta": "#bc8cff", "cyan": "#39c5cf", "white": "#b1bac4", "brightBlack": "#6e7681", "brightRed": "#ffa198", "brightGreen": "#56d364", "brightYellow": "#e3b341", "brightBlue": "#79c0ff", "brightMagenta": "#d2a8ff", "brightCyan": "#56d4dd", "brightWhite": "#ffffff" }
Set WindowBar Colorful
Set WindowBarSize 40
Set BorderRadius 10
Set Framerate 24
Set TypingSpeed 40ms
Set CursorBlink false

Hide
Type "demo-tmux"
Enter
Sleep 3s
Show

# Right pane: who is working? Nobody yet.
Type "ceo runs"
Enter
Sleep 2s

# Left pane: delegate to the coder.
Ctrl+B
Left
Sleep 800ms
Type "d"
Sleep 1.2s
Down
Sleep 600ms
Type "make the retry test pass ten times in a row"
Sleep 700ms
Enter
Sleep 2.5s

# Right pane: a note for the coder while it works, then watch its trace.
Ctrl+B
Right
Sleep 600ms
Type "ceo post coder 'the flaky path is retry.ts, not client.ts'"
Enter
Sleep 1.5s
Type "ceo runs"
Enter
Sleep 3s

# Left pane: the run pane shows turn 2, with the note delivered.
Ctrl+B
Left
Sleep 9s

# Right pane: the trace and the board, as the org sees them.
Ctrl+B
Right
Sleep 500ms
Type "ceo trace coder 8"
Enter
Sleep 4s
Type "ceo board"
Enter
Sleep 3s
Ctrl+B
Left
Sleep 4s

Hide
Type "tmux -L ceodemo kill-server"
Enter
