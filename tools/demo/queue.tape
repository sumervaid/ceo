# The queue: delegate now, queue more, and auto-dispatch. Every run settles
# with its cost.
#
#   pnpm demo:queue

Output docs/queue.gif

Set Shell bash
Set FontFamily "Menlo"
Set FontSize 14
Set Width 1500
Set Height 860
Set Padding 20
Set Theme { "name": "GitHub Dark", "background": "#0d1117", "foreground": "#e6edf3", "selection": "#264f78", "cursor": "#2f81f7", "black": "#484f58", "red": "#ff7b72", "green": "#3fb950", "yellow": "#d29922", "blue": "#58a6ff", "magenta": "#bc8cff", "cyan": "#39c5cf", "white": "#b1bac4", "brightBlack": "#6e7681", "brightRed": "#ffa198", "brightGreen": "#56d364", "brightYellow": "#e3b341", "brightBlue": "#79c0ff", "brightMagenta": "#d2a8ff", "brightCyan": "#56d4dd", "brightWhite": "#ffffff" }
Set WindowBar Colorful
Set WindowBarSize 40
Set BorderRadius 10
Set Framerate 24
Set TypingSpeed 45ms
Set CursorBlink false

Hide
Type `eval "$(bash tools/demo/fixture.sh env)" && clear && cd $DEMO_PROJECT && ceo ui`
Enter
Sleep 3s
Show

Sleep 1s
Type "n"
Sleep 1.5s
Enter
Sleep 1.5s
Escape
Sleep 1.2s

# Delegate to the implementer, on codex.
Down
Sleep 300ms
Down
Sleep 500ms
Type "d"
Sleep 1.3s
Type "find the root cause of the flaky retry test and fix it"
Sleep 700ms
Enter
Sleep 6s

# Queue two more, then let the dispatcher run them.
Type "t"
Sleep 1s
Type "add exponential backoff to fetchWithRetry"
Sleep 500ms
Enter
Sleep 1s
Type "t"
Sleep 1s
Type "add a regression test for the backoff reset"
Sleep 500ms
Enter
Sleep 1.2s
Type "A"
Sleep 11s
