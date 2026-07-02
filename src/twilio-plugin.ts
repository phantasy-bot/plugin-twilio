import {
  BasePlugin,
  type PlatformCapability,
  type PluginConfig,
  type PluginTool,
} from "@phantasy/agent/plugins";
import {
  createPluginModuleLogger,
  getPluginRuntimeEnv,
  type ServerEnv,
} from "@phantasy/agent/plugin-runtime";

import { handleTwilioPluginEndpoint } from "./twilio-plugin-endpoints";
import { TwilioIntegration, type TwilioConfig } from "./twilio-integration";
import { TwilioBotService } from "./runtime/twilio-bot-service";
import {
  readBoolean,
  readNumber,
  readOptionalString,
  readRequiredString,
  readStringArray,
} from "./runtime/config-helpers";

const log = createPluginModuleLogger("TwilioPlugin");

type TwilioPluginConfig = PluginConfig & Partial<TwilioConfig>;

export class TwilioPlugin extends BasePlugin implements PlatformCapability {
  name = "twilio";
  version = "0.1.0";
  description = "Twilio SMS and MMS messaging integration for Phantasy companions.";

  protected displayName = "Twilio SMS";
  protected category = "messaging";
  protected tags = ["twilio", "sms", "messaging", "phone"];
  protected permissions = ["internet"];
  protected workspace = "business" as const;
  protected extensionKind = "integration" as const;
  protected isPlatform = true;
  protected platformFeatures = {
    messaging: true,
    autonomous: false,
  } as const;
  protected adminSurface = {
    tabId: "twilio",
    label: "Twilio SMS",
    section: "business",
    workspace: "business",
    kind: "generic",
    keywords: ["twilio", "sms", "messaging", "phone"],
    dashboardIcon: "twilio",
  } as const;
  protected configSchema = {
    type: "object",
    properties: {
      enabled: { type: "boolean", default: true, title: "Enabled" },
      autoStart: {
        type: "boolean",
        default: false,
        title: "Auto-start",
        description:
          "Start the Twilio webhook bridge automatically when this integration is enabled.",
      },
      accountSid: { type: "string", title: "Account SID" },
      authToken: { type: "string", title: "Auth token", format: "password" },
      phoneNumber: {
        type: "string",
        title: "Phone number",
        description: "Default Twilio sender number for outbound SMS.",
      },
      messagingServiceSid: {
        type: "string",
        title: "Messaging service SID",
        description: "Optional Twilio Messaging Service SID for pooled senders.",
      },
      webhookUrl: {
        type: "string",
        title: "Webhook URL",
        description:
          "Public webhook URL Twilio should call. Leave blank to derive from PUBLIC_URL.",
      },
      userName: {
        type: "string",
        title: "Bot name",
        description: "Display name used in Chat SDK threads.",
      },
      allowedPhoneNumbers: {
        type: "array",
        title: "Allowed phone numbers",
        items: { type: "string" },
        default: [],
        description: "Optional allowlist of inbound phone numbers.",
      },
      enableAutoReply: {
        type: "boolean",
        default: true,
        title: "Enable auto-reply",
      },
      replyDelay: {
        type: "number",
        default: 0,
        title: "Reply delay (seconds)",
      },
    },
  };

  private botService: TwilioBotService | null = null;
  private lastActivity?: Date;

  getTools(): PluginTool[] {
    return [];
  }

  override async onInit(
    _agentConfig: Record<string, unknown>,
    config?: TwilioPluginConfig,
  ): Promise<void> {
    await super.onInit(_agentConfig, config);
    const runtimeConfig = await this.buildRuntimeConfig();
    if (runtimeConfig) {
      await this.createIntegration().saveConfig(runtimeConfig);
    }

    if (this.isEnabled() && runtimeConfig?.autoStart && !this.botService) {
      const result = await this.startBot();
      if (!result.success) {
        log.warn("Twilio auto-start failed", { message: result.message });
      }
    }
  }

