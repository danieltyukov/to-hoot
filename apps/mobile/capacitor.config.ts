import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.tohoot.app',
  appName: 'to-hoot',
  // `dist` is the staged copy written by `scripts/stage-web.mjs`: the ui build
  // plus this shell's platform adapter. Pointing straight at `packages/ui/dist`
  // would ship the app with no adapter and therefore no network or storage.
  webDir: 'dist',
  plugins: {
    // Routes fetch through the native HTTP stack instead of the WebView, which
    // is what makes the Apps Script calendar bridge reachable: it cannot answer
    // a CORS preflight, so a WebView request to it can never succeed.
    CapacitorHttp: { enabled: true },
  },
};
export default config;
