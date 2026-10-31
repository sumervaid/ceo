# The evidence layer: three attempts across providers, one check, one winner
# kept on the evidence, and the merge request that waits with its proof.
#
#   pnpm demo:evidence

Output docs/evidence.gif

Set Shell bash
Set FontFamily "Menlo"
Set FontSize 12
Set Width 1240
Set Height 720
Set Padding 20
Set Theme { "name": "GitHub Dark", "background": "#0d1117", "foreground": "#e6edf3", "selection": "#264f78", "cursor": "#2f81f7", "black": "#484f58", "red": "#ff7b72", "green": "#3fb950", "yellow": "#d29922", "blue": "#58a6ff", "magenta": "#bc8cff", "cyan": "#39c5cf", "white": "#b1bac4", "brightBlack": "#6e7681", "brightRed": "#ffa198", "brightGreen": "#56d364", "brightYellow": "#e3b341", "brightBlue": "#79c0ff", "brightMagenta": "#d2a8ff", "brightCyan": "#56d4dd", "brightWhite": "#ffffff" }
Set WindowBar Colorful
Set WindowBarSize 40
Set BorderRadius 10
Set Framerate 18
Set TypingSpeed 30ms
Set CursorBlink false

Hide
Type `eval "$(bash tools/demo/fixture.sh env)" && clear && demo-evidence`
Enter
Sleep 3s
Show

Sleep 1.2s

# Ask the chief for three attempts with a check.
Type "C"
Sleep 800ms
Type "Fix the flaky retry test. Three attempts across providers, done only when npm test passes."
Sleep 500ms
Enter
Sleep 8s
Escape
Sleep 400ms

# The attempts work around the chief.
Type "O"
Sleep 5s
Escape
Sleep 400ms

# The queue row carries the verdict and the status bar the cost per verified result.
Sleep 7.5s
Type "V"
Sleep 4s
Type "a"
Sleep 2.5s
Escape
Sleep 2s
