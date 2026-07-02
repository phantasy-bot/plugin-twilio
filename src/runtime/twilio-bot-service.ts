import {
  createPlatformConversationBridge,
  createPluginModuleLogger,
  importEsmModule,
  type PlatformConversationBridgeInboundEvent,
  type ServerEnv,
} from "@phantasy/agent/plugin-runtime";

import type { TwilioConfig } from "../twilio-integration";
import {
  buildTwilioGatewayThreadId,
  normalizePhoneNumber,
} from "./twilio-thread-helpers";

const logger = createPluginModuleLogger("TwilioBotService");

type TwilioBridge = ReturnType<typeof createPlatformConversationBridge>;

export class TwilioBotService {
  private bridge: TwilioBridge | null = null;
  private connected = false;

  constructor(
    private readonly env: ServerEnv,
    private readonly config: TwilioConfig,
    private readonly webhookUrl?: string,
  ) {}

  async start(): Promise<void> {
    if (this.connected) {
      return;
    }

    const bridge = this.getBridge();
    await bridge.initialize();
    this.connected = true;
    logger.info("Twilio messaging bridge initialized");
  }

  async stop(): Promise<void> {
    if (this.bridge) {
      await this.bridge.shutdown();
      this.bridge = null;
    }
    this.connected = false;
    logger.info("Twilio messaging bridge stopped");
  }

  getStatus(): { connected: boolean } {
    return { connected: this.connected };
  }

  async handleWebhook(request: Request): Promise<Response> {
    return this.getBridge().handleWebhook(request);
  }

  async sendMessage(
    recipientPhone: string,
    content: string,
    options: {
      gatewayThreadId?: string;
      sessionId?: string;
      senderPhone?: string;
    } = {},
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const bridge = this.getBridge();
    await bridge.initialize();
    const adapter = bridge.getAdapter();
    const senderPhone = options.senderPhone || this.config.phoneNumber;
    if (!senderPhone) {
      return {
        success: false,
        error: "Twilio sender phone number is not configured",
      };
    }

    const threadId = adapter.encodeThreadId({
      recipient: recipientPhone,
      sender: senderPhone,
    });

    return bridge.sendMessage({
      channelUserId: recipientPhone,
      content,
      gatewayMetadata: {
        phoneNumber: recipientPhone,
        senderPhone,
      },
      gatewayThreadId:
        options.gatewayThreadId || buildTwilioGatewayThreadId(recipientPhone),
      sessionId: options.sessionId,
      threadId,
    });
  }

  private getBridge(): TwilioBridge {
    if (this.bridge) {
      return this.bridge;
    }

    this.bridge = createPlatformConversationBridge({
      adapterKey: "twilio",
      env: this.env,
      platform: "twilio",
      registerDirectHandler: true,
      registerMentionHandler: false,
      registerMessageHandler: false,
      registerSubscribedHandler: false,
      replyDelayMs: Math.max(0, this.config.replyDelay) * 1000,
      stateKeyPrefix: "phantasy-chat-sdk:twilio",
      userName: this.config.userName || "phantasy-twilio",
      createAdapter: async () => {
        const { createTwilioAdapter } = await importEsmModule<{
          createTwilioAdapter: (config: Record<string, unknown>) => unknown;
        }>("@chat-adapter/twilio");

        return createTwilioAdapter({
          accountSid: this.config.accountSid,
          authToken: this.config.authToken,
          phoneNumber: this.config.phoneNumber,
          messagingServiceSid: this.config.messagingServiceSid,
          webhookUrl: this.webhookUrl,
          userName: this.config.userName || "phantasy-twilio",
        }) as never;
      },
      normalizeInboundMessage: (event) => this.normalizeInboundMessage(event),
    });

    return this.bridge;
  }

  private async normalizeInboundMessage(
    event: PlatformConversationBridgeInboundEvent,
  ) {
    const authorId = normalizePhoneNumber(event.message.author.userId);
    const authorName =
      normalizePhoneNumber(event.message.author.userName) ||
      normalizePhoneNumber(event.message.author.fullName) ||
      authorId;

    if (!authorId || !authorName) {
      return null;
    }

    if (
      this.config.allowedPhoneNumbers.length > 0 &&
      !this.config.allowedPhoneNumbers.includes(authorId)
    ) {
      return null;
    }

    if (!this.config.enableAutoReply && event.reason !== "direct") {
      return null;
    }

    const content = String(event.message.text || "").trim();
    if (!content) {
      return null;
    }

    const decoded = event.adapter.decodeThreadId(event.thread.id);
    const senderPhone = normalizePhoneNumber(decoded.sender);
    const recipientPhone = normalizePhoneNumber(decoded.recipient) || authorId;

    return {
      autoSubscribe: true,
      channelId: recipientPhone,
      channelUserId: authorId,
      content,
      gatewayMetadata: {
        phoneNumber: authorId,
        senderPhone,
        recipientPhone,
      },
      gatewayThreadId: buildTwilioGatewayThreadId(authorId),
      source: "twilio:sms",
      threadId: event.thread.id,
      userId: authorId,
      username: authorName,
    };
  }
}
