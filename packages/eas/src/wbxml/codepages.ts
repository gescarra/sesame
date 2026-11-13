// WBXML code pages for Exchange ActiveSync 14.1, from [MS-ASWBXML] section 2.1.2.1.
// Only the pages sesame reads or writes are filled in. A token on any other page still decodes,
// as `Page<n>:0x<token>`, so an unexpected element is ignored instead of failing the request.

/** Tag names by token, starting at 0x05, for one code page. Gaps are null. */
type Tokens = readonly (string | null)[];

const page = (...names: (string | null)[]): Tokens => names;

export const CODE_PAGES: Readonly<Record<number, { name: string; tags: Tokens }>> = {
  0: {
    name: "AirSync",
    tags: page(
      "Sync", // 0x05
      "Responses",
      "Add",
      "Change",
      "Delete",
      "Fetch", // 0x0A
      "SyncKey",
      "ClientId",
      "ServerId",
      "Status",
      "Collection", // 0x0F
      "Class",
      null, // Version
      "CollectionId",
      "GetChanges",
      "MoreAvailable", // 0x14
      "WindowSize",
      "Commands",
      "Options",
      "FilterType",
      null, // 0x19 Truncation
      null, // 0x1A RTFTruncation
      "Conflict",
      "Collections",
      "ApplicationData",
      "DeletesAsMoves", // 0x1E
      null, // NotifyGUID
      "Supported", // 0x20
      "SoftDelete",
      "MIMESupport",
      "MIMETruncation",
      "Wait",
      "Limit",
      "Partial",
      "ConversationMode",
      "MaxItems",
      "HeartbeatInterval", // 0x29
    ),
  },
  2: {
    name: "Email",
    tags: page(
      null, // 0x05 Attachment
      null, // 0x06 Attachments
      null, // 0x07 AttName
      null, // 0x08 AttSize
      null, // 0x09 Att0Id
      null, // 0x0A AttMethod
      null, // 0x0B AttRemoved
      null, // 0x0C Body
      null, // 0x0D BodySize
      null, // 0x0E BodyTruncated
      "DateReceived", // 0x0F
      null, // 0x10 DisplayName
      "DisplayTo", // 0x11
      "Importance",
      "MessageClass",
      "Subject",
      "Read", // 0x15
      "To",
      "Cc",
      "From",
      "ReplyTo", // 0x19
      "AllDayEvent",
      "Categories",
      "Category",
      "DTStamp",
      "EndTime",
      "InstanceType", // 0x1F
      "BusyStatus", // 0x20
      "Location",
      "MeetingRequest",
      "Organizer",
      "RecurrenceId",
      "Reminder",
      "ResponseRequested",
      "Recurrences",
      "Recurrence",
      "Recurrence_Type",
      "Recurrence_Until",
      "Recurrence_Occurrences",
      "Recurrence_Interval",
      "Recurrence_DayOfWeek",
      "Recurrence_DayOfMonth",
      "Recurrence_WeekOfMonth", // 0x2F
      "Recurrence_MonthOfYear", // 0x30
      "StartTime",
      "Sensitivity",
      "TimeZone",
      "GlobalObjId",
      "ThreadTopic", // 0x35
      null, // 0x36 MIMEData
      null, // 0x37 MIMETruncated
      null, // 0x38 MIMESize
      "InternetCPID", // 0x39
      "Flag",
      "FlagStatus", // 0x3B, "Status" in the spec; renamed to avoid clashing with AirSync:Status
      "ContentClass",
      "FlagType",
      "CompleteTime",
      "DisallowNewTimeProposal", // 0x3F
    ),
  },
  5: {
    name: "Move",
    tags: page("MoveItems", "Move", "SrcMsgId", "SrcFldId", "DstFldId", "Response", "Status", "DstMsgId"),
  },
  6: {
    name: "GetItemEstimate",
    tags: page(
      "GetItemEstimate", // 0x05
      null, // Version
      "Collections",
      "Collection",
      null, // Class
      "CollectionId", // 0x0A
      null, // DateTime
      "Estimate",
      "Response",
      "Status", // 0x0E
    ),
  },
  7: {
    name: "FolderHierarchy",
    tags: page(
      null, // 0x05 Folders
      null, // 0x06 Folder
      "DisplayName", // 0x07
      "ServerId",
      "ParentId",
      "Type",
      null, // 0x0B Response
      "Status", // 0x0C
      null, // 0x0D ContentClass
      "Changes", // 0x0E
      "Add",
      "Delete", // 0x10
      "Update",
      "SyncKey",
      "FolderCreate",
      "FolderDelete",
      "FolderUpdate",
      "FolderSync", // 0x16
      "Count",
    ),
  },
  13: {
    name: "Ping",
    tags: page(
      "Ping", // 0x05
      null, // AutdState
      "Status",
      "HeartbeatInterval",
      "Folders",
      "Folder", // 0x0A
      "Id",
      "Class",
      "MaxFolders", // 0x0D
    ),
  },
  14: {
    name: "Provision",
    tags: page(
      "Provision", // 0x05
      "Policies",
      "Policy",
      "PolicyType",
      "PolicyKey",
      "Data", // 0x0A
      "Status",
      "RemoteWipe",
      "EASProvisionDoc",
      "DevicePasswordEnabled", // 0x0E
      "AlphanumericDevicePasswordRequired",
      "RequireStorageCardEncryption", // 0x10
      "PasswordRecoveryEnabled",
      null, // 0x12
      "AttachmentsEnabled", // 0x13
      "MinDevicePasswordLength",
      "MaxInactivityTimeDeviceLock",
      "MaxDevicePasswordFailedAttempts",
      "MaxAttachmentSize",
      "AllowSimpleDevicePassword", // 0x18
      "DevicePasswordExpiration",
      "DevicePasswordHistory",
      "AllowStorageCard",
      "AllowCamera",
      "RequireDeviceEncryption", // 0x1D
      "AllowUnsignedApplications",
      "AllowUnsignedInstallationPackages",
      "MinDevicePasswordComplexCharacters", // 0x20
      "AllowWiFi",
      "AllowTextMessaging",
      "AllowPOPIMAPEmail",
      "AllowBluetooth",
      "AllowIrDA",
      "RequireManualSyncWhenRoaming",
      "AllowDesktopSync",
      "MaxCalendarAgeFilter",
      "AllowHTMLEmail", // 0x29
      "MaxEmailAgeFilter",
      "MaxEmailBodyTruncationSize",
      "MaxEmailHTMLBodyTruncationSize",
      "RequireSignedSMIMEMessages",
      "RequireEncryptedSMIMEMessages",
      "RequireSignedSMIMEAlgorithm", // 0x2F
      "RequireEncryptionSMIMEAlgorithm", // 0x30
      "AllowSMIMEEncryptionAlgorithmNegotiation",
      "AllowSMIMESoftCerts",
      "AllowBrowser",
      "AllowConsumerEmail",
      "AllowRemoteDesktop",
      "AllowInternetSharing",
      "UnapprovedInROMApplicationList",
      "ApplicationName",
      "ApprovedApplicationList",
      "Hash", // 0x3A
    ),
  },
  17: {
    name: "AirSyncBase",
    tags: page(
      "BodyPreference", // 0x05
      "Type",
      "TruncationSize",
      "AllOrNone",
      null, // 0x09
      "Body", // 0x0A
      "Data",
      "EstimatedDataSize",
      "Truncated",
      "Attachments",
      "Attachment", // 0x0F
      "DisplayName", // 0x10
      "FileReference",
      "Method",
      "ContentId",
      "ContentLocation",
      "IsInline",
      "NativeBodyType",
      "ContentType",
      "Preview",
      "BodyPartPreference",
      "BodyPart",
      "Status", // 0x1B
    ),
  },
  18: {
    name: "Settings",
    tags: page(
      "Settings", // 0x05
      "Status",
      "Get",
      "Set",
      "Oof",
      "OofState", // 0x0A
      "StartTime",
      "EndTime",
      "OofMessage",
      "AppliesToInternal",
      "AppliesToExternalKnown", // 0x0F
      "AppliesToExternalUnknown", // 0x10
      "Enabled",
      "ReplyMessage",
      "BodyType",
      "DevicePassword",
      "Password",
      "DeviceInformation", // 0x16
      "Model",
      "IMEI",
      "FriendlyName",
      "OS", // 0x1A
      "OSLanguage",
      "PhoneNumber",
      "UserInformation",
      "EmailAddresses",
      "SMTPAddress", // 0x1F
      "UserAgent", // 0x20
      "EnableOutboundSMS",
      "MobileOperator",
      "PrimarySmtpAddress",
      "Accounts",
      "Account",
      "AccountId",
      "AccountName",
      "UserDisplayName",
      "SendDisabled", // 0x29
      null, // 0x2A
      "RightsManagementInformation", // 0x2B
    ),
  },
  20: {
    name: "ItemOperations",
    tags: page(
      "ItemOperations", // 0x05
      "Fetch",
      "Store",
      "Options",
      "Range",
      "Total", // 0x0A
      "Properties",
      "Data",
      "Status",
      "Response",
      "Version", // 0x0F
      "Schema", // 0x10
      "Part",
      "EmptyFolderContents",
      "DeleteSubFolders",
      "UserName",
      "Password",
      "Move",
      "DstFldId",
      "ConversationId",
      "MoveAlways", // 0x19
    ),
  },
  21: {
    name: "ComposeMail",
    tags: page(
      "SendMail", // 0x05
      "SmartForward",
      "SmartReply",
      "SaveInSentItems",
      "ReplaceMime",
      null, // 0x0A
      "Source",
      "FolderId",
      "ItemId",
      "LongId",
      "InstanceId", // 0x0F
      "Mime", // 0x10
      "ClientId",
      "Status",
      "AccountId", // 0x13
    ),
  },
  22: {
    name: "Email2",
    tags: page(
      "UmCallerID", // 0x05
      "UmUserNotes",
      "UmAttDuration",
      "UmAttOrder",
      "ConversationId",
      "ConversationIndex", // 0x0A
      "LastVerbExecuted",
      "LastVerbExecutionTime",
      "ReceivedAsBcc",
      "Sender",
      "CalendarType", // 0x0F
      "IsLeapMonth", // 0x10
      "AccountId",
      "FirstDayOfWeek",
      "MeetingMessageType", // 0x13
    ),
  },
};

const FIRST_TAG = 0x05;

/** "Page:Tag" -> [page, token] */
const byName = new Map<string, [number, number]>();
for (const [id, { name, tags }] of Object.entries(CODE_PAGES)) {
  tags.forEach((tag, i) => {
    if (tag) byName.set(`${name}:${tag}`, [Number(id), FIRST_TAG + i]);
  });
}

export function tokenFor(qualifiedTag: string): [page: number, token: number] {
  const found = byName.get(qualifiedTag);
  if (!found) throw new Error(`no WBXML token for ${qualifiedTag}`);
  return found;
}

export function tagFor(pageId: number, token: number): string {
  const entry = CODE_PAGES[pageId];
  const tag = entry?.tags[token - FIRST_TAG];
  if (entry && tag) return `${entry.name}:${tag}`;
  return `${entry?.name ?? `Page${pageId}`}:0x${token.toString(16).padStart(2, "0")}`;
}
