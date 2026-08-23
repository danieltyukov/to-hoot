import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './base.css';
import App from './App.js';

const container = document.getElementById('root');
if (!container) {
  throw new Error('root element not found');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
