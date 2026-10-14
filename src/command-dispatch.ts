import { CliError } from "./errors.js";
import * as commands from "./commands.js";
import { withOperation, type InteractionSession } from "./operation.js";
import { commandInput } from "./command-input.js";

const handlers: Record<string, (args: string[]) => Promise<unknown>> = {
  home: commands.home, chats: commands.chats, read: commands.read, send: commands.send,
  edit: commands.edit, react: commands.react, doctor: commands.doctor, activity: commands.activity,
  search: commands.search, wait: commands.wait, watch: commands.watch, presence: commands.presence,
  people: commands.people, calls: commands.calls, calendar: commands.calendar, attachments: commands.attachments,
};
export function dispatchCommand(command: string, args: string[], owner?: InteractionSession, stdin?: string) {
  if (!Object.hasOwn(handlers, command)) throw new CliError("Unknown session command", "VALIDATION_ERROR");
  return commandInput.run(stdin, () => withOperation(command, () => handlers[command](args), owner));
}
