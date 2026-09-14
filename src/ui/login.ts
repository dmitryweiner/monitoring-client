/**
 * Sign-in.
 *
 * The admin key is typed once and exchanged for a session; it is never stored
 * and never written to the URL. Only the returned session key is persisted.
 */

import { ApiError } from '../api/client.ts';
import { describeError, type AppContext, type View } from './context.ts';
import { el } from './dom.ts';
import { formatLocal } from './format.ts';

export class LoginView implements View {
  readonly element: HTMLElement;

  private readonly input: HTMLInputElement;
  private readonly submit: HTMLButtonElement;
  private readonly message = el('p', { class: 'login__hint' });
  private busy = false;

  constructor(private readonly context: AppContext) {
    this.input = el('input', {
      attrs: {
        type: 'password',
        name: 'admin-key',
        id: 'admin-key',
        autocomplete: 'current-password',
        required: 'required',
        minlength: '32',
        spellcheck: 'false',
      },
    });
    this.submit = el('button', {
      class: 'button button--primary',
      text: 'Sign in',
      attrs: { type: 'submit' },
    });

    const form = el(
      'form',
      { class: 'login__form', on: { submit: (event) => this.onSubmit(event) } },
      [
        el('label', { text: 'Access key', attrs: { for: 'admin-key' } }),
        this.input,
        this.submit,
        this.message,
      ],
    );

    this.element = el('section', { class: 'login card' }, [
      el('h1', { text: 'Home monitoring' }),
      el('p', {
        class: 'login__hint',
        text: 'Enter the access key to open a session. The session lasts seven days; the key itself is not stored.',
      }),
      form,
    ]);
  }

  mount(): void {
    this.input.focus();
  }

  private onSubmit(event: Event): void {
    event.preventDefault();
    void this.signIn();
  }

  private async signIn(): Promise<void> {
    if (this.busy) return;
    const key = this.input.value.trim();
    if (key.length < 32) {
      this.message.textContent = 'The access key is at least 32 characters long.';
      return;
    }

    this.busy = true;
    this.submit.disabled = true;
    this.message.textContent = 'Signing in…';
    try {
      const session = await this.context.api.login(key);
      this.input.value = '';
      this.context.session.set(session);
      this.message.textContent = `Session valid until ${formatLocal(session.expires_at)}.`;
    } catch (error) {
      this.message.textContent =
        error instanceof ApiError && error.status === 401
          ? 'That key was not accepted.'
          : describeError(error);
    } finally {
      this.busy = false;
      this.submit.disabled = false;
    }
  }
}
