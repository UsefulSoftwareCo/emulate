import { Link } from "react-router-dom";
import { SERVICES } from "../services";
import { Icon } from "../App";

export default function Home() {
  return (
    <>
      <h1>Executor API Emulators</h1>
      <p className="lead">
        Stateful, Durable-Object-backed emulators of real APIs — REST, OAuth/OIDC, GraphQL, MCP. Each instance is
        isolated and seedable. Pick a service to spin one up and run its real flows.
      </p>
      <div className="grid">
        {SERVICES.map((s) => (
          <Link key={s.id} to={`/${s.id}`} className="card link">
            <div className="hd">
              <Icon s={s} size={26} />
              <h3>{s.name}</h3>
              <span className="pill">{s.auth}</span>
            </div>
            <p className="b">{s.blurb}</p>
          </Link>
        ))}
      </div>
    </>
  );
}