  async startBot(): Promise<{ success: boolean; message?: string }> {
    const runtimeConfig = await this.buildRuntimeConfig();
    if (!runtimeConfig) {
      return {
        success: false,
        message: "Set Twilio account SID and auth token before starting.",
      };
    }

    if (!runtimeConfig.phoneNumber && !runtimeConfig.messagingServiceSid) {
      return {
        success: false,
        message: "Configure a Twilio phone number or messaging service SID.",
      };
    }

    const integration = this.createIntegration();
    const testResult = await integration.testConnection(runtimeConfig);
    if (!testResult.success) {
      return {
        success: false,
        message: testResult.error || "Failed to connect to Twilio",
      };
    }

    const webhookUrl =
      runtimeConfig.webhookUrl || integration.resolveWebhookUrl(runtimeConfig);
    const nextConfig = {
      ...runtimeConfig,
      connected: true,
      webhookUrl,
    };
    await integration.saveConfig(nextConfig);

    if (this.botService) {
      await this.botService.stop();
    }

    this.botService = new TwilioBotService(
      this.getRuntimeEnv(),
      nextConfig,
      webhookUrl,
    );
    await this.botService.start();
    this.lastActivity = new Date();

    return {
      success: true,
      message: testResult.accountFriendlyName
        ? `Connected to Twilio (${testResult.accountFriendlyName})`
        : "Connected to Twilio",
    };
  }

  async stopBot(): Promise<{ success: boolean; message?: string }> {
    if (this.botService) {
      await this.botService.stop();
      this.botService = null;
    }

    const runtimeConfig = await this.buildRuntimeConfig();
    if (runtimeConfig) {
      await this.createIntegration().saveConfig({
        ...runtimeConfig,
        connected: false,
      });
    }

    return {
      success: true,
      message: "Twilio integration stopped",
    };
  }

  async getBotStatus(): Promise<{
    connected: boolean;
    streaming?: boolean;
    autonomousPosting?: boolean;
    lastActivity?: Date;
    error?: string;
    summary?: string;
    configuredChannels?: string[];
    recommendedActions?: string[];
  }> {
    const runtimeConfig = await this.buildRuntimeConfig();
    if (!runtimeConfig) {
      return {
        connected: false,
        streaming: false,
        autonomousPosting: false,
        lastActivity: this.lastActivity,
        error: "Twilio account SID and auth token are not configured",
        summary: "Needs Twilio credentials",
        recommendedActions: [
          "Add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.",
          "Set TWILIO_PHONE_NUMBER or TWILIO_MESSAGING_SERVICE_SID.",
          "Point the Twilio Messaging webhook at /admin/api/plugins/twilio/webhook.",
        ],
      };
    }

    const configuredChannels = Array.from(
      new Set(
        [
          runtimeConfig.phoneNumber,
          runtimeConfig.messagingServiceSid,
          ...runtimeConfig.allowedPhoneNumbers,
        ].filter(Boolean) as string[],
      ),
    );

    if (this.botService) {
      const status = this.botService.getStatus();
      return {
        connected: status.connected,
        streaming: false,
        autonomousPosting: false,
        lastActivity: this.lastActivity,
        summary: status.connected ? "Webhook bridge ready" : "Configured, reconnecting",
        configuredChannels,
        recommendedActions: runtimeConfig.webhookUrl
          ? []
          : ["Set PUBLIC_URL or an explicit webhook URL for inbound SMS."],
      };
    }

    const storedConfig = await this.createIntegration().getConfig();
    const connected = Boolean(storedConfig?.connected);
    return {
      connected,
      streaming: false,
      autonomousPosting: false,
      lastActivity: this.lastActivity,
      error: connected ? undefined : "Twilio bridge is not running",
      summary: connected ? "Configured" : "Configured, not running",
      configuredChannels,
      recommendedActions: [
        "Start the integration after configuring the Twilio Messaging webhook.",
      ],
    };
  }

