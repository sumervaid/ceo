# The README's first GIF: an empty directory becomes a company, the chief of
# staff is asked for a fix, and agents on claude, codex and gemini work it
# together in the live view. Stubs throughout; nothing bills anyone.
#
#   pnpm demo

Output docs/hero.gif

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
Set TypingSpeed 55ms
Set CursorBlink false

Hide
Type `eval "$(bash tools/demo/fixture.sh env)" && clear && demo-hero`
Enter
Sleep 3s
Show

# An empty directory. n starts an org and opens the company picker.
Sleep 1.5s
Type "n"
Sleep 2.8s

# A worktree for every agent, then hire the software team.
Type "w"
Sleep 1.6s
Enter
Sleep 2.5s

# The chat opens on the chief of staff. Type the request.
Type "Fix the flaky retry test: claude maps the callers, codex writes the fix with a $7 budget, gemini reviews it"
Sleep 800ms
Enter
Sleep 7.5s

# The live view: three providers, one task, notes passing between them.
Escape
Sleep 1s
Type "L"
Sleep 17s
