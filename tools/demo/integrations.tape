# Integrations: GitHub through gh, Hugging Face with no setup, alerts on the
# bell, the desktop, Slack or a webhook, and Reflex skills. Then an issue
# handed to the chief, and a pull request with the ledger's account.
#
#   pnpm demo:integrations

Output docs/integrations.gif

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
Set TypingSpeed 50ms
Set CursorBlink false

Hide
Type `eval "$(bash tools/demo/fixture.sh env)" && clear && cd $DEMO_PROJECT && ceo ui`
Enter
Sleep 3s
Show

Sleep 1s
Type "I"
Sleep 3.5s

# A test alert on every channel that is on.
Type "t"
Sleep 2.5s
Type "1"
Sleep 1.4s

# Open issues: hand #38 to the chief of staff.
Type "g"
Sleep 2.2s
Down
Sleep 900ms
Type "c"
Sleep 3s
Escape
Sleep 1.2s

# A pull request for the implementer's branch.
Down
Sleep 300ms
Down
Sleep 600ms
Type "P"
Sleep 2.5s
Enter
Sleep 3.5s
