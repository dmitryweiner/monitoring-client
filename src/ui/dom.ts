/**
 * DOM helpers.
 *
 * Everything that reaches the page goes through `textContent`: series names,
 * sources and error details come from the API and are treated as untrusted.
 * There is no innerHTML anywhere in this application.
 */

export interface ElementOptions {
  class?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string>;
  on?: Record<string, EventListener>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  children: Array<Node | string | null | undefined> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.title !== undefined) node.title = options.title;
  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    node.setAttribute(name, value);
  }
  for (const [name, handler] of Object.entries(options.on ?? {})) {
    node.addEventListener(name, handler);
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node: Element): void {
  node.replaceChildren();
}

/** A labelled value pair, used by the dashboard cards and the photo metadata. */
export function field(label: string, value: string): HTMLElement {
  return el('span', {}, [`${label} `, el('b', { text: value })]);
}
