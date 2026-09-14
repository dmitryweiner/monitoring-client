/**
 * Application shell: masthead, navigation, the notice banner and hash routing.
 *
 * Routing is hash-based because GitHub Pages serves static files and cannot
 * rewrite unknown paths onto one entry point.
 */

import type { MonitoringApi } from '../api/monitoring.ts';
import type { SessionStore } from '../api/session.ts';
import { ChartView } from './chartView.ts';
import { type AppContext, type View, describeError } from './context.ts';
import { DashboardView } from './dashboard.ts';
import { clear, el } from './dom.ts';
import { formatLocal } from './format.ts';
import { LoginView } from './login.ts';
import { PhotosView } from './photos.ts';

interface Route {
  hash: string;
  label: string;
  create: (context: AppContext) => View;
}

const ROUTES: Route[] = [
  { hash: '#/', label: 'Overview', create: (context) => new DashboardView(context) },
  { hash: '#/chart', label: 'Charts', create: (context) => new ChartView(context) },
  { hash: '#/photos', label: 'Photos', create: (context) => new PhotosView(context) },
];

export class App {
  private readonly root: HTMLElement;
  private readonly noticeHost = el('div', { attrs: { role: 'status', 'aria-live': 'polite' } });
  private readonly viewHost = el('div', {});
  private readonly tabs = el('nav', { class: 'tabs', attrs: { 'aria-label': 'Sections' } });
  private readonly sessionNote = el('span', { class: 'stat__note' });
  private readonly signOutButton: HTMLButtonElement;

  private readonly context: AppContext;
  private current: View | null = null;
  private currentHash = '';
  private readonly onHashChange = () => this.render();
  private unsubscribe: (() => void) | null = null;

  constructor(
    root: HTMLElement,
    private readonly api: MonitoringApi,
    private readonly session: SessionStore,
  ) {
    this.root = root;
    this.context = {
      api,
      session,
      notify: (message, tone = 'error') => this.notify(message, tone),
      clearNotice: () => clear(this.noticeHost),
      navigate: (hash) => {
        window.location.hash = hash;
      },
    };

    this.signOutButton = el('button', {
      class: 'button',
      text: 'Sign out',
      attrs: { type: 'button' },
      on: { click: () => void this.signOut() },
    });

    const masthead = el('header', { class: 'masthead' }, [
      el('div', { class: 'masthead__title' }, [
        el('h1', { text: 'Home monitoring' }),
        this.sessionNote,
      ]),
      this.tabs,
      this.signOutButton,
    ]);

    clear(this.root);
    this.root.append(
      el('div', { class: 'app' }, [
        masthead,
        el('main', { class: 'view' }, [this.noticeHost, this.viewHost]),
      ]),
    );

    window.addEventListener('hashchange', this.onHashChange);
    this.unsubscribe = this.session.subscribe(() => this.render());
  }

  start(): void {
    this.render();
  }

  /** Release the window listeners; the page keeps one shell for its lifetime. */
  destroy(): void {
    window.removeEventListener('hashchange', this.onHashChange);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.current?.destroy?.();
    this.current = null;
  }

  private notify(message: string, tone: 'error' | 'warning' | 'info'): void {
    clear(this.noticeHost);
    const className = tone === 'info' ? 'notice' : `notice notice--${tone}`;
    this.noticeHost.append(el('p', { class: className, text: message }));
  }

  private async signOut(): Promise<void> {
    this.signOutButton.disabled = true;
    try {
      // Revoke server-side so the key stops working even if it leaked.
      await this.api.logout();
    } catch (error) {
      this.notify(describeError(error), 'warning');
    } finally {
      this.signOutButton.disabled = false;
      this.session.clear();
    }
  }

  private render(): void {
    const signedIn = this.session.active;
    this.tabs.hidden = !signedIn;
    this.signOutButton.hidden = !signedIn;

    if (!signedIn) {
      this.sessionNote.textContent = 'not signed in';
      this.swap('login', new LoginView(this.context));
      return;
    }

    const expiresAt = this.session.expiresAt;
    this.sessionNote.textContent = expiresAt
      ? `session until ${formatLocal(expiresAt)}`
      : 'signed in';

    const hash = ROUTES.some((route) => route.hash === window.location.hash)
      ? window.location.hash
      : ROUTES[0]!.hash;
    this.renderTabs(hash);

    if (this.currentHash === hash && this.current) return;
    const route = ROUTES.find((item) => item.hash === hash) ?? ROUTES[0]!;
    this.swap(hash, route.create(this.context));
  }

  private renderTabs(activeHash: string): void {
    clear(this.tabs);
    for (const route of ROUTES) {
      const link = el('a', {
        class: 'tab',
        text: route.label,
        attrs: { href: route.hash },
      });
      if (route.hash === activeHash) link.setAttribute('aria-current', 'page');
      this.tabs.append(link);
    }
  }

  private swap(hash: string, view: View): void {
    this.current?.destroy?.();
    clear(this.noticeHost);
    clear(this.viewHost);
    this.current = view;
    this.currentHash = hash;
    this.viewHost.append(view.element);
    view.mount?.();
  }
}
