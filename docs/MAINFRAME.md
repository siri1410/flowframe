# Mainframe screens

FlowFrame reads IBM 3270 and AS/400 5250 screens — CICS, IMS, ISPF, green
screens generally — as a first-class case, not as an awkward kind of screenshot.

This exists because mainframe modernisation starts with the same problem every
time: a few hundred terminal screens, no current documentation, and nobody left
who remembers which PF key does what. The screens themselves are the
specification, and they are machine-readable in a way modern UIs are not.

## What FlowFrame does with them

| Job | How |
| --- | --- |
| Recognise a green screen | Dark background, one phosphor hue, regular row pitch — see [ENGINE.md](ENGINE.md) |
| Find the screen name | The wordiest run on the top row, past the transaction id and the date |
| Find the field labels | Runs ending in `:` or a dot-leader trail |
| Find the entry fields | Runs of underscores, and `===>` command lines |
| Keep a subfile together | Consecutive rows whose columns line up merge into one `table` |
| Find the message line | Runs starting with a message id such as `DFHCE3520` or `CPF2817` |
| Read the PF keys | `F3=Exit`, `PF12=Cancel`, `press ENTER` — parsed into actions |
| Name the transitions | A screen offering `F6=Create` produces *"Presses F6 (Create)"* |
| Capture the text | Every word on the screen, kept with the wireframe and exported |

## What you get

For a CICS signon screen, FlowFrame returns:

```
title    CICS/ESA SIGNON
type     terminal
regions  3 titles, 5 texts, 1 label, 1 field, 3 f-keys
actions  ENTER=Confirm, F3=Exit, F5=Refresh, F12=Cancel
text     CESN
         CICS/ESA SIGNON
         CICSPROD
         Type your userid and password, then press ENTER
         Userid . . . . . : ________
         ...
```

Compare that with what the graphical path produced for the same image before
mainframe support existed: *"10 buttons, 7 inputs, 6 blocks"*, no title, no
fields, no keys, no text. The screen has no buttons at all.

## Working with a mainframe application

**One module per transaction or per business function.** `Signon`, `Customer
inquiry`, `Order maintenance`. Modules are the unit of design, and they hand off
to each other in order, which mirrors how a user actually moves through a
mainframe application.

**Add the screens in the order an operator meets them.** That order becomes the
first draft of the flow, and each transition is named after the key the screen
offers.

**Then correct the flow.** The draft chains screens head to tail; a real
application branches. Drag a connection from one node's handle to another,
double-click the line, and name it after the key — `F6=Create`, `Option 2`,
`ENTER on a selected row`. The PF keys FlowFrame read are listed under the
preview, so you can see what a screen offers while you wire it up.

**Watch the two counters** in the bottom-left of the flow canvas. *Exit points*
are screens nothing leaves; *unreachable* are screens with no path from the entry
point. On a mainframe teardown those two numbers are usually where the
undocumented paths are hiding.

**Export the spec.** The Markdown document contains a Mermaid diagram per module,
the numbered steps, the PF keys per screen, and — because text was captured — a
verbatim transcript of every screen under *"What each screen says"*. That
document is readable, diffable and greppable without the screenshots, which is
what makes it useful as a modernisation artefact.

## Asking a model about it

Because the words are captured, the chat has the actual screen content, not just
a shape summary. That means a **text-only** local model is genuinely useful here
— `llama3.1` or `llama2` can answer questions about a mainframe flow without ever
seeing an image, because the transcript is in its context.

Questions that work well:

- *List every PF key across these screens and what each one does.*
- *Which fields on the order screen are required?*
- *Write these screens as a set of user stories.*
- *What would this flow look like as a modern web form?*
- *Which screens can be reached but never left?*

## Limits, honestly

**Recognition is not exact.** `Userid` comes back as `Usexrid`, `0091883` as
`0891883`. It is good enough to read, search and reason about, and not good
enough to feed into a migration script unreviewed.

**Colour attributes are not read.** A real 3270 distinguishes protected from
unprotected fields, and intensified from normal, by colour. FlowFrame infers
fields from shape and text instead. Underlined and underscore-filled fields are
found reliably; a reverse-video input field on a screen with no underscores may
be read as text.

**The grid is inferred, not decoded.** FlowFrame reads a picture of a screen, not
a datastream. If you have access to the 3270 datastream itself, that will always
be more accurate than any screenshot — but it is usually exactly what you do not
have, which is why this path exists.

**Very low-resolution captures struggle.** Terminal glyphs are thin. A screenshot
narrower than about 700px gives the reader little to work with; capture at native
resolution or larger where you can.

**Wide screens are supported** — the column count snaps to 80 or 132, so 27×132
model 5 screens are handled as well as the 24×80 model 2.

## Getting good captures

- Capture the terminal window alone, without the emulator's toolbar and status
  bar. Those become spurious regions at the top and bottom.
- Native resolution or 2×. Do not scale down.
- Any phosphor colour works — green, amber, or white on black.
- PNG rather than JPEG. JPEG artefacts around thin glyphs hurt recognition.
- Keep the whole screen in frame, including the PF-key line at the bottom. That
  line is where the transitions come from, and a capture that clips it loses the
  most valuable row on the screen.
