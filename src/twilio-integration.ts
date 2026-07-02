import {
  AGENT_DEFAULTS,
  createPluginModuleLogger,
  fetchWithTimeout,
  kvService,
  type ServerEnv,
} from "@phantasy/agent/plugin-runtime";

import {
  readBoolean,
  readNumber,
  readOptionalString,
  readStringArray,
} from "./runtime/config-helpers";

const logger = createPluginModuleLogger("TwilioIntegration");

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  phoneNumber?: string;
  messagingServiceSid?: string;
  webhookUrl?: string;
  userName?: string;
  allowedPhoneNumbers: string[];
  enableAutoReply: boolean;
  replyDelay: number;
  autoStart?: boolean;
  connected?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getNestedRecord(value: unknown, key: string): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }

  const next = value[key];
  return isRecord(next) ? next : {};
}

function normalizeTwilioConfig(config: Partial<TwilioConfig>): TwilioConfig {
  return {
    accountSid: readOptionalString(config.accountSid) || "",
    authToken: readOptionalString(config.authToken) || "",
    phoneNumber: readOptionalString(config.phoneNumber),
    messagingServiceSid: readOptionalString(config.messagingServiceSid),
    webhookUrl: readOptionalString(config.webhookUrl),
    userName: readOptionalString(config.userName),
    allowedPhoneNumbers: readStringArray(config.allowedPhoneNumbers),
    enableAutoReply: readBoolean(config.enableAutoReply) || true,
    replyDelay: readNumber(config.replyDelay, 0),
    autoStart: readBoolean(config.autoStart),
    connected: readBoolean(config.connected),
  };
}

function getTwilioIntegrationConfig(agent: unknown): Partial<TwilioConfig> | undefined {
  const integrations = getNestedRecord(agent, "integrations");
  const twilio = getNestedRecord(integrations, "twilio");
  if (Object.keys(twilio).length === 0) {
    return undefined;
  }

  return normalizeTwilioConfig(twilio as Partial<TwilioConfig>);
}

export class TwilioIntegration {
  constructor(private readonly env: ServerEnv) {}

  async getConfig(): Promise<TwilioConfig | null> {
    try {
      const storedConfig = await kvService.get("integration:twilio");
      const config =
        isRecord(storedConfig) && Object.keys(storedConfig).length > 0
          ? normalizeTwilioConfig(storedConfig as Partial<TwilioConfig>)
          : getTwilioIntegrationConfig(await kvService.get(AGENT_DEFAULTS.ID));

      if (!config.accountSid || !config.authToken) {
        return null;
      }

      return config;
    } catch (error) {
      logger.error("Failed to get Twilio config:", error);
      return null;
    }
  }

  async saveConfig(config: TwilioConfig): Promise<boolean> {
    try {
      const normalizedConfig = normalizeTwilioConfig(config);
      if (!normalizedConfig.accountSid || !normalizedConfig.authToken) {
        throw new Error("Twilio account SID and auth token are required");
      }

      await kvService.set("integration:twilio", normalizedConfig);

      const agent = (await kvService.get(AGENT_DEFAULTS.ID)) as Record<string, unknown> | null;
      if (agent) {
        const integrations = getNestedRecord(agent, "integrations");
        agent.integrations = {
          ...integrations,
          twilio: normalizedConfig,
        };
        await kvService.set(AGENT_DEFAULTS.ID, agent);
      }

      return true;
    } catch (error) {
      logger.error("Failed to save Twilio config:", error);
      return false;
    }
  }

  async testConnection(
    config: Pick<TwilioConfig, "accountSid" | "authToken">,
  ): Promise<{
    success: boolean;
    error?: string;
    accountFriendlyName?: string;
  }> {
    const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64");

    try {
      const response = await fetchWithTimeout(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}.json`,
        {
          headers: {
            Authorization: `Basic ${auth}`,
          },
        },
        10_000,
      );

      if (!response.ok) {
        return {
          success: false,
          error: `Twilio API returned ${response.status}`,
        };
      }

      const payload = (await response.json()) as { friendly_name?: string };
      return {
        success: true,
        accountFriendlyName:
          typeof payload.friendly_name === "string" ? payload.friendly_name : undefined,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  resolveWebhookUrl(config: TwilioConfig): string | undefined {
    if (config.webhookUrl) {
      return config.webhookUrl;
    }

    const publicUrl = readOptionalString(
      this.env.PUBLIC_URL,
      this.env.PHANTASY_PUBLIC_URL,
      this.env.WEB_BASE_URL,
    );
    if (!publicUrl) {
      return undefined;
    }

    const base = publicUrl.replace(/\/$/, "");
    return `${base}/admin/api/plugins/twilio/webhook`;
  }
}
