import { base, controlBase, randomInstance } from "../api";

const copy = (t: string) => navigator.clipboard?.writeText(t);

export default function InstanceBar(props: {
  service: string;
  instance: string;
  pinned?: boolean;
  onChange: (v: string) => void;
}) {
  const url = base(props.service, props.instance);
  const control = controlBase(props.service, props.instance);
  return (
    <div className="panel">
      <div className="row">
        <span className="muted">instance</span>
        <input
          className="mono"
          style={{ flex: 1, minWidth: 200 }}
          value={props.instance}
          readOnly={props.pinned}
          onChange={(e) => props.onChange(e.target.value)}
        />
        {!props.pinned && (
          <button className="sm" onClick={() => props.onChange(randomInstance())}>
            new instance
          </button>
        )}
        <button className="sm copy" onClick={() => copy(url)}>
          copy base URL
        </button>
      </div>
      {props.pinned && (
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          This instance is fixed by the host. Use a different <code>instance</code> subdomain to switch.
        </div>
      )}
      <div className="kv" style={{ marginTop: 8 }}>
        <b>provider</b>{" "}
        <a href={url} target="_blank" rel="noopener">
          {url}
        </a>
      </div>
      <div className="kv" style={{ marginTop: 5 }}>
        <b>control</b>{" "}
        <a href={control} target="_blank" rel="noopener">
          {control}
        </a>
      </div>
    </div>
  );
}
