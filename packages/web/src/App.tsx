import { isSystemFolder } from "@sesame/core/folders";
import {
  createBrowserRouter,
  Navigate,
  Outlet,
  RouterProvider,
  useParams,
  useSearchParams,
} from "react-router";
import { ApiError, api, type ListView } from "./api.ts";
import { ComposeProvider } from "./components/Compose.tsx";
import { FolderRail } from "./components/FolderRail.tsx";
import { MessageList } from "./components/MessageList.tsx";
import { Reader } from "./components/Reader.tsx";
import { useMe } from "./queries.ts";

const router = createBrowserRouter([
  {
    path: "/",
    element: <Gate />,
    children: [
      { index: true, element: <Home /> },
      { path: "m/:mbx/:view", element: <Mail /> },
      { path: "m/:mbx/:view/:id", element: <Mail /> },
      { path: "*", element: <Problem title="Page not found" /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}

/** Everything below requires a session; /api/me redirects to sign-in when there isn't one. */
function Gate() {
  const me = useMe();
  if (me.isPending) return <div className="splash">Loading…</div>;
  if (me.isError) {
    const message = me.error instanceof ApiError ? me.error.message : "The server could not be reached.";
    return <Problem title="Something went wrong" detail={message} retry={() => void me.refetch()} />;
  }
  return <Outlet />;
}

function Home() {
  const me = useMe();
  const first = me.data?.mailboxes[0];
  if (!first) {
    return (
      <Problem
        title="No mailboxes yet"
        detail={`You're signed in as ${me.data?.email}, but no mailbox is shared with this address. Ask an administrator to grant you access.`}
        action={{ label: "Sign out", run: () => void api.signOut() }}
      />
    );
  }
  return <Navigate to={`/m/${first.mailboxId}/inbox`} replace />;
}

function Mail() {
  const { mbx = "", view = "", id } = useParams();
  const [params] = useSearchParams();
  const query = params.get("q") ?? "";
  const me = useMe();
  const mailbox = me.data?.mailboxes.find((m) => m.mailboxId === mbx);
  if (!mailbox)
    return <Problem title="Mailbox not found" action={{ label: "Go to your inbox", href: "/" }} />;
  if (!isSystemFolder(view) && view !== "flagged" && view !== "search") {
    return <Navigate to={`/m/${mbx}/inbox`} replace />;
  }
  return (
    <ComposeProvider key={mbx} mailbox={mailbox}>
      <div className={id ? "mail has-reader" : "mail"}>
        <FolderRail mailbox={mailbox} mailboxes={me.data?.mailboxes ?? []} view={view as ListView} />
        <MessageList
          key={`${mbx}/${view}`}
          mailboxId={mbx}
          view={view as ListView}
          query={query}
          selectedId={id}
        />
        {id ? <Reader key={id} mailboxId={mbx} view={view as ListView} id={id} /> : <EmptyReader />}
      </div>
    </ComposeProvider>
  );
}

function EmptyReader() {
  return (
    <section className="reader reader-empty" aria-label="Message">
      <p>Select a message to read it.</p>
    </section>
  );
}

function Problem(props: {
  title: string;
  detail?: string;
  retry?: () => void;
  action?: { label: string; href?: string; run?: () => void };
}) {
  return (
    <div className="problem">
      <h1>{props.title}</h1>
      {props.detail && <p>{props.detail}</p>}
      <div className="problem-actions">
        {props.retry && (
          <button type="button" className="button primary" onClick={props.retry}>
            Try again
          </button>
        )}
        {props.action?.href && (
          <a className="button" href={props.action.href}>
            {props.action.label}
          </a>
        )}
        {props.action?.run && (
          <button type="button" className="button" onClick={props.action.run}>
            {props.action.label}
          </button>
        )}
      </div>
    </div>
  );
}
