import { useEffect, useState } from "react";
import { Dashboard } from "./Dashboard";
import { PlaySeat } from "./PlaySeat";
import { BringPlayer } from "./BringPlayer";

export function App() {
  const [route, setRoute] = useState(location.hash);
  useEffect(() => {
    const onHash = () => setRoute(location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  if (route.startsWith("#/play")) return <PlaySeat />;
  if (route.startsWith("#/bring")) return <BringPlayer />;
  return <Dashboard />;
}
