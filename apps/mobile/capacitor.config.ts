import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.tohoot.app',
  appName: 'to-hoot',
  webDir: '../../packages/ui/dist',
  plugins: { CapacitorHttp: { enabled: true } },
};
export default config;
