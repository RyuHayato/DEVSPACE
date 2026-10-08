/**
 * Entry point.
 *
 * Fonts are bundled rather than fetched from a CDN: this is a local-first
 * desktop application and must render correctly with no network at all.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@fontsource-variable/archivo';
import '@fontsource-variable/instrument-sans';
import '@fontsource-variable/jetbrains-mono';

import '@/styles/tokens.css';
import '@/styles/base.css';
import '@/styles/app.css';

import { App } from './App';

const container = document.getElementById('root');
if (!container) throw new Error('index.html is missing its #root element.');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
