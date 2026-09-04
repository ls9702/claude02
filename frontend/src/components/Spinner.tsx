export function Spinner({ label = "불러오는 중…" }: { label?: string }) {
  return (
    <div className="centered-page">
      <div className="spinner" aria-hidden="true" />
      <p className="muted">{label}</p>
    </div>
  );
}
