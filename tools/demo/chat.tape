# The chat recording. One message becomes a team: the chief of staff hires a
# reviewer on gemini, gives the fix to the coder on codex, and both runs
# start when the reply ends. The chief is the claude stub playing a script
# against the real org server, so every hire and task is a real ledger event.
#
#   tools/demo/fixture.sh chat && eval "$(tools/demo/fixture.sh env)" && vhs tools/demo/chat.tape

Output docs/chat.gif

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
Set TypingSpeed 55ms
Set CursorBlink false

Hide
Type `eval "$(bash tools/demo/fixture.sh env)" && clear && demo-chat`
Enter
Sleep 3.5s
Show

# The chief is hired on the way in. Ask who is on the team.
Sleep 2.5s
Type "Who is on the team?"
Sleep 500ms
Enter
Sleep 4.5s

# One message, a team: a hire on gemini, the fix on codex, both started.
Type "Make the flaky retry test pass ten times in a row. Put the fix on codex with $6, and the review on gemini"
Sleep 600ms
Enter
Sleep 10s

# The dashboard: the chief beside the agents, both runs going.
Escape
Sleep 4.5s

# Back to the conversation for a status.
Type "C"
Sleep 1.2s
Type "How is it going?"
Sleep 500ms
Enter
Sleep 6s