  async sendMessage(params: {
    content: string;
    channelId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const runtimeConfig = await this.buildRuntimeConfig();
    const recipientPhone = params.channelId;

    if (!runtimeConfig || !recipientPhone) {
      return {
        success: false,
        error: "Twilio recipient phone number is not configured",
      };
    }

    if (!this.botService) {
      return {
        success: false,
        error: "Twilio bridge is not running",
      };
    }

    const result = await this.botService.sendMessage(recipientPhone, params.content, {
      gatewayThreadId:
        typeof params.metadata?.gatewayThreadId === "string"
          ? params.metadata.gatewayThreadId
          : undefined,
      sessionId:
        typeof params.metadata?.sessionId === "string"
          ? params.metadata.sessionId
          : undefined,
    });

    if (result.success) {
      this.lastActivity = new Date();
    }

    return result;
  }

  async onConfigUpdated(newConfig: PluginConfig): Promise<void> {
    await super.onConfigUpdated(newConfig);
    const runtimeConfig = await this.buildRuntimeConfig();
    if (runtimeConfig) {
      await this.createIntegration().saveConfig(runtimeConfig);
    }
  }

  async handleCustomEndpoint(request: Request, path: string): Promise<Response | null> {
    try {
      return handleTwilioPluginEndpoint(this, request, path);
    } catch (error) {
      log.error("Twilio plugin endpoint failed", {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      return new Response(
        JSON.stringify({ success: false, error: "Twilio plugin request failed" }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  }

  getBotService(): TwilioBotService | null {
    return this.botService;
  }

  resolveWebhookUrl(config: TwilioConfig | null): string | undefined {
    if (!config) {
      return undefined;
    }
    return this.createIntegration().resolveWebhookUrl(config);
  }

  async testConnection(
    config: Pick<TwilioConfig, "accountSid" | "authToken">,
  ): Promise<{
    success: boolean;
    error?: string;
    accountFriendlyName?: string;
  }> {
    return this.createIntegration().testConnection(config);
  }

  async buildRuntimeConfig(
    overrides?: Partial<TwilioConfig>,
  ): Promise<TwilioConfig | null> {
    const snapshot = (this.getConfig() || {}) as TwilioPluginConfig;
    const stored = await this.createIntegration().getConfig();
    const runtimeConfig: TwilioConfig = {
      accountSid: readRequiredString(
        overrides?.accountSid,
        snapshot.accountSid,
        stored?.accountSid,
        process.env.TWILIO_ACCOUNT_SID,
      ),
      authToken: readRequiredString(
        overrides?.authToken,
        snapshot.authToken,
        stored?.authToken,
        process.env.TWILIO_AUTH_TOKEN,
      ),
      phoneNumber: readOptionalString(
        overrides?.phoneNumber,
        snapshot.phoneNumber,
        stored?.phoneNumber,
        process.env.TWILIO_PHONE_NUMBER,
      ),
      messagingServiceSid: readOptionalString(
        overrides?.messagingServiceSid,
        snapshot.messagingServiceSid,
        stored?.messagingServiceSid,
        process.env.TWILIO_MESSAGING_SERVICE_SID,
      ),
      webhookUrl: readOptionalString(
        overrides?.webhookUrl,
        snapshot.webhookUrl,
        stored?.webhookUrl,
      ),
      userName: readOptionalString(overrides?.userName, snapshot.userName, stored?.userName),
      allowedPhoneNumbers: readStringArray(
        overrides?.allowedPhoneNumbers,
        snapshot.allowedPhoneNumbers,
        stored?.allowedPhoneNumbers,
      ),
      enableAutoReply:
        typeof overrides?.enableAutoReply === "boolean"
          ? overrides.enableAutoReply
          : typeof snapshot.enableAutoReply === "boolean"
            ? snapshot.enableAutoReply
            : typeof stored?.enableAutoReply === "boolean"
              ? stored.enableAutoReply
              : true,
      replyDelay: readNumber(overrides?.replyDelay, snapshot.replyDelay, stored?.replyDelay, 0),
      autoStart: readBoolean(overrides?.autoStart, snapshot.autoStart, stored?.autoStart),
      connected: stored?.connected,
    };

    if (!runtimeConfig.accountSid || !runtimeConfig.authToken) {
      return null;
    }

    return runtimeConfig;
  }

  private createIntegration(): TwilioIntegration {
    return new TwilioIntegration(this.getRuntimeEnv());
  }

  private getRuntimeEnv(): ServerEnv {
    return getPluginRuntimeEnv() as unknown as ServerEnv;
  }
}

export default TwilioPlugin;
