# Companies: a whole team in one keystroke, with worktrees chosen for all.
#
#   pnpm demo:company

Output docs/company.gif

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

Sleep 1.2s
Type "n"
Sleep 2.4s
Down
Sleep 1.1s
Down
Sleep 1.1s
Down
Sleep 1.1s
Down
Sleep 1.1s
Down
Sleep 1.3s
Type "1"
Sleep 1.4s

# Worktrees: every agent, nobody, then each agent that writes.
Type "w"
Sleep 1.5s
Type "w"
Sleep 1.5s
Type "w"
Sleep 1.6s

# Hire, then back to the dashboard to see the roster.
Enter
Sleep 2.8s
Escape
Sleep 3.5s
