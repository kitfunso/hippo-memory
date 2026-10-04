import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-600.css";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./tokens.css";
import "./views/Health/health.css";

createRoot(document.getElementById("root")!).render(<App />);
