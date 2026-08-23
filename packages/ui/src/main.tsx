import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './base.css';
import App from './App.js';
import { resolvePlatform } from './platform/resolve.js';
import { Store } from './store.js';

const container = document.getElementById('root');
if (!container) {
  throw new Error('root element not found');
}

/*
 * Where the shell meets the app.
 *
 * The desktop and Android shells inject their adapter before this module runs;
 * in a browser the resolver falls back to fetch and local storage, so
 * `npm run dev` needs nothing from either shell.
 */
const platform = resolvePlatform();
const store = new Store({ vault: platform.store });

// Never unsubscribed on purpose: the subscription lives exactly as long as the
// page does. On resume the store re-reads the clock, which is the whole point
// on Android, where nothing counted while the app was away.
platform.onResume(() => store.tick());

createRoot(container).render(
  <StrictMode>
    <App store={store} http={platform.http} />
  </StrictMode>,
);
