/** Landing page: fetches `/api/overview` and renders totals, distributions, activity, and sync status. */
import { useEffect, useState } from "react";
import { getOverview } from "../api";
import type { Overview as OverviewData } from "../types";
import { verdictLabel } from "../format";
import { StatTiles } from "../components/StatTiles";
import { BarList } from "../components/BarList";
import { ActivityChart } from "../components/ActivityChart";
import { LastSync } from "../components/LastSync";

type OverviewState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: OverviewData };

export function Overview() {
  const [state, setState] = useState<OverviewState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    getOverview()
      .then((data) => {
        if (!cancelled) setState({ status: "ready", data });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : "Failed to load the overview.";
          setState({ status: "error", message });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading") {
    return <p>Loading overview...</p>;
  }

  if (state.status === "error") {
    return (
      <div className="card" role="alert">
        <p style={{ margin: 0 }}>Failed to load the overview: {state.message}</p>
      </div>
    );
  }

  const { data } = state;
  const verdictData = data.verdicts.map((v) => ({ label: verdictLabel(v.verdict), count: v.count }));
  const modelData = data.models.map((m) => ({ label: m.model, count: m.count }));

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <h2>Overview</h2>
      <StatTiles repos={data.totals.repos} pulls={data.totals.pulls} reviews={data.totals.reviews} />
      <BarList title="Verdicts" data={verdictData} />
      <BarList title="Models" data={modelData} />
      <ActivityChart data={data.activity} />
      <LastSync lastSync={data.lastSync} />
    </section>
  );
}
