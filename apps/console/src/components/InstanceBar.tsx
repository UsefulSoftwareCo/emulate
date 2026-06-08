import { base } from "../api";

export default function InstanceBar(props: {
  service: string;
  instance: string;
  onChange: (v: string) => void;
  onRegenerate: () => void;
}) {
  const url = base(props.service, props.instance);
  return (
    <div className="panel">
      <div className="row">
        <span className="muted">instance</span>
        <input
          className="mono"
          style={{ flex: 1, minWidth: 200 }}
          value={props.instance}
          onChange={(e) => props.onChange(e.target.value)}
        />
        <button className="sm" onClick={props.onRegenerate}>regenerate</button>
        <button className="sm copy" onClick={() => navigator.clipboard?.writeText(url)}>copy base URL</button>
      </div>
      <div className="kv" style={{ marginTop: 8 }}>
        <b>base</b> {url}
      </div>
    </div>
  );
}
