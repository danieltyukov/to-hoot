# Title bar, footer alignment, and an in-app Claude connector flow

Date: 2026-09-11
Status: approved, ready for implementation planning

Three changes to the 0.4.0 application, shipping together as 0.5.0.

1. The desktop window gets a real title bar of its own, in the shape VS Code
   draws one, instead of borrowing the top row of whichever pane is under it.
2. The footer's two blocks are aligned to each other, and the consistency
   grid's today marker stops eating the gap beside it.
3. The Claude step becomes a flow anyone can follow on a fresh install, on a
   desktop or a phone, with buttons that open the pages the steps refer to.

## 1. Why each of these

**The title bar.** 0.4.0 removed the native decorations and put the three
window controls in the far corner of the day pane's header. That works, and it
leaves three separate top rows: the sidebar's brand with no rule under it, the
task pane's heading with one, and the day pane's heading with one and a
reserved 96px hole at its end. The result is a window whose top edge is three
different things, and pane headers that carry layout rules belonging to the
window rather than to themselves. A single strip across the window is what VS
Code, GNOME and every modern frameless application draws, and it lets the pane
headers go back to being pane headers.

**The footer.** Measured in a real browser at 1280x800: the ring block is
37.33px tall, the label-plus-grid block is 30.94px, and `.app-foot` centres
both. "LAST 14 DAYS" therefore sits about 3px below "TODAY", and the grid sits
below the value beside it. Separately, `.grid-cell[data-today]` draws a 1px
outline at 1.5px offset, which is 2.5px of ring on each side of an 11px cell
sitting in a 3px gap: the ring closes the gap to its neighbour and overhangs
the row's right edge.

**The Claude flow.** Everything needed to reach the task list from Claude on
the web already exists and is tested. What does not exist is a way to set it up
without reading `docs/SETUP.md`: the step prints two blocks of shell commands,
asks for an endpoint URL assembled by hand, and offers no way to reach the
Cloudflare dashboard or Claude's connector settings from inside the app. On a
phone it prints shell commands that cannot be run at all.

## 2. The title bar

A strip across the full width of the window, above the three panes.

```
┌──────────────────────────────────────────────────────────────┐
│ 🦉 to-hoot            Today · to-hoot          ─   □   ✕     │  36px
├──────────┬───────────────────────────────┬───────────────────┤
│ sidebar  │ tasks                         │ day               │
```

- **Left:** the owl mark and the wordmark, the pair that is in the sidebar
  today. The sidebar's own copy is hidden while the window is framed, because
  the brand belongs in one place and the title bar is where VS Code puts it.
- **Centre:** the active view and the app name, muted, at `--fs-mini`,
  absolutely positioned so it is centred on the window rather than on whatever
  space is left between the two ends. Truncates with an ellipsis.
- **Right:** the three window controls, full strip height and square, in the
  proportions VS Code uses. Nothing else changes about them: they are the same
  component calling the same `WindowFrame`, and close still hides to the tray.

The strip is the drag region. A press moves the window, a double press
maximises it, and a press on a control is a press on the control, which is what
`windowGrab` already decides.

**Geometry, not palette.** VS Code's controls are full-height squares with a
hover tint and a red close. This takes the geometry and keeps to-hoot's
palette: the hover is `--hover`, and the close glyph turns `--danger` under the
pointer rather than filling with red. A red fill would need a foreground colour
that reads on it in both themes, and the app has no such token.

**What it removes.** `--window-controls-w` stops being a padding every pane
header has to reserve, so three rules leave `App.css`, including the
sticky-header block that existed only so the controls never floated over a
scrolling row. Pane headers keep `data-window-drag`: a larger grab area costs
nothing and the behaviour is already covered by tests.

**Where it does not appear.** Only when the shell hands over a `WindowFrame`,
which is the same condition the controls already use. A browser tab and the
Android app have chrome of their own; both are unchanged.

## 3. The footer

