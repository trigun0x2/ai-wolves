import { useEffect, useState } from "react";
import { Dashboard } from "./Dashboard";
import { PlaySeat } from "./PlaySeat";

export function App() {
  const [route, setRoute] = useState(location.hash);
  useEffect(() => {
    const onHash = () => setRoute(location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route.startsWith("#/play") ? <PlaySeat /> : <Dashboard />;
}
