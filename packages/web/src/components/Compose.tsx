import type { MailboxAccess, SendRequest } from "@sesame/core/dto";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { ApiError, api } from "../api.ts";
import { type Draft, emptyDraft, parseAddressList } from "../compose.ts";
import { formatSize } from "../format.ts";
import { keys } from "../queries.ts";
import { Icon } from "./Icon.tsx";

interface ComposeApi {
  open: (draft?: Draft) => void;
}

const ComposeContext = createContext<ComposeApi>({ open: () => {} });

export const useCompose = () => useContext(ComposeContext);

/** Holds the one open draft for a mailbox, and the "sent" notice after it goes. */
export function ComposeProvider(props: { mailbox: MailboxAccess; children: ReactNode }) {
  const [draft, setDraft] = useState<Draft | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const client = useQueryClient();
  const { mailboxId } = props.mailbox;

  const openDraft = useRef(draft);
  openDraft.current = draft;
  const open = useCallback((next?: Draft) => {
    if (openDraft.current && !confirm("Discard the message you're writing?")) return;
    setDraft(next ?? emptyDraft());
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(undefined), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  const onSent = (summary: string) => {
    setDraft(undefined);
    setNotice(summary);
    // Ingest files the Sent copy a moment later; refresh now and again shortly.
    const refresh = () => {
      void client.invalidateQueries({ queryKey: keys.folders(mailboxId) });
      void client.invalidateQueries({ queryKey: keys.messages(mailboxId) });
      void client.invalidateQueries({ queryKey: ["thread", mailboxId] });
      void client.invalidateQueries({ queryKey: keys.me });
    };
    refresh();
    setTimeout(refresh, 2000);
    setTimeout(refresh, 8000);
  };

  return (
    <ComposeContext.Provider value={{ open }}>
      {props.children}
      {draft && (
        <ComposePanel
          key={`${draft.mode}:${draft.inReplyTo ?? draft.forward?.id ?? ""}`}
          mailbox={props.mailbox}
          initial={draft}
          onClose={() => setDraft(undefined)}
          onSent={onSent}
        />
      )}
      {notice && (
        <div className="toast" role="status">
          {notice}
        </div>
      )}
    </ComposeContext.Provider>
  );
}

interface Upload {
  key: string;
  file: File;
  progress: number;
  uploadId?: string;
  error?: string;
  abort: AbortController;
}

function ComposePanel(props: {
  mailbox: MailboxAccess;
  initial: Draft;
  onClose: () => void;
  onSent: (summary: string) => void;
}) {
  const { mailbox, initial } = props;
  const [draft, setDraft] = useState(initial);
  const [showCopies, setShowCopies] = useState(Boolean(initial.cc || initial.bcc));
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [forwardParts, setForwardParts] = useState(new Set(initial.forward?.parts.map((p) => p.partId)));
  const [error, setError] = useState<string | undefined>();
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const firstField = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLTextAreaElement>(null);
  const id = useId();

  // Replies start in the body; new messages and forwards start at "To".
  useEffect(() => {
    if (initial.mode === "reply" || initial.mode === "replyAll") {
      body.current?.focus();
      body.current?.setSelectionRange(0, 0);
    } else {
      firstField.current?.focus();
    }
  }, [initial.mode]);

  // Cancel uploads still running when the panel goes away.
  const uploadsRef = useRef(uploads);
  uploadsRef.current = uploads;
  useEffect(
    () => () => {
      for (const u of uploadsRef.current) u.abort.abort();
    },
    [],
  );

  const dirty =
    uploads.length > 0 ||
    (["to", "cc", "bcc", "subject", "text"] as const).some((k) => draft[k] !== initial[k]);

  const close = () => {
    if (!dirty || confirm("Discard this message?")) props.onClose();
  };

  const set = (field: keyof Draft) => (e: { target: { value: string } }) =>
    setDraft((d) => ({ ...d, [field]: e.target.value }));

  const addFiles = (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      const upload: Upload = { key: crypto.randomUUID(), file, progress: 0, abort: new AbortController() };
      setUploads((list) => [...list, upload]);
      const patch = (p: Partial<Upload>) =>
        setUploads((list) => list.map((u) => (u.key === upload.key ? { ...u, ...p } : u)));
      api
        .upload(file, (progress) => patch({ progress }), upload.abort.signal)
        .then((uploadId) => patch({ uploadId, progress: 1 }))
        .catch((err: unknown) => patch({ error: err instanceof Error ? err.message : "upload failed" }));
    }
  };

  const removeUpload = (key: string) =>
    setUploads((list) => {
      list.find((u) => u.key === key)?.abort.abort();
      return list.filter((u) => u.key !== key);
    });

  const send = async () => {
    setError(undefined);
    const to = parseAddressList(draft.to);
    const cc = parseAddressList(draft.cc);
    const bcc = parseAddressList(draft.bcc);
    const invalid = [...to.invalid, ...cc.invalid, ...bcc.invalid];
    if (invalid.length) return setError(`Check these addresses: ${invalid.join(", ")}`);
    if (to.addresses.length + cc.addresses.length + bcc.addresses.length === 0) {
      return setError("Add at least one recipient.");
    }
    if (uploads.some((u) => !u.uploadId && !u.error))
      return setError("Wait for attachments to finish uploading.");
    if (uploads.some((u) => u.error)) return setError("Remove the attachments that failed to upload.");
    if (!draft.subject.trim() && !confirm("Send without a subject?")) return;

    const request: SendRequest = {
      to: to.addresses,
      cc: cc.addresses,
      bcc: bcc.addresses,
      subject: draft.subject.trim(),
      text: draft.text,
      attachments: uploads.map((u) => ({
        uploadId: u.uploadId ?? "",
        filename: u.file.name,
        contentType: u.file.type || "application/octet-stream",
      })),
    };
    if (draft.inReplyTo) request.inReplyTo = draft.inReplyTo;
    if (draft.forward) request.forward = { id: draft.forward.id, partIds: [...forwardParts] };

    setSending(true);
    try {
      const result = await api.send(mailbox.mailboxId, request);
      const total = result.internal + result.external;
      props.onSent(total === 1 ? "Message sent." : `Message sent to ${total} recipients.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't send. Check your connection and try again.");
      setSending(false);
    }
  };

  const title = { new: "New message", reply: "Reply", replyAll: "Reply all", forward: "Forward" }[draft.mode];

  return (
    <section
      className="compose"
      role="dialog"
      aria-labelledby={`${id}-title`}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void send();
        } else if (e.key === "Escape") {
          close();
        }
      }}
    >
      <header className="compose-header">
        <h2 id={`${id}-title`}>{title}</h2>
        <button type="button" className="icon-button" aria-label="Close" onClick={close}>
          <Icon name="close" />
        </button>
      </header>

      <form
        className="compose-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <div className="field">
          <span className="field-label">From</span>
          <span className="field-static">
            {mailbox.displayName ? `${mailbox.displayName} <${mailbox.address}>` : mailbox.address}
          </span>
        </div>
        <label className="field">
          <span className="field-label">To</span>
          <input
            ref={firstField}
            value={draft.to}
            onChange={set("to")}
            autoComplete="email"
            spellCheck={false}
          />
          {!showCopies && (
            <button type="button" className="link-button" onClick={() => setShowCopies(true)}>
              Cc/Bcc
            </button>
          )}
        </label>
        {showCopies && (
          <>
            <label className="field">
              <span className="field-label">Cc</span>
              <input value={draft.cc} onChange={set("cc")} autoComplete="email" spellCheck={false} />
            </label>
            <label className="field">
              <span className="field-label">Bcc</span>
              <input value={draft.bcc} onChange={set("bcc")} autoComplete="email" spellCheck={false} />
            </label>
          </>
        )}
        <label className="field">
          <span className="field-label">Subject</span>
          <input value={draft.subject} onChange={set("subject")} />
        </label>

        <textarea
          ref={body}
          className="compose-body"
          aria-label="Message"
          value={draft.text}
          onChange={set("text")}
        />

        {(uploads.length > 0 || (draft.forward?.parts.length ?? 0) > 0) && (
          <ul className="compose-attachments">
            {draft.forward?.parts.map((p) => (
              <li key={`fwd-${p.partId}`}>
                <label>
                  <input
                    type="checkbox"
                    checked={forwardParts.has(p.partId)}
                    onChange={(e) =>
                      setForwardParts((s) => {
                        const next = new Set(s);
                        if (e.target.checked) next.add(p.partId);
                        else next.delete(p.partId);
                        return next;
                      })
                    }
                  />
                  <Icon name="paperclip" />
                  <span className="attachment-name">{p.filename}</span>
                  <span className="muted">{formatSize(p.size)}</span>
                </label>
              </li>
            ))}
            {uploads.map((u) => (
              <li key={u.key} className={u.error ? "failed" : ""}>
                <Icon name="paperclip" />
                <span className="attachment-name">{u.file.name}</span>
                <span className="muted">
                  {u.error ?? (u.uploadId ? formatSize(u.file.size) : `${Math.round(u.progress * 100)}%`)}
                </span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove ${u.file.name}`}
                  onClick={() => removeUpload(u.key)}
                >
                  <Icon name="close" />
                </button>
              </li>
            ))}
          </ul>
        )}

        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}

        <footer className="compose-footer">
          <button type="submit" className="button primary" disabled={sending}>
            {sending ? "Sending…" : "Send"}
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Attach files"
            title="Attach files"
            onClick={() => fileInput.current?.click()}
          >
            <Icon name="paperclip" />
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <span className="muted compose-hint desktop-only">Ctrl/⌘ + Enter to send</span>
          <button type="button" className="link-button compose-discard" onClick={close}>
            Discard
          </button>
        </footer>
      </form>
    </section>
  );
}
