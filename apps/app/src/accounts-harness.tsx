// Dev-only, served by Vite and absent from its production entry points.
import { createRoot } from "react-dom/client";
import { Accounts } from "./accounts";
import { accountFixtures } from "./accounts.fixtures";
import { Page } from "./settings-layout";
import "./styles.css";

document.documentElement.classList.toggle(
  "dark",
  new URLSearchParams(location.search).get("theme") === "dark",
);

createRoot(document.getElementById("root")!).render(
  <main className="mx-auto h-full max-w-2xl overflow-auto p-8 text-foreground">
    <Page>
      {Object.entries(accountFixtures).map(([state, accounts]) => (
        <div
          key={state}
          data-state={state}
          className="@container rounded-xl border border-border bg-background p-5"
        >
          <h2 className="mb-5 text-sm text-muted-foreground">{state}</h2>
          <Accounts accounts={accounts} />
        </div>
      ))}
      <div data-state="loading">
        <Accounts accounts={undefined} loading />
      </div>
      <div data-state="empty">
        <Accounts accounts={[]} />
      </div>
    </Page>
  </main>,
);
