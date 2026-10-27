# The docket: context given to each agent, one cell at a time. An issue, a
# file, a model card, a paper, skills from Reflex and a note, each held by
# the agents chosen.
#
#   pnpm demo:docket

Output docs/docket.gif

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
Type "D"
Sleep 2s

# The implementer's column: an issue, the file it names, a model card.
Right
Sleep 500ms
Right
Sleep 700ms
Type "n"
Sleep 600ms
Type "#42"
Sleep 1.4s
Enter
Sleep 1.8s
Type "n"
Sleep 400ms
Type "src/retry.ts"
Sleep 900ms
Enter
Sleep 1.4s
Type "n"
Sleep 400ms
Type "hf:acme/retry-coder"
Sleep 1s
Enter
Sleep 1.6s

# The reviewer's column: a paper, a skill from Reflex, and the issue too.
Right
Sleep 600ms
Type "n"
Sleep 400ms
Type "paper:2408.01234"
Sleep 900ms
Enter
Sleep 1.6s
Type "s"
Sleep 1.6s
Down
Sleep 600ms
Enter
Sleep 1.8s
Down
Sleep 400ms
Down
Sleep 600ms
Type " "
Sleep 1.2s

# The scout gets a skill Reflex had not approved yet; picking it approves it.
Left
Sleep 400ms
Left
Sleep 600ms
Type "s"
Sleep 1.4s
Down
Sleep 400ms
Down
Sleep 700ms
Enter
Sleep 2s

# A note for everyone.
Type "n"
Sleep 400ms
Type "Prefer pnpm over npm. Never adjust a test to pass."
Sleep 700ms
Enter
Sleep 1.4s
Type "a"
Sleep 2.5s
Up
Sleep 500ms
Up
Sleep 500ms
Up
Sleep 2.5s
