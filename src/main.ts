/** Entry point: wire the session, the API client and the shell together. */

import './style.css';

import { ApiClient } from './api/client.ts';
import { MonitoringApi } from './api/monitoring.ts';
import { SessionStore } from './api/session.ts';
import { API_BASE } from './config.ts';
import { App } from './ui/app.ts';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('the application root element is missing');

const session = new SessionStore();
const client = new ApiClient({
  baseUrl: API_BASE,
  getToken: () => session.token,
  // A rejected session sends the reader back to the sign-in form immediately.
  onUnauthorized: () => session.clear(),
});

new App(root, new MonitoringApi(client), session).start();
