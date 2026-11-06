import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { OutboundDelivery } from "@sesame/core";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { type Deps, eventEffect, handleEvent, type SesEvent } from "./events.ts";

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
const ddbMock = mockClient(doc);
const NOW = "2026-10-28T12:00:00.000Z";
const deps: Deps = {
  doc,
  mailTable: "mail",
  directoryTable: "dir",
  now: () => Date.parse(NOW),
  log: () => {},
};

const mail = {
  messageId: "ses-1",
  destination: ["x@ext.test", "Y@Ext.test"],
  timestamp: "2026-10-28T11:59:00Z",
};

describe("eventEffect", () => {
  it("maps each event type to recipient statuses", () => {
    expect(eventEffect({ eventType: "Send", mail }, NOW)?.updates).toEqual({
      "x@ext.test": { status: "sent", at: mail.timestamp },
      "y@ext.test": { status: "sent", at: mail.timestamp },
    });
    expect(
      eventEffect(
        {
          eventType: "Delivery",
          mail,
          delivery: { recipients: ["x@ext.test"], timestamp: "t", smtpResponse: "250 ok" },
        },
        NOW,
      )?.updates,
    ).toEqual({ "x@ext.test": { status: "delivered", detail: "250 ok", at: "t" } });
    expect(
      eventEffect({ eventType: "Reject", mail, reject: { reason: "Bad content" } }, NOW)?.updates[
        "x@ext.test"
      ],
    ).toEqual({
      status: "rejected",
      detail: "Bad content",
      at: NOW,
    });
    expect(eventEffect({ eventType: "Open", mail }, NOW)).toBeNull();
  });

  it("suppresses hard bounces and complaints, not soft bounces", () => {
    const hard: SesEvent = {
      eventType: "Bounce",
      mail,
      bounce: {
        bounceType: "Permanent",
        bounceSubType: "General",
        bouncedRecipients: [{ emailAddress: "X@ext.test", diagnosticCode: "550 no such user" }],
      },
    };
    expect(eventEffect(hard, NOW)).toMatchObject({
      updates: { "x@ext.test": { status: "bounced", detail: "550 no such user" } },
      suppressions: [{ address: "x@ext.test", reason: "bounce", detail: "550 no such user" }],
    });
    const soft: SesEvent = {
      ...hard,
      bounce: { bounceType: "Transient", bouncedRecipients: [{ emailAddress: "x@ext.test" }] },
    };
    expect(eventEffect(soft, NOW)).toMatchObject({
      updates: { "x@ext.test": { status: "bounced", detail: "Transient" } },
      suppressions: [],
    });
    const complaint: SesEvent = {
      eventType: "Complaint",
      mail,
      complaint: { complainedRecipients: [{ emailAddress: "y@ext.test" }] },
    };
    expect(eventEffect(complaint, NOW)?.suppressions).toEqual([
      { address: "y@ext.test", reason: "complaint" },
    ]);
  });
});

describe("handleEvent", () => {
  let delivery: OutboundDelivery;

  beforeEach(() => {
    ddbMock.reset();
    delivery = {
      status: "sent",
      recipients: {
        "x@ext.test": { status: "delivered", at: "t1" },
        "y@ext.test": { status: "sent", at: "t1" },
      },
      sesMessageId: "ses-1",
      updatedAt: "t1",
    };
    ddbMock
      .on(GetCommand)
      .callsFake((input) =>
        input.Key.pk === "SES#ses-1"
          ? { Item: { pk: "SES#ses-1", mailboxId: "M", sentUlid: "S" } }
          : { Item: { pk: "MBX#M", delivery } },
      );
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});
  });

  const written = () =>
    ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input.ExpressionAttributeValues?.[
      ":next"
    ] as OutboundDelivery;

  it("records a bounce, suppresses the address and keeps other recipients", async () => {
    const event: SesEvent = {
      eventType: "Bounce",
      mail,
      bounce: {
        bounceType: "Permanent",
        bouncedRecipients: [{ emailAddress: "y@ext.test", diagnosticCode: "550" }],
      },
    };
    expect(await handleEvent(deps, JSON.stringify(event))).toBe("applied");
    expect(written()).toMatchObject({
      status: "bounced",
      sesMessageId: "ses-1",
      recipients: {
        "x@ext.test": { status: "delivered" },
        "y@ext.test": { status: "bounced", detail: "550" },
      },
    });
    expect(ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input.ConditionExpression).toContain(
      "delivery.updatedAt = :prev",
    );
    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input).toMatchObject({
      TableName: "dir",
      Item: { pk: "SUPPRESS#y@ext.test", reason: "bounce", detail: "550" },
    });
  });

  it("doesn't let a late Send event undo a delivery", async () => {
    await handleEvent(deps, JSON.stringify({ eventType: "Send", mail }));
    expect(written().recipients["x@ext.test"]?.status).toBe("delivered");
    expect(written().recipients["y@ext.test"]?.status).toBe("sent");
  });

  it("retries when the message isn't mapped yet", async () => {
    ddbMock.on(GetCommand).resolves({});
    await expect(
      handleEvent(
        deps,
        JSON.stringify({ eventType: "Delivery", mail, delivery: { recipients: ["x@ext.test"] } }),
      ),
    ).rejects.toThrow("no Sent copy recorded");
  });

  it("drops events for a mailbox that was deleted", async () => {
    ddbMock
      .on(GetCommand)
      .callsFake((input) =>
        input.Key.pk === "SES#ses-1" ? { Item: { pk: "SES#ses-1", mailboxId: "M", sentUlid: "S" } } : {},
      );
    const event = JSON.stringify({ eventType: "Delivery", mail, delivery: { recipients: ["x@ext.test"] } });
    expect(await handleEvent(deps, event)).toBe("ignored");

    // While the mailbox exists, a missing Sent copy just isn't filed yet: retry.
    ddbMock
      .on(GetCommand)
      .callsFake((input) =>
        input.Key.pk === "SES#ses-1"
          ? { Item: { pk: "SES#ses-1", mailboxId: "M", sentUlid: "S" } }
          : input.TableName === "dir"
            ? { Item: { pk: "MBX#M" } }
            : {},
      );
    await expect(handleEvent(deps, event)).rejects.toThrow("not found");
  });

  it("ignores events sesame doesn't track", async () => {
    expect(await handleEvent(deps, JSON.stringify({ eventType: "Click", mail }))).toBe("ignored");
  });
});
