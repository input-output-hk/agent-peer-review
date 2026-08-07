/** Three headline counters (repos / pulls / reviews) shown at the top of the Overview page. */

export interface StatTilesProps {
  repos: number;
  pulls: number;
  reviews: number;
}

interface Tile {
  label: string;
  value: number;
}

export function StatTiles({ repos, pulls, reviews }: StatTilesProps) {
  const tiles: Tile[] = [
    { label: "Repos", value: repos },
    { label: "Pulls", value: pulls },
    { label: "Reviews", value: reviews },
  ];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "1rem" }}>
      {tiles.map((tile) => (
        <div className="card" key={tile.label}>
          <p style={{ margin: 0, color: "var(--muted)", fontSize: "0.875rem" }}>{tile.label}</p>
          <p style={{ margin: "0.25rem 0 0", fontSize: "2rem", fontWeight: 700 }}>{tile.value}</p>
        </div>
      ))}
    </div>
  );
}
