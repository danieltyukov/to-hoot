# Maestro flows

```
maestro test apps/mobile/e2e/
```

Maestro drives the app through Android's accessibility tree. A Capacitor app is
a WebView, and the WebView publishes its accessible names into that tree, so the
selectors here are the same `aria-label`s and visible strings the ui's own tests
use. A control that loses its label breaks these flows, which is the intended
coupling.

`resume.yaml` spends about seventy seconds waiting and cannot be sped up: it is
measuring what the app does with real elapsed time. Maestro has no sleep
command, so the wait is an `evalScript` busy loop.

Every text assertion is anchored with `^` and `$`. Maestro matches element text
as a regex, and an unanchored clock pattern is satisfied by things that are not
the timer: `0:0` appears inside the Android status bar clock at 10:0x and 20:0x,
and `1:00` inside a timeline hour label. Anchoring is what makes these assert
the row they are meant to.
