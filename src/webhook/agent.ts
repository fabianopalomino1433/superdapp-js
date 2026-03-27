import { Message } from '../types';
import { CommandRegistry } from './registry';

export type RequestHandler = (event: Message) => Promise<void>;

export class WebhookAgent {
  private registry: CommandRegistry;

  constructor() {
    this.registry = new CommandRegistry();
  }

  addCommand(command: string, handler: RequestHandler) {
    this.registry.registerCommand(command, handler);
  }

  addCommands(commands: Record<string, RequestHandler>) {
    for (const [cmd, handler] of Object.entries(commands)) {
      this.registry.registerCommand(cmd, handler);
    }
  }

  onMessage(handler: RequestHandler) {
    this.registry.registerMessageHandler(handler);
  }

  async processRequest(body: Message): Promise<void> {
    console.log('🌐 WebhookAgent: Processing request...');
    const message = typeof body === 'string' ? JSON.parse(body) : body;

    // Check for callback queries first
    const callbackQuery = message?.body?.m?.body?.callback_query;
    if (callbackQuery) {
      console.log('🖱️ WebhookAgent: callbackQuery detected:', callbackQuery);
      const callbackHandler = this.registry.getHandler('callback_query');
      if (callbackHandler) {
        console.log('✅ WebhookAgent: Calling callback handler');
        await callbackHandler(message);
        return;
      }
    }

    // Extract message text from the webhook body
    const messageText = message?.body?.m?.text || message?.body?.m?.body || '';
    console.log(`📝 WebhookAgent: Extracted text: "${messageText}"`);

    // Check if this is a command
    const commandHandler = this.registry.getHandler(messageText);
    if (commandHandler) {
      console.log(`🎯 WebhookAgent: Found command handler for "${messageText}"`);
      await commandHandler(message);
      return;
    }

    // If no command handler, use the generic message handler
    console.log('🔄 WebhookAgent: No specific command handler, using generic message handler');
    const messageHandler = this.registry.getMessageHandler();
    if (messageHandler) {
      await messageHandler(message);
    } else {
      console.log('⚠️ WebhookAgent: No message handler registered');
    }
  }
}
