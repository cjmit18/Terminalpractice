/**
 * Generic command registry shared by the Linux and Windows engines.
 *
 * Each engine owns one registry per shell. Command modules register handlers by name
 * (and aliases); the engine looks the name up and calls the handler with its context.
 */

export type CommandHandler<C, R> = (ctx: C) => R;

export class CommandRegistry<C, R> {
  private readonly handlers = new Map<string, CommandHandler<C, R>>();

  constructor(private readonly caseInsensitive = false) {}

  private key(name: string): string {
    return this.caseInsensitive ? name.toLowerCase() : name;
  }

  /** Registers a handler under one or more names. Later registrations replace earlier ones. */
  register(names: string | string[], handler: CommandHandler<C, R>): this {
    for (const n of Array.isArray(names) ? names : [names]) {
      this.handlers.set(this.key(n), handler);
    }
    return this;
  }

  /** Registers every entry of a name -> handler table. */
  registerAll(table: Record<string, CommandHandler<C, R>>): this {
    for (const [name, handler] of Object.entries(table)) this.register(name, handler);
    return this;
  }

  get(name: string): CommandHandler<C, R> | undefined {
    return this.handlers.get(this.key(name));
  }

  has(name: string): boolean {
    return this.handlers.has(this.key(name));
  }

  names(): string[] {
    return [...this.handlers.keys()];
  }
}
