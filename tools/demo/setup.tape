# Setup: which providers are ready and whose money each spends, then the
# companies on offer.
#
#   pnpm demo:setup

Output docs/setup.gif

Set Shell bash
Set FontFamily "Menlo"
Set FontSize 14
Set Width 1500
Set Height 760
Set Padding 20
Set Theme { "name": "GitHub Dark", "background": "#0d1117", "foreground": "#e6edf3", "selection": "#264f78", "cursor": "#2f81f7", "black": "#484f58", "red": "#ff7b72", "green": "#3fb950", "yellow": "#d29922", "blue": "#58a6ff", "magenta": "#bc8cff", "cyan": "#39c5cf", "white": "#b1bac4", "brightBlack": "#6e7681", "brightRed": "#ffa198", "brightGreen": "#56d364", "brightYellow": "#e3b341", "brightBlue": "#79c0ff", "brightMagenta": "#d2a8ff", "brightCyan": "#56d4dd", "brightWhite": "#ffffff" }
Set WindowBar Colorful
Set WindowBarSize 40
Set BorderRadius 10
Set Framerate 24
Set TypingSpeed 45ms
Set CursorBlink false

Hide
Type `eval "$(bash tools/demo/fixture.sh env)" && clear && cd $DEMO_PROJECT`
Enter
Sleep 3s
Show

Type "ceo setup"
Sleep 400ms
Enter
Sleep 8s
Type "clear"
Enter
Sleep 300ms
Type "ceo company"
Sleep 400ms
Enter
Sleep 5s
