import { useState } from "react";
import { Link, Route, Routes } from "react-router-dom";
import { hostRoute } from "./api";
import Home from "./views/Home";
import Service from "./views/Service";

export function Monogram({ name, size = 26 }: { name: string; size?: number }) {
  const letter = (name || "?").trim().charAt(0).toUpperCase();
  return (
    <span
      className="mono-badge"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5), lineHeight: `${size}px` }}
    >
      {letter}
    </span>
  );
}

// The real provider brand icon (served by the worker at /_emulate/icons/<id>),
// falling back to a monogram if the icon is missing or fails to load.
export function ServiceIcon({ src, name, size = 26 }: { src?: string; name: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <Monogram name={name} size={size} />;
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      style={{ objectFit: "contain", display: "block" }}
      onError={() => setFailed(true)}
    />
  );
}

export default function App() {
  const route = hostRoute();

  return (
    <>
      <div className="topbar">
        <div className="shell">
          <div className="row">
            <Link to="/" className="brand">
              emulate
            </Link>
            <nav className="nav">{route.service && <a href="https://emulators.dev">All emulators</a>}</nav>
          </div>
        </div>
      </div>
      <div className="shell content">
        <Routes>
          <Route
            path="/"
            element={
              route.service ? <Service serviceOverride={route.service} instanceOverride={route.instance} /> : <Home />
            }
          />
          <Route path="/:service" element={<Service />} />
        </Routes>
      </div>
    </>
  );
}
