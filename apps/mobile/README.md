# to-hoot mobile

A Capacitor 8 shell around the same web application the desktop app runs. It
supplies HTTP that is not subject to CORS, a durable key-value store, OS
notifications, and haptics.

## Build

```
npm install                 # not an npm workspace, deliberately: the Capacitor CLI wants a flat node_modules
npm run apk:debug           # stages, syncs, and assembles a debug APK
```

The APK lands in `android/app/build/outputs/apk/debug/`.

`npm run stage` copies `packages/ui/dist` to `dist/`, bundles `src/platform.ts`
next to it, and inserts a script tag for the adapter ahead of the app's own
module script. `webDir` points at `dist` for that reason: pointing it straight
at the ui package would ship an app with no adapter, and so no network and no
storage.

## Release signing

`android/app/build.gradle` looks for signing material in two places, in order:
environment variables, then a gitignored `keystore.properties` beside the Gradle
project. With neither present the release build stays unsigned rather than
failing, so a fresh checkout still builds.

```
KEYSTORE_PATH=/secure/to-hoot-release.jks KEYSTORE_PASSWORD=... \
KEY_ALIAS=to-hoot KEY_PASSWORD=... npm run apk:release
```

or `apps/mobile/android/keystore.properties`, from
`keystore.properties.example`:

```
storeFile=/secure/to-hoot-release.jks
storePassword=...
keyAlias=to-hoot
keyPassword=...
```

Creating the keystore, once:

```
keytool -genkeypair -v -keystore to-hoot-release.jks -alias to-hoot \
        -keyalg RSA -keysize 4096 -validity 10000
```

Keep it somewhere safe and backed up. Losing it means the app can never be
updated in place again on any device that installed a build signed with it.
`*.jks`, `*.keystore` and `keystore.properties` are gitignored; nothing about a
real key belongs in this repository.

`npm run apk:release` runs `assembleRelease`, which produces an APK. Gradle's
`bundleRelease`, and `cap build android` without `--androidreleasetype APK`,
produce an AAB instead, which the Play Store accepts and a phone cannot
sideload.

## Behaviour worth knowing

**Nothing counts in the background.** Android suspends the WebView within
seconds of the app leaving the foreground. A running timer is stored as a start
time plus a duration and recomputed from the wall clock on `resume`; a JS
interval would come back reading whatever it read on the way out. `e2e/resume.yaml`
is the flow that would catch a regression to one.

**Reminders are scheduled with the OS, inexactly and on purpose.** An exact
alarm needs `SCHEDULE_EXACT_ALARM`, a special access granted in system settings,
and the notification plugin's default is to send the user straight to that
settings screen the first time anything is scheduled. Starting a timer must not
do that, so the adapter passes `isExactNotification: false` and relies on
`allowWhileIdle` to wake the device out of Doze. Android rate-limits those to
roughly one every nine minutes, so a reminder is on time to the minute, not to
the second.

**Background sync is opportunistic, never a guarantee.** WorkManager's periodic
floor is fifteen minutes and Doze stretches it further. This is safe because the
event log is append-only: a late sync merges by replay.

**POST_NOTIFICATIONS is asked for at runtime** on Android 13 and up, and the
answer can be no. A refusal costs the reminders and nothing else.

## Native project

`android/` is committed. The manifest and the signing configuration are source.
Everything Gradle and `cap sync` generate inside it, including the copied web
assets and `capacitor.config.json`, is ignored by the `.gitignore` files
Capacitor wrote there. Run `npx cap sync android` after a fresh clone.
