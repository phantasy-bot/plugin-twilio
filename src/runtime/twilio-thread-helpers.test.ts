import { describe, expect, it } from "vitest";

import {
  buildTwilioGatewayThreadId,
  normalizePhoneNumber,
} from "./twilio-thread-helpers";

describe("twilio-thread-helpers", () => {
  it("builds stable gateway thread ids for sms senders", () => {
    expect(buildTwilioGatewayThreadId("+15551234567")).toBe("twilio:sms:+15551234567");
  });

  it("normalizes phone numbers and rejects empty values", () => {
    expect(normalizePhoneNumber(" +15551234567 ")).toBe("+15551234567");
    expect(normalizePhoneNumber("")).toBeUndefined();
    expect(normalizePhoneNumber(null)).toBeUndefined();
  });
});
