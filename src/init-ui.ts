import { confirm, intro, isCancel, log, multiselect, note, outro, select, text } from '@clack/prompts';
import { clearLine, cursorTo } from 'node:readline';
import { styleText } from 'node:util';
import { wrapAnsi } from 'fast-wrap-ansi';
import type { InputError } from './errors.js';
import type { Output } from './output.js';

export type Choice = { value: string; label: string; hint?: string };
export type SetupPrompts = Pick<InitUI, 'select' | 'confirm' | 'text'>;

/** One prompt owner and visual style for the interactive setup session. */
export class InitUI {
  private controller = new AbortController();
  private abort = () => this.controller.abort();
  private get options() {
    // Clack retains a prompt's abort listener; use a dependent signal per prompt.
    return { input: process.stdin, output: process.stderr, signal: AbortSignal.any([this.signal]) };
  }

  constructor(private output: Output, private canceled: () => InputError) {
    process.on('SIGINT', this.abort);
  }

  get signal() { return this.controller.signal; }

  private safe(value: string) {
    return this.output.safeDiagnostic(value);
  }

  private label(value: string) {
    return this.safe(value).replace(/[\r\n\t]/g, ' ');
  }

  private value<T>(value: T | symbol): T {
    if (isCancel(value)) { this.abort(); throw this.canceled(); }
    return value as T;
  }

  start() {
    intro(styleText(['bold', 'cyan'], 'LambdaDB'), this.options);
    log.message('Connect a project. Set up your coding agents.', this.options);
  }

  info(message: string) {
    const width = Math.max(20, (process.stderr.columns || 80) - 3);
    // Preserve URL tokens for copying; the terminal can soft-wrap long links.
    const lines = this.safe(message).split('\n').map(line => /https?:\/\/\S+/.test(line)
      ? line : wrapAnsi(line, width, { hard: true }));
    log.info(lines.join('\n'), this.options);
  }
  note(message: string, title: string) { note(this.safe(message), title, this.options); }

  async select(message: string, choices: Choice[], initialValue?: string): Promise<string> {
    return this.value<string>(await select({ ...this.options, message: this.label(message), initialValue,
      options: choices.map(choice => ({ ...choice, label: this.label(choice.label), ...(choice.hint ? { hint: this.label(choice.hint) } : {}) })),
    }));
  }

  async confirm(message: string, initialValue = false): Promise<boolean> {
    return this.value<boolean>(await confirm({ ...this.options, message: this.label(message), initialValue }));
  }

  async text(message: string, defaultValue?: string, validate?: (value: string) => string | undefined): Promise<string> {
    const value = this.value<string>(await text({ ...this.options, message: this.label(message), defaultValue, placeholder: defaultValue,
      validate: validate ? value => validate(value ?? '') : undefined,
    })).trim();
    return value || defaultValue || '';
  }

  async agents(choices: Choice[]): Promise<string[]> {
    for (;;) {
      const selected = this.value<string[]>(await multiselect({ ...this.options,
        message: 'Coding agents (Space: select one or more; Enter: confirm)',
        options: choices, initialValues: [], required: false, maxItems: choices.length,
      }));
      if (selected.length) return selected;
      const action = await this.select('No agents selected', [
        { value: 'back', label: 'Return to agent selection' },
        { value: 'skip', label: 'Skip agent setup' },
      ], 'back');
      if (action === 'skip') return [];
    }
  }

  async verify<T>(action: () => Promise<T>): Promise<T> {
    // Progress must not take ownership of stdin or change CLI cancellation codes.
    let frame = 0, rendered = false;
    const frames = ['◒', '◐', '◓', '◑'];
    const timer = setInterval(() => {
      cursorTo(process.stderr, 0);
      clearLine(process.stderr, 0);
      process.stderr.write(`${styleText('cyan', frames[frame++ % frames.length]!)}  Verifying connection`);
      rendered = true;
    }, 100);
    const stop = () => {
      clearInterval(timer);
      if (rendered) { cursorTo(process.stderr, 0); clearLine(process.stderr, 0); }
    };
    try {
      const value = await action();
      stop();
      log.step('Authentication and collection access verified', this.options);
      return value;
    } catch (error) {
      stop();
      log.error('Connection verification failed', this.options);
      throw this.signal.aborted ? this.canceled() : error;
    }
  }

  finish(message = 'Setup complete') { outro(message, this.options); }
  dispose() {
    process.removeListener('SIGINT', this.abort);
  }
}
