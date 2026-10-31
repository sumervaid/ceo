# The constellation: the chief of staff is asked for a swarm, and twelve
# agents on claude, codex and gemini are born at the horizon, spiral in to
# work, and trade notes as comets around the chief.
#
#   pnpm demo:sky

Output docs/sky.gif

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
Set TypingSpeed 45ms
Set CursorBlink false

Hide
Type `eval "$(bash tools/demo/fixture.sh env)" && clear && demo-sky`
Enter
Sleep 3s
Show

Sleep 800ms
Type "O"
Sleep 3.5s

# Ask the chief for a swarm, then watch it in the sky.
Type "C"
Sleep 1s
Type "Hire a swarm of 12 fixers across claude, codex and gemini, one flaky test each"
Sleep 600ms
Enter
Sleep 5s
Escape
Sleep 300ms
Type "O"
Sleep 4s
Right
Sleep 1.4s
Right
Sleep 1.4s
Right
Sleep 1.4s
Right
Sleep 1.4s
Escape
Sleep 200ms
Type "O"
Sleep 4s
