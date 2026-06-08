import { Link, NavLink, Route, Routes } from "react-router-dom";
import { SERVICES, type Svc } from "./services";
import Home from "./views/Home";
import Spotify from "./views/Spotify";
import Vercel from "./views/Vercel";
import Mcp from "./views/Mcp";
import Service from "./views/Service";

export function Icon({ s, size = 16 }: { s: Svc; size?: number }) {
  return s.icon.startsWith("http") ? (
    <img src={s.icon} alt="" style={{ width: size, height: size }} />
  ) : (
    <span style={{ fontSize: size, lineHeight: `${size}px` }}>{s.icon}</span>
  );
}

export default function App() {
  return (
    <>
      <div className="topbar">
        <div className="shell">
          <div className="row">
            <Link to="/" className="brand">
              <span className="dot" /> Executor Emulators
            </Link>
            <nav className="nav">
              {SERVICES.map((s) => (
                <NavLink key={s.id} to={`/${s.id}`} className={({ isActive }) => (isActive ? "on" : "")}>
                  <Icon s={s} /> {s.name}
                </NavLink>
              ))}
            </nav>
          </div>
        </div>
      </div>
      <div className="shell content">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/spotify" element={<Spotify />} />
          <Route path="/vercel" element={<Vercel />} />
          <Route path="/mcp" element={<Mcp />} />
          <Route path="/:service" element={<Service />} />
        </Routes>
      </div>
    </>
  );
}
