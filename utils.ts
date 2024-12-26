import { readFileSync } from "fs";
import { AutoLoginInfo } from "./types";

export function loadHostKey(path: string): Buffer {
  return readFileSync(path);
}

export function generateWelcomeMessage(
  autoLoginInfo: AutoLoginInfo | null
): string {
  const welcomeMessage = `
    \x1b[35m

    ::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
    ::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
    ::                                                          ::
    ::                                                          ::
    ::                          _   _                   _       ::
    ::     __ _ _   _  ___  ___| |_(_) ___  _ __    ___| |__    ::
    ::    / _\` | | | |/ _ \\/ __| __| |/ _ \\| '_ \\  / __| '_ \\   ::
    ::   | (_| | |_| |  __/\\__ \\ |_| | (_) | | | |_\\__ \\ | | |  ::
    ::    \\__, |\\__,_|\\___||___/\\__|_|\\___/|_| |_(_)___/_| |_|  ::
    ::       |_|                                                ::
    ::                                                          ::
    ::                                                          ::
    ::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
    ::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::                              

    \x1b[0m
    🤖 Welcome to \x1b[1mquestion.sh\x1b[0m. Query LLMs from your terminal.
    
    Conversations are not saved.

    ${
      autoLoginInfo
        ? `\x1b[32mYou are logged in as ${
            autoLoginInfo.username
          }. You have $${autoLoginInfo.credits.toFixed(4)} credits.\x1b[0m`
        : `\x1b[33mYou have $0.1000 credits as a guest. Use /register or /login to get more credits.\x1b[0m`
    }

    Type your message and press Enter. Commands:
    - Type "exit" to quit
    - Type "/help" for all commands
    
`;
  return welcomeMessage;
}

export function generateHelpMessage(): string {
  return `
Available Commands:
  /reset   - Clear conversation history
  /history - Show conversation history
  /stats   - Show session statistics
  /system  - Set system prompt
  /clear   - Clear screen
  /retry   - Retry last message with optional temperature:
             /retry 0.8
  /register - Register a new account
  /login    - Login to an existing account
  /char               - Manage characters (use /char for subcommands)
  /adventure          - Start a text-based RPG adventure
  /model              - List available models or select a model:
                        /model (list models)
                        /model <model_name> (select a model)
  /balance            - Check your current credit balance
  exit     - Exit the session`;
}
