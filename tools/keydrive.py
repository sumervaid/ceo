#!/usr/bin/env python3
"""Drive the CEO dashboard under a real pty, draining output continuously.

Usage: keydrive.py "<keys>" <cwd> [rows] [cols]

Keys are literal characters plus tokens: <tab> <stab> <enter> <esc> <up> <down>
<left> <right> <ctrl-n> <ctrl-p> <ctrl-l> <pgup> <pgdn>. <line:TEXT> writes TEXT and a newline in one chunk. <wait:N> waits N seconds. <snap> prints the screen so far, labelled.
Environment is inherited, so set CEO_HOME and PATH, with the stub claude, before calling.
"""
import os, pty, time, select, re, fcntl, termios, struct, signal, sys

KEYS = sys.argv[1] if len(sys.argv) > 1 else ""
CWD = sys.argv[2] if len(sys.argv) > 2 else os.getcwd()
ROWS = int(sys.argv[3]) if len(sys.argv) > 3 else 40
COLS = int(sys.argv[4]) if len(sys.argv) > 4 else 120
ENTRY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "dist", "tui", "index.js")

TOKENS = {
    "tab": "\t", "stab": "\x1b[Z", "enter": "\r", "esc": "\x1b",
    "up": "\x1b[A", "down": "\x1b[B", "left": "\x1b[D", "right": "\x1b[C",
    "ctrl-n": "\x0e", "ctrl-p": "\x10", "ctrl-l": "\x0c", "pgup": "\x1b[5~", "pgdn": "\x1b[6~",
}

pid, fd = pty.fork()
if pid == 0:
    os.chdir(CWD)
    os.environ["TERM"] = "xterm-256color"
    os.execvp("node", ["node", ENTRY])

buf = b""
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))


def pump(sec):
    global buf
    dl = time.time() + sec
    while time.time() < dl:
        r, _, _ = select.select([fd], [], [], 0.02)
        if r:
            try:
                c = os.read(fd, 65536)
            except OSError:
                return
            if not c:
                return
            buf += c


def screen():
    t = buf.decode("utf8", "replace")
    # A full-screen clear starts a new frame without a newline. Give it one.
    t = t.replace("\x1b[2J", "\n\x1b[2J")
    t = re.sub(r"\x1b\][^\x07]*\x07", "", t)
    t = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]", "", t)
    t = re.sub(r"\x1b[()][A-Z0-9]", "", t)
    t = t.replace("\r\n", "\n").replace("\r", "\n")
    lines = [l.rstrip() for l in t.split("\n")]
    # Ink re-renders the whole frame. Find the start of the last frame.
    starts = [i for i, l in enumerate(lines) if l.lstrip().startswith("╭")]
    s = starts[-1] if starts else 0
    while s > 0 and lines[s - 1].lstrip().startswith(("╭", "│", "╰")):
        s -= 1
    # Walk back further to catch a banner line above the first box.
    return "\n".join(l for l in lines[s:] if l.strip())


pump(2.5)
i = 0
snap_n = 0
while i < len(KEYS):
    if KEYS[i] == "<":
        j = KEYS.index(">", i)
        tok = KEYS[i + 1:j]
        i = j + 1
        if tok.startswith("wait:"):
            pump(float(tok[5:]))
        elif tok.startswith("sh:"):
            import subprocess
            subprocess.run(tok[3:], shell=True, cwd=CWD)
            pump(0.3)
        elif tok.startswith("line:"):
            # One write, text and newline together, the way a paste arrives.
            os.write(fd, (tok[5:] + "\r").encode())
            pump(0.35)
        elif tok == "snap":
            snap_n += 1
            print(f"===== snapshot {snap_n} =====")
            print(screen())
            buf = b""
            pump(0.3)
        else:
            os.write(fd, TOKENS[tok].encode())
            pump(0.35)
    else:
        os.write(fd, KEYS[i].encode())
        i += 1
        pump(0.25)
pump(1.5)
print("===== final =====")
print(screen())
try:
    os.kill(pid, signal.SIGTERM)
except ProcessLookupError:
    pass
time.sleep(0.3)
os.waitpid(pid, os.WNOHANG)
