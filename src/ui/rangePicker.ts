/**
 * The Range block shared by the chart and photo pages.
 *
 * A chip per preset picks the window's length and brings it back to the live
 * window ending now, as its "Last …" label says. Previous and Next move the
 * window by its own length, into the past and back. The chosen preset is
 * remembered; how far back the reader stepped is not.
 */

import {
  type RangeId,
  type RangePreset,
  type TimeRange,
  canStepBack,
  clampRange,
  steppedRange,
} from '../model/range.ts';
import { clear, el } from './dom.ts';
import { formatLocal } from './format.ts';

export interface RangePickerOptions {
  presets: readonly RangePreset[];
  defaultId: RangeId;
  /** localStorage key for the chosen preset. */
  storageKey: string;
  /** Which retention bounds how far back Previous goes. */
  kind: 'measurement' | 'photo';
  /** Called after any change of window; the page reloads from range(). */
  onChange: () => void;
}

function readStored(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    // A remembered range is a convenience; the default is always valid.
    return null;
  }
}

function persist(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // As above.
  }
}

export class RangePicker {
  readonly element = el('div', { class: 'filters__row filters__block' });

  private id: RangeId;
  /** Whole windows back from the live one; 0 is live. */
  private steps = 0;
  /** When the reader left the live window; earlier windows count back from it. */
  private anchor = 0;

  constructor(private readonly options: RangePickerOptions) {
    const stored = readStored(options.storageKey);
    this.id = options.presets.some((preset) => preset.id === stored)
      ? (stored as RangeId)
      : options.defaultId;
    this.render();
  }

  private get preset(): RangePreset {
    return this.options.presets.find((preset) => preset.id === this.id) ?? this.options.presets[0]!;
  }

  /** The window to load, clamped to what the API accepts. */
  range(nowSeconds = Date.now() / 1000): TimeRange {
    const window = steppedRange(this.preset.seconds, this.steps, this.anchor, nowSeconds);
    return clampRange(window, this.options.kind, nowSeconds);
  }

  private step(direction: 1 | -1): void {
    const now = Date.now() / 1000;
    if (direction === -1) {
      if (!canStepBack(this.preset.seconds, this.steps, this.anchor, this.options.kind, now)) {
        return;
      }
      if (this.steps === 0) this.anchor = now;
      this.steps += 1;
    } else {
      if (this.steps === 0) return;
      this.steps -= 1;
    }
    this.render();
    this.options.onChange();
  }

  private render(): void {
    clear(this.element);
    const now = Date.now() / 1000;
    const group = el('div', { class: 'filters__group' });
    for (const preset of this.options.presets) {
      group.append(
        el('button', {
          class: 'chip',
          text: preset.label,
          attrs: { type: 'button', 'aria-pressed': String(preset.id === this.id) },
          on: {
            click: () => {
              if (preset.id === this.id && this.steps === 0) return;
              this.id = preset.id;
              this.steps = 0;
              persist(this.options.storageKey, preset.id);
              this.render();
              this.options.onChange();
            },
          },
        }),
      );
    }

    const seconds = this.preset.seconds;
    const back = canStepBack(seconds, this.steps, this.anchor, this.options.kind, now);
    const earlier = steppedRange(
      seconds,
      this.steps + 1,
      this.steps === 0 ? now : this.anchor,
      now,
    );
    const later = this.steps > 0 ? steppedRange(seconds, this.steps - 1, this.anchor, now) : null;

    this.element.append(
      el('span', { class: 'filters__label', text: 'Range' }),
      group,
      el('span', { class: 'filters__spacer' }),
      this.stepButton('← Previous', 'Previous range', back ? earlier : null, () => this.step(-1)),
      this.stepButton('Next →', 'Next range', later, () => this.step(1)),
    );
  }

  /** A step button, titled with the window it leads to and disabled when there is none. */
  private stepButton(
    label: string,
    name: string,
    target: TimeRange | null,
    onClick: () => void,
  ): HTMLButtonElement {
    return el('button', {
      class: 'button',
      text: label,
      attrs: {
        type: 'button',
        'aria-label': name,
        ...(target
          ? { title: `${formatLocal(target.start)} → ${formatLocal(target.end)}` }
          : { disabled: 'disabled' }),
      },
      on: { click: onClick },
    });
  }
}
