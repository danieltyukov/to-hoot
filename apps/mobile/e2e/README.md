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

The flows read the Tasks pane, where the day timeline is not on screen. That is
what makes `assertNotVisible: "0:0"` safe to assert: an hour label like 10:00
would otherwise match it.
