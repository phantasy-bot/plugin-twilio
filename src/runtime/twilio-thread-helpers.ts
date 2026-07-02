export function buildTwilioGatewayThreadId(senderPhone: string): string {
  return `twilio:sms:${senderPhone}`;
}

export function normalizePhoneNumber(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