- Both blocks become the same two-row shape: a `.micro` label on the first row
  and the content on the second, with the two blocks aligned on the row rather
  than centred independently. The ring spans both rows at the left of its
  block, as it does now.
- Today's cell keeps its ring, drawn as an inset box shadow rather than an
  outline, so the mark stays inside the cell's own 11px box. The row's rhythm
  is then 11px cells and 3px gaps all the way across, and the last cell's mark
  no longer overhangs the row.

`styles.test.ts` asserts the 2px radius exception is scoped to `.grid-cell`,
which still holds. The box-shadow is inset, which the border-and-shadow rule
already exempts.

## 4. The Claude connector flow

One component, `StepClaude`, rendered in four places already: the first-run
wizard and Settings, on desktop and on mobile. Improving it improves all four,
which is why nothing new is added to the wizard's step list.

It becomes three numbered stages.

**Stage 1, Claude Code.** Unchanged in substance: the generated
`claude mcp add` line with its real absolute path, and a copy button.

**Stage 2, deploy the endpoint.** The path secret, generated once and stored,
as now. The `wrangler` commands, as now. What is added:

- A sentence saying this stage happens on a computer, which is what makes the
  step honest on a phone rather than a wall of shell nobody can run.
- A button that opens the Cloudflare dashboard, and one that opens the
  project's setup documentation.

The "Deploy to Cloudflare" one-click button is deliberately not used.
Cloudflare treats the linked subdirectory as the root of a new repository and
requires the application to be fully self-contained inside it; `apps/worker`
depends on `@to-hoot/core` through the workspace, so the button would produce a
repository that cannot build. A button that fails silently is worse than a
command that works.

**Stage 3, add it to Claude.** What is added:

- The endpoint URL is composed rather than typed. The user pastes the
  `workers.dev` base URL that `wrangler deploy` printed, and the app appends
  `/mcp/<secret>`. Pasting a URL that already carries the path is recognised
  and not doubled.
- A button that opens Claude's connector settings.
- The existing **Test endpoint** check, which performs a real `tools/list`.

**Opening a URL is a platform capability.** A plain link does nothing in a
Tauri webview, so `Platform` gains an optional `openUrl`. The desktop
implements it with `tauri-plugin-opener`, Android with `@capacitor/browser`,
and the browser with `window.open`. The UI renders an anchor either way and
calls the capability from its click handler when there is one, so a shell that
supplies nothing still has a working link and tests need no new double.

## 5. What is not being changed

| Not doing | Why |
|---|---|
| A menu bar in the title bar | VS Code has one because it is an IDE. A three-pane task list has a sidebar and a settings panel, and File/Edit/View would be empty. |
| Syncing the endpoint URL between devices | It is a credential. Settings are per device deliberately, and the event log is not where a credential goes. |
| The app deploying the Worker itself | It would need a Cloudflare API token pasted into a task app, which is a far more powerful credential than the one it would be protecting. |
| Changing the Worker | It is written, tested, and correct. Nothing here touches `apps/worker`. |

## 6. Testing

- `WindowControls.test.tsx` and a new `TitleBar.test.tsx`: the strip renders
  only when framed, carries the three controls, shows the active view, and
  grabs the window.
- `App.test.tsx`: the existing framed-window suite, updated for the strip and
  for the sidebar brand being hidden while framed.
- `ConsistencyGrid.test.tsx` and `styles.test.ts`: today's mark stays inside
  the cell.
- A Playwright check that the footer's two labels share a baseline, since that
  is a computed-layout fact jsdom cannot answer.
- `setup.test.ts`: composing the endpoint URL from a pasted base, including the
  already-has-the-path case.

## 7. Release

0.5.0, by the flow this project already uses: a branch ending in a
`chore(release): 0.5.0` commit touching the ten version files, a pull request
merged with a merge commit, then an annotated `v0.5.0` tag on the merge commit.
The tag builds the signed APK, the deb and the AppImage on GitHub's runners.
The APK installed on a phone must be that one, because it is signed with the
release keystore and a locally built APK never upgrades over it.
